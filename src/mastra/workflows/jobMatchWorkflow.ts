import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { jobMatchAgent } from "../agents/jobMatchAgent";
import { initDatabase, query } from "../tools/db";
import { sendEmail } from "../tools/gmailClient";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "../tools/paths";

const fetchAndParseStep = createStep({
  id: "fetch-and-parse-emails",
  description:
    "Fetches job alert emails from Gmail and uses the agent to parse individual job postings from them",
  inputSchema: z.object({}) as any,
  outputSchema: z.object({
    newJobIds: z.array(z.number()),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
    runId: z.string(),
  }),
  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🚀 [Step 1] Starting email fetch and parse");

    await initDatabase();
    logger?.info("✅ [Step 1] Database initialized");

    const runId = `run-${Date.now()}`;
    await query(
      "INSERT INTO runs (run_id, start_ts, status) VALUES ($1, NOW(), $2)",
      [runId, "running"],
    );

    const USE_FIXTURES = process.env.USE_FIXTURES === "true";
    let emailsData: any[];

    if (USE_FIXTURES) {
      logger?.info("📧 [Step 1] Loading fixture emails");
      const fixturesDir = workspacePath("fixtures/emails");
      const files = fs
        .readdirSync(fixturesDir)
        .filter((f) => f.endsWith(".json"));
      emailsData = files.map((f) =>
        JSON.parse(fs.readFileSync(path.join(fixturesDir, f), "utf-8")),
      );
    } else {
      logger?.info("📧 [Step 1] Fetching from Gmail");
      const { fetchEmailsFromLabel } = await import("../tools/gmailClient");
      emailsData = await fetchEmailsFromLabel("JOB_ALERTS", 20);
    }

    if (emailsData.length === 0) {
      logger?.info("📧 [Step 1] No emails found");
      return {
        newJobIds: [],
        totalEmails: 0,
        totalParsed: 0,
        duplicateCount: 0,
        runId,
      };
    }

    logger?.info(
      `📧 [Step 1] Found ${emailsData.length} emails, parsing with agent...`,
    );

    const allEmailBodies = emailsData
      .map(
        (e: any, i: number) =>
          `--- EMAIL ${i + 1} (ID: ${e.id}) ---\nSubject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\n\n${e.body}\n--- END EMAIL ${i + 1} ---`,
      )
      .join("\n\n");

    const parseResponse = await jobMatchAgent.generateLegacy(
      [
        {
          role: "user",
          content: `Parse the following job alert emails and extract EACH individual job posting. For each job found, call the parse-jobs tool with a JSON array of all jobs.

Each job object should have: company, title, location, posting_url (if found), jd_text (the full job description text), compensation (if mentioned), source (email sender), source_message_id (email ID).

Here are the emails:

${allEmailBodies}`,
        },
      ],
      { maxSteps: 5 },
    );

    const allToolResults = parseResponse.steps?.flatMap(
      (s: any) => s.toolResults || [],
    ) || [];
    logger?.info(`🔍 [Step 1] Tool results count: ${allToolResults.length}`);

    const allResults = allToolResults.map((r: any) => r.result || r);
    const parseResult = allResults.find((r: any) => r.newJobIds);

    const newJobIds = parseResult?.newJobIds || [];
    const duplicateCount = parseResult?.duplicateCount || 0;
    const totalParsed = parseResult?.totalParsed || 0;

    logger?.info(
      `✅ [Step 1] Parsed ${totalParsed} jobs, ${newJobIds.length} new, ${duplicateCount} duplicates`,
    );

    return {
      newJobIds,
      totalEmails: emailsData.length,
      totalParsed,
      duplicateCount,
      runId,
    };
  },
});

const scoreAndShortlistStep = createStep({
  id: "score-and-shortlist",
  description: "Scores all new jobs and selects the top 10 for packet generation",
  inputSchema: z.object({
    newJobIds: z.array(z.number()),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
    runId: z.string(),
  }),
  outputSchema: z.object({
    shortlistedJobs: z.array(
      z.object({
        job_id: z.number(),
        company: z.string(),
        title: z.string(),
        location: z.string(),
        remote_hybrid: z.string(),
        posting_url: z.string(),
        total_score: z.number(),
        breakdown: z.record(z.number()),
        jd_raw_text: z.string(),
      }),
    ),
    runId: z.string(),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `📊 [Step 2] Scoring ${inputData.newJobIds.length} new jobs`,
    );

    if (inputData.newJobIds.length === 0) {
      logger?.info("📊 [Step 2] No new jobs to score");
      return {
        shortlistedJobs: [],
        runId: inputData.runId,
        totalEmails: inputData.totalEmails,
        totalParsed: inputData.totalParsed,
        duplicateCount: inputData.duplicateCount,
      };
    }

    const scoreResponse = await jobMatchAgent.generateLegacy(
      [
        {
          role: "user",
          content: `Score the following job IDs against my experience inventory and return the top 10: [${inputData.newJobIds.join(", ")}]. Call the score-jobs tool with these job IDs.`,
        },
      ],
      { maxSteps: 3 },
    );

    const allToolResults = scoreResponse.steps?.flatMap(
      (s: any) => s.toolResults || [],
    ) || [];
    const allResults = allToolResults.map((r: any) => r.result || r);
    const scoreResult = allResults.find((r: any) => r.scoredJobs);

    const shortlistedJobs = scoreResult?.scoredJobs || [];

    logger?.info(
      `✅ [Step 2] Shortlisted ${shortlistedJobs.length} jobs`,
    );

    return {
      shortlistedJobs,
      runId: inputData.runId,
      totalEmails: inputData.totalEmails,
      totalParsed: inputData.totalParsed,
      duplicateCount: inputData.duplicateCount,
    };
  },
});

const generatePacketsStep = createStep({
  id: "generate-packets",
  description:
    "For each shortlisted job, generates tailored resume, cover letter, evidence map, and verification report using the agent, then builds output folders",
  inputSchema: z.object({
    shortlistedJobs: z.array(
      z.object({
        job_id: z.number(),
        company: z.string(),
        title: z.string(),
        location: z.string(),
        remote_hybrid: z.string(),
        posting_url: z.string(),
        total_score: z.number(),
        breakdown: z.record(z.string(), z.number()),
        jd_raw_text: z.string(),
      }),
    ),
    runId: z.string(),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        job_id: z.number(),
        company: z.string(),
        title: z.string(),
        total_score: z.number(),
        truthPass: z.boolean(),
        outputDir: z.string(),
        error: z.string().optional(),
      }),
    ),
    runId: z.string(),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `🏗️ [Step 3] Generating packets for ${inputData.shortlistedJobs.length} jobs`,
    );

    const results: any[] = [];

    for (const job of inputData.shortlistedJobs) {
      try {
        logger?.info(
          `📦 [Step 3] Processing: ${job.company} - ${job.title} (Score: ${job.total_score})`,
        );

        const inventoryPath = workspacePath("experience_inventory.json");
        const inventoryText = fs.readFileSync(inventoryPath, "utf-8");

        const generateResponse = await jobMatchAgent.generateLegacy(
          [
            {
              role: "user",
              content: `Generate a complete application packet for this job. You MUST follow these steps in order:

1. Call the generate-resume tool with a tailored resume for this job
2. Call the generate-cover-letter tool with a tailored cover letter (250-350 words)
3. Call the verify-truth tool to verify all claims
4. Call the build-output tool to create the output folder with all files

IMPORTANT: Include contact discovery targets (3-10 recommended titles to search for at this company, since we cannot scrape LinkedIn).

## JOB DETAILS
Company: ${job.company}
Title: ${job.title}
Location: ${job.location} (${job.remote_hybrid})
Score: ${job.total_score}/100
Score Breakdown: ${JSON.stringify(job.breakdown)}
Posting URL: ${job.posting_url}

## JOB DESCRIPTION
${job.jd_raw_text}

## EXPERIENCE INVENTORY (SOURCE OF TRUTH)
${inventoryText}

Remember:
- ONLY use facts from the inventory
- Every claim needs an evidence mapping
- Resume: 1-2 pages, ATS-friendly, no tables
- Cover letter: 250-350 words
- After generating, verify truth, then build output`,
            },
          ],
          { maxSteps: 10 },
        );

        const allToolResults = generateResponse.steps?.flatMap(
          (s: any) => s.toolResults || [],
        ) || [];
        const allResults = allToolResults.map((r: any) => r.result || r);

        const buildResult = allResults.find(
          (r: any) => r.outputDir,
        );
        const verifyResult = allResults.find(
          (r: any) => r.overallPass !== undefined,
        );

        results.push({
          job_id: job.job_id,
          company: job.company,
          title: job.title,
          total_score: job.total_score,
          truthPass: verifyResult?.overallPass ?? buildResult?.truthPass ?? false,
          outputDir: buildResult?.outputDir || "",
        });

        logger?.info(
          `✅ [Step 3] Packet complete for ${job.company} - ${job.title}`,
        );
      } catch (err) {
        logger?.error(
          `❌ [Step 3] Failed for ${job.company} - ${job.title}: ${err}`,
        );
        results.push({
          job_id: job.job_id,
          company: job.company,
          title: job.title,
          total_score: job.total_score,
          truthPass: false,
          outputDir: "",
          error: String(err),
        });
      }
    }

    logger?.info(
      `✅ [Step 3] All packets generated: ${results.filter((r) => r.truthPass).length}/${results.length} passed truth check`,
    );

    return {
      results,
      runId: inputData.runId,
      totalEmails: inputData.totalEmails,
      totalParsed: inputData.totalParsed,
      duplicateCount: inputData.duplicateCount,
    };
  },
});

const sendDigestStep = createStep({
  id: "send-digest",
  description:
    "Sends a daily digest email summarizing the top jobs, packet statuses, and outreach targets",
  inputSchema: z.object({
    results: z.array(
      z.object({
        job_id: z.number(),
        company: z.string(),
        title: z.string(),
        total_score: z.number(),
        truthPass: z.boolean(),
        outputDir: z.string(),
        error: z.string().optional(),
      }),
    ),
    runId: z.string(),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
  }),
  outputSchema: z.object({
    digestSent: z.boolean(),
    summary: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📨 [Step 4] Building and sending daily digest");

    const today = new Date().toISOString().split("T")[0];
    const passed = inputData.results.filter((r) => r.truthPass);
    const failed = inputData.results.filter((r) => !r.truthPass && !r.error);
    const errors = inputData.results.filter((r) => r.error);

    let html = `<h1>Daily Job Brief — ${today}</h1>`;
    html += `<p><strong>Run ID:</strong> ${inputData.runId}</p>`;
    html += `<p><strong>Emails processed:</strong> ${inputData.totalEmails} | <strong>Jobs parsed:</strong> ${inputData.totalParsed} | <strong>Duplicates skipped:</strong> ${inputData.duplicateCount}</p>`;
    html += `<p><strong>Packets generated:</strong> ${passed.length} passed | ${failed.length} failed truth check | ${errors.length} errors</p>`;
    html += `<hr>`;

    if (passed.length > 0) {
      html += `<h2>Top Matches (Packets Ready)</h2>`;
      html += `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">`;
      html += `<tr><th>Score</th><th>Company</th><th>Role</th><th>Packet</th></tr>`;
      for (const r of passed) {
        html += `<tr>`;
        html += `<td><strong>${r.total_score}/100</strong></td>`;
        html += `<td>${r.company}</td>`;
        html += `<td>${r.title}</td>`;
        html += `<td>${r.outputDir || "See output folder"}</td>`;
        html += `</tr>`;
      }
      html += `</table>`;
    }

    if (failed.length > 0) {
      html += `<h2>Blocked Jobs (Verifier Failures)</h2>`;
      for (const r of failed) {
        html += `<p>❌ ${r.company} — ${r.title} (Score: ${r.total_score})</p>`;
      }
    }

    if (errors.length > 0) {
      html += `<h2>Errors</h2>`;
      for (const r of errors) {
        html += `<p>⚠️ ${r.company} — ${r.title}: ${r.error}</p>`;
      }
    }

    html += `<hr><p><em>Generated by Job Match Automation at ${new Date().toISOString()}</em></p>`;

    const digestRecipient =
      process.env.DIGEST_EMAIL || process.env.USER_EMAIL || "";

    if (digestRecipient && process.env.USE_FIXTURES !== "true") {
      try {
        await sendEmail(
          digestRecipient,
          `Daily Job Brief — ${today} (Top ${passed.length} + Packets)`,
          html,
        );
        logger?.info(`📨 [Step 4] Digest email sent to ${digestRecipient}`);
      } catch (err) {
        logger?.error(`❌ [Step 4] Failed to send digest email: ${err}`);
      }
    } else {
      logger?.info(
        "📨 [Step 4] Skipping email send (fixtures mode or no recipient)",
      );
    }

    await query(
      "UPDATE runs SET end_ts = NOW(), status = $1 WHERE run_id = $2",
      ["completed", inputData.runId],
    );

    const summary = `Processed ${inputData.totalEmails} emails, found ${inputData.totalParsed} jobs (${inputData.duplicateCount} dupes). Generated ${passed.length} packets (${failed.length} failed verification).`;

    logger?.info(`✅ [Step 4] Daily run complete: ${summary}`);

    return {
      digestSent: !!digestRecipient && process.env.USE_FIXTURES !== "true",
      summary,
    };
  },
});

export const jobMatchWorkflow = createWorkflow({
  id: "job-match-workflow",
  inputSchema: z.object({}) as any,
  outputSchema: z.object({
    digestSent: z.boolean(),
    summary: z.string(),
  }),
})
  .then(fetchAndParseStep as any)
  .then(scoreAndShortlistStep as any)
  .then(generatePacketsStep as any)
  .then(sendDigestStep as any)
  .commit();
