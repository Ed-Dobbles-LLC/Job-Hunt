import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { jobMatchAgent } from "../agents/jobMatchAgent";
import { initDatabase, query } from "../tools/db";
import { sendEmail } from "../tools/gmailClient";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "../tools/paths";

async function executeFetchAndParse({ mastra }: { mastra?: any; inputData?: any }) {
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
    const gmailLabel = process.env.GMAIL_LABEL || "Job Alerts";
    emailsData = await fetchEmailsFromLabel(gmailLabel, 20);
  }

  if (emailsData.length === 0) {
    logger?.info("📧 [Step 1] No emails found");
    return {
      newJobIds: [] as number[],
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
        content: `Parse the following LinkedIn job alert emails and extract EACH individual job listing. These are LinkedIn job alert emails that contain brief listings with ONLY: title, company, location, and a LinkedIn URL. They do NOT contain full job descriptions.

For each job found, call the parse-jobs tool with a JSON array of all jobs.

Each job object should have:
- company: the company name (strip any separator like "·")
- title: the job title
- location: the location text
- posting_url: the LinkedIn URL (https://www.linkedin.com/jobs/view/...)
- jd_text: leave empty string "" (will be enriched via web search later)
- source: "linkedin"
- source_message_id: the email ID

IMPORTANT: Ignore footer text, copyright notices, "See all jobs" links, and "This email was intended for..." text. Also ignore annotations like "Actively recruiting", "1 school alum", "Remote OK" but DO extract location and remote status from them.

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
}

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
  execute: executeFetchAndParse,
});

async function executeEnrichJobs({ inputData, mastra }: { inputData: any; mastra?: any }) {
  const logger = mastra?.getLogger();
  logger?.info(
    `🔍 [Step 1.5] Enriching ${inputData.newJobIds.length} jobs with web search`,
  );

  if (inputData.newJobIds.length === 0) {
    logger?.info("🔍 [Step 1.5] No new jobs to enrich");
    return {
      enrichedJobIds: [] as number[],
      totalEmails: inputData.totalEmails,
      totalParsed: inputData.totalParsed,
      duplicateCount: inputData.duplicateCount,
      runId: inputData.runId,
    };
  }

  const jobsToEnrich = await query(
    `SELECT job_id, company, title, location, posting_url, jd_raw_text
     FROM jobs WHERE job_id = ANY($1)`,
    [inputData.newJobIds],
  );

  const needsEnrichment = jobsToEnrich.rows.filter(
    (j: any) => !j.jd_raw_text || j.jd_raw_text.length < 200,
  );

  logger?.info(
    `🔍 [Step 1.5] ${needsEnrichment.length} of ${jobsToEnrich.rows.length} jobs need enrichment`,
  );

  if (needsEnrichment.length > 0) {
    const batchSize = 3;
    let totalEnriched = 0;

    for (let i = 0; i < needsEnrichment.length; i += batchSize) {
      const batch = needsEnrichment.slice(i, i + batchSize);
      const jobSummaries = batch
        .map(
          (j: any) =>
            `- Job ID ${j.job_id}: "${j.title}" at ${j.company} (${j.location})${j.posting_url ? ` — URL: ${j.posting_url}` : ""}`,
        )
        .join("\n");

      logger?.info(
        `🔍 [Step 1.5] Enriching batch ${Math.floor(i / batchSize) + 1}: ${batch.length} jobs`,
      );

      const enrichResponse = await jobMatchAgent.generateLegacy(
        [
          {
            role: "user",
            content: `I need you to find full job descriptions for these ${batch.length} jobs. They were parsed from LinkedIn alerts and only have title, company, and location — no job description.

YOUR PROCESS (follow this EXACTLY):
1. For EACH job below, use the webSearch tool to search for: "[job title] [company name] job description responsibilities requirements"
2. From the search results, extract: full responsibilities, requirements, qualifications, preferred skills, compensation/salary, and remote/hybrid status
3. Write a comprehensive job description summary (at least 300 words) for each job based on what you find
4. After searching ALL jobs, call the enrich-jobs tool ONCE with ALL enrichments

Jobs to search:
${jobSummaries}

CRITICAL INSTRUCTIONS:
- You MUST call webSearch BEFORE calling enrich-jobs
- Each enrichment jd_text MUST be at least 300 characters
- Include specific requirements, responsibilities, tools/technologies mentioned
- If you can't find the exact posting, search for the company + role type to understand what they look for
- ONLY use webSearch and enrich-jobs tools in this step. Do NOT call fetch-emails, parse-jobs, score-jobs, generate-resume, generate-cover-letter, verify-truth, or build-output.`,
          },
        ],
        { maxSteps: 10 },
      );

      const allToolResults =
        enrichResponse.steps?.flatMap((s: any) => s.toolResults || []) || [];
      const allResults = allToolResults.map((r: any) => r.result || r);
      const enrichResult = allResults.find((r: any) => r.enrichedJobIds);
      totalEnriched += enrichResult?.enrichedCount || 0;
    }

    logger?.info(
      `✅ [Step 1.5] Web search enrichment complete: ${totalEnriched} enriched`,
    );
  }

  if (process.env.CLAY_WEBHOOK_URL) {
    logger?.info("🏺 [Step 1.5] Sending jobs to Clay for enrichment");
    const jobsForClay = jobsToEnrich.rows.map((j: any) => ({
      job_id: j.job_id,
      company: j.company,
      title: j.title,
      location: j.location,
      posting_url: j.posting_url || "",
    }));

    const clayResponse = await jobMatchAgent.generateLegacy(
      [
        {
          role: "user",
          content: `Send these jobs to Clay for company and contact enrichment. Call the clay-enrich tool with the following jobs:\n${JSON.stringify(jobsForClay, null, 2)}`,
        },
      ],
      { maxSteps: 3 },
    );

    logger?.info("✅ [Step 1.5] Clay enrichment request sent");
  }

  return {
    enrichedJobIds: inputData.newJobIds,
    totalEmails: inputData.totalEmails,
    totalParsed: inputData.totalParsed,
    duplicateCount: inputData.duplicateCount,
    runId: inputData.runId,
  };
}

const enrichJobsStep = createStep({
  id: "enrich-jobs-web-search",
  description:
    "Enriches parsed jobs with full descriptions via web search and optionally sends to Clay for company/contact enrichment",
  inputSchema: z.object({
    newJobIds: z.array(z.number()),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
    runId: z.string(),
  }),
  outputSchema: z.object({
    enrichedJobIds: z.array(z.number()),
    totalEmails: z.number(),
    totalParsed: z.number(),
    duplicateCount: z.number(),
    runId: z.string(),
  }),
  execute: executeEnrichJobs,
});

async function executeScoreAndShortlist({ inputData, mastra }: { inputData: any; mastra?: any }) {
  const logger = mastra?.getLogger();
  logger?.info(
    `📊 [Step 2] Scoring ${inputData.enrichedJobIds.length} enriched jobs`,
  );

  if (inputData.enrichedJobIds.length === 0) {
    logger?.info("📊 [Step 2] No new jobs to score");
    return {
      shortlistedJobs: [] as any[],
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
        content: `Score the following job IDs against my experience inventory and return the top 10: [${inputData.enrichedJobIds.join(", ")}]. Call the score-jobs tool with these job IDs.`,
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
}

const scoreAndShortlistStep = createStep({
  id: "score-and-shortlist",
  description: "Scores all new jobs and selects the top 10 for packet generation",
  inputSchema: z.object({
    enrichedJobIds: z.array(z.number()),
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
  execute: executeScoreAndShortlist,
});

async function executeGeneratePackets({ inputData, mastra }: { inputData: any; mastra?: any }) {
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
            content: `Generate a complete application packet for this job. You MUST follow the Extract → Tailor → Verify → Render pipeline:

1. **EXTRACT**: Call the extract-inventory tool to build the FactRegistry
2. **TAILOR**: Call generate-resume with tailored resume content + evidence pointers (each with evidence_id = inventory bullet ID like exp-001-b2)
3. **TAILOR**: Call generate-cover-letter with cover letter text + evidence pointers (each with evidence_id)
4. **VERIFY**: Call verify-truth to run 5-layer deterministic verification
5. **RENDER**: Call build-output to create the output folder with all files

IMPORTANT: Include contact discovery targets (3-10 recommended titles to search for at this company, since we cannot scrape LinkedIn).

## EVIDENCE POINTER REQUIREMENTS
Every resume bullet and cover letter factual claim MUST have an evidence pointer with:
- evidence_id: The inventory bullet ID (e.g., "exp-001-b2", "edu-001", "cert-001")
- evidence_quote: Exact or near-exact text from the inventory
- evidence_source_key: Path in inventory JSON (e.g., "experience[0].bullets[1]")
- confidence: 0.7-1.0

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

## STRICT TRUTHFULNESS RULES
- ONLY use facts from the inventory — NEVER invent employers, titles, dates, tools, degrees, certs, or metrics
- Every resume bullet needs an evidence_id pointing to inventory
- Every cover letter claim with metrics/tools/achievements needs an evidence_id
- If something is unknown, state it as unknown — never fabricate
- Numbers and metrics must be EXACT copies from inventory
- After generating, verify truth with 5-layer check, then build output`,
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
}

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
  execute: executeGeneratePackets,
});

async function executeSendDigest({ inputData, mastra }: { inputData: any; mastra?: any }) {
  const logger = mastra?.getLogger();
  logger?.info("📨 [Step 4] Building and sending daily digest");

  const today = new Date().toISOString().split("T")[0];
  const passed = inputData.results.filter((r: any) => r.truthPass);
  const failed = inputData.results.filter((r: any) => !r.truthPass && !r.error);
  const errors = inputData.results.filter((r: any) => r.error);

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
      html += `<p>${r.company} — ${r.title} (Score: ${r.total_score})</p>`;
    }
  }

  if (errors.length > 0) {
    html += `<h2>Errors</h2>`;
    for (const r of errors) {
      html += `<p>${r.company} — ${r.title}: ${r.error}</p>`;
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
}

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
  execute: executeSendDigest,
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
  .then(enrichJobsStep as any)
  .then(scoreAndShortlistStep as any)
  .then(generatePacketsStep as any)
  .then(sendDigestStep as any)
  .commit();

/**
 * Runs the workflow directly without Inngest.
 * Each step's standalone execute function is called sequentially,
 * passing output from one step as input to the next.
 */
export async function runWorkflowDirectly(mastra: any): Promise<{ digestSent: boolean; summary: string }> {
  const logger = mastra?.getLogger();
  logger?.info("🚀 [DirectRunner] Starting workflow execution (no Inngest)");

  // Step 1: Fetch and parse emails
  logger?.info("▶️ [DirectRunner] Step 1: Fetch and parse emails");
  const step1Result = await executeFetchAndParse({ mastra });

  // Step 2: Enrich jobs with web search
  logger?.info("▶️ [DirectRunner] Step 2: Enrich jobs");
  const step2Result = await executeEnrichJobs({ inputData: step1Result, mastra });

  // Step 3: Score and shortlist
  logger?.info("▶️ [DirectRunner] Step 3: Score and shortlist");
  const step3Result = await executeScoreAndShortlist({ inputData: step2Result, mastra });

  // Step 4: Generate packets
  logger?.info("▶️ [DirectRunner] Step 4: Generate packets");
  const step4Result = await executeGeneratePackets({ inputData: step3Result, mastra });

  // Step 5: Send digest
  logger?.info("▶️ [DirectRunner] Step 5: Send digest");
  const step5Result = await executeSendDigest({ inputData: step4Result, mastra });

  logger?.info(`✅ [DirectRunner] Workflow complete: ${step5Result.summary}`);
  return step5Result;
}
