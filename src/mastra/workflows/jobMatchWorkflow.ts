import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { jobMatchAgent } from "../agents/jobMatchAgent";
import { initDatabase, query } from "../tools/db";
import { sendEmail } from "../tools/gmailClient";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "../tools/paths";
import { extractJDRequirementsTool } from "../tools/extractJDRequirementsTool";
import { generateVerifiedPacketTool } from "../tools/generateVerifiedPacketTool";
import { buildOutputTool } from "../tools/buildOutputTool";
import { contactDiscoveryTool } from "../tools/contactDiscoveryTool";

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
    emailsData = await fetchEmailsFromLabel(gmailLabel, 50);
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

  // Filter out emails we've already processed
  const allGmailIds = emailsData.map((e: any) => e.id);
  const alreadyProcessed = await query(
    "SELECT gmail_id FROM processed_gmail_ids WHERE gmail_id = ANY($1)",
    [allGmailIds],
  );
  const processedSet = new Set(alreadyProcessed.rows.map((r: any) => r.gmail_id));
  const originalCount = emailsData.length;
  emailsData = emailsData.filter((e: any) => !processedSet.has(e.id));

  if (processedSet.size > 0) {
    logger?.info(
      `📧 [Step 1] Skipped ${processedSet.size} already-processed emails, ${emailsData.length} new to parse`,
    );
  }

  if (emailsData.length === 0) {
    logger?.info("📧 [Step 1] All fetched emails were already processed");
    return {
      newJobIds: [] as number[],
      totalEmails: originalCount,
      totalParsed: 0,
      duplicateCount: 0,
      runId,
    };
  }

  logger?.info(
    `📧 [Step 1] Found ${emailsData.length} new emails (${originalCount} total), parsing with agent...`,
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

  if (!parseResult) {
    logger?.error(
      `❌ [Step 1] Agent did NOT invoke parseJobsTool! Tool results: ${JSON.stringify(allResults.slice(0, 3))}. Agent text: ${(parseResponse.text || "").slice(0, 200)}`,
    );
  }

  const newJobIds = parseResult?.newJobIds || [];
  const duplicateCount = parseResult?.duplicateCount || 0;
  const totalParsed = parseResult?.totalParsed || 0;

  // Mark all fetched emails as processed so we don't re-fetch them
  for (const email of emailsData) {
    try {
      await query(
        `INSERT INTO processed_gmail_ids (gmail_id, jobs_found)
         VALUES ($1, $2)
         ON CONFLICT (gmail_id) DO NOTHING`,
        [email.id, totalParsed],
      );
    } catch (err) {
      logger?.warn(`⚠️ [Step 1] Failed to mark email ${email.id} as processed: ${err}`);
    }
  }

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
    (j: any) => !j.jd_raw_text || j.jd_raw_text.length < 100,
  );

  logger?.info(
    `🔍 [Step 1.5] ${needsEnrichment.length} of ${jobsToEnrich.rows.length} jobs need enrichment`,
  );

  if (needsEnrichment.length > 0) {
    // Phase 1: Deterministic URL scraping (fast, free, no LLM)
    const withUrls = needsEnrichment.filter(
      (j: any) => j.posting_url && j.posting_url.startsWith("http"),
    );

    let urlEnrichedCount = 0;
    if (withUrls.length > 0) {
      logger?.info(
        `🔗 [Step 1.5] Phase 1: URL scraping ${withUrls.length} jobs with posting URLs`,
      );
      try {
        const { enrichJobsByUrl } = await import("../tools/urlScrapeEnricher");
        const urlResult = await enrichJobsByUrl(withUrls, logger as any);
        urlEnrichedCount = urlResult.enrichedCount;
        logger?.info(
          `🔗 [Step 1.5] URL scraping done: ${urlResult.enrichedCount} enriched, ${urlResult.failedCount} failed`,
        );
      } catch (err: any) {
        logger?.error(`❌ [Step 1.5] URL scraping error: ${err.message}`);
      }
    }

    // Phase 2: LLM web search for jobs still missing JD after URL scraping
    const stillNeedEnrichment = await query(
      `SELECT job_id, company, title, location, posting_url
       FROM jobs WHERE job_id = ANY($1) AND (jd_raw_text IS NULL OR LENGTH(jd_raw_text) < 100)`,
      [needsEnrichment.map((j: any) => j.job_id)],
    );

    let totalEnriched = urlEnrichedCount;

    if (stillNeedEnrichment.rows.length > 0) {
      logger?.info(
        `🔍 [Step 1.5] Phase 2: LLM web search for ${stillNeedEnrichment.rows.length} remaining jobs`,
      );

      const batchSize = 3;
      for (let i = 0; i < stillNeedEnrichment.rows.length; i += batchSize) {
        const batch = stillNeedEnrichment.rows.slice(i, i + batchSize);
        const jobSummaries = batch
          .map(
            (j: any) =>
              `- Job ID ${j.job_id}: "${j.title}" at ${j.company} (${j.location})${j.posting_url ? ` — URL: ${j.posting_url}` : ""}`,
          )
          .join("\n");

        logger?.info(
          `🔍 [Step 1.5] Enriching batch ${Math.floor(i / batchSize) + 1}: ${batch.length} jobs`,
        );

        try {
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
        } catch (err: any) {
          logger?.error(
            `❌ [Step 1.5] Batch ${Math.floor(i / batchSize) + 1} failed: ${err.message}`,
          );
        }
      }
    }

    logger?.info(
      `✅ [Step 1.5] Enrichment complete: ${totalEnriched} enriched (${urlEnrichedCount} via URL, ${totalEnriched - urlEnrichedCount} via web search)`,
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

  // Also pick up unscored jobs from other sources (Clay, Apollo, import)
  const unscoredResult = await query(
    `SELECT j.job_id FROM jobs j
     LEFT JOIN scores s ON j.job_id = s.job_id
     WHERE s.job_id IS NULL AND j.jd_raw_text IS NOT NULL AND LENGTH(j.jd_raw_text) > 100
     AND j.job_id != ALL($1)`,
    [inputData.enrichedJobIds || []],
  );
  const unscoredIds = unscoredResult.rows.map((r: any) => r.job_id);
  const allJobIds = [...(inputData.enrichedJobIds || []), ...unscoredIds];

  logger?.info(
    `📊 [Step 2] Scoring ${allJobIds.length} jobs (${inputData.enrichedJobIds.length} from email + ${unscoredIds.length} from other sources)`,
  );

  if (allJobIds.length === 0) {
    logger?.info("📊 [Step 2] No jobs to score");
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
        content: `Score the following job IDs against my experience inventory and return the top 10: [${allJobIds.join(", ")}]. Call the score-jobs tool with these job IDs.`,
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
    `🏗️ [Step 3] Generating packets for ${inputData.shortlistedJobs.length} jobs (deterministic pipeline)`,
  );

  const results: any[] = [];

  for (const job of inputData.shortlistedJobs) {
    try {
      logger?.info(
        `📦 [Step 3] Processing: ${job.company} - ${job.title} (Score: ${job.total_score})`,
      );

      // Phase 1: Extract JD requirements if not already done
      const reqCheck = await query(
        "SELECT jd_requirements FROM jobs WHERE job_id = $1",
        [job.job_id],
      );
      if (!reqCheck.rows[0]?.jd_requirements) {
        logger?.info(`📋 [Step 3] Extracting JD requirements for job_id=${job.job_id}`);
        await extractJDRequirementsTool.execute({
          context: {
            job_id: job.job_id,
            jd_text: job.jd_raw_text,
            company: job.company,
            title: job.title,
          },
          mastra,
        } as any);
        logger?.info(`✅ [Step 3] JD requirements extracted for ${job.company}`);
      }

      // Phase 2: Generate verified resume + cover letter (with internal verify-correct loop)
      logger?.info(`📄 [Step 3] Generating verified packet for ${job.company} - ${job.title}`);
      const packetResult = await generateVerifiedPacketTool.execute({
        context: {
          job_id: job.job_id,
          company: job.company,
          title: job.title,
          max_attempts: 3,
        },
        mastra,
      } as any);

      if (!packetResult.success) {
        throw new Error(`Packet generation failed for job_id=${job.job_id}`);
      }

      logger?.info(`📄 [Step 3] Packet generated: pass=${packetResult.pass}, attempts=${packetResult.attempts_used}`);

      // Phase 3: Combine evidence pointers from resume + cover letter
      const resumePointers = (packetResult.resume.evidence_pointers || []).map((p: any) => ({
        claim_text: p.claim_text,
        evidence_id: p.source_hash,
        evidence_quote: p.evidence_quote,
        evidence_source_key: p.source_hash,
        confidence: p.confidence,
      }));
      const clPointers = (packetResult.cover_letter.evidence_pointers || []).map((p: any) => ({
        claim_text: p.claim_text,
        evidence_id: p.source_hash,
        evidence_quote: p.evidence_quote,
        evidence_source_key: p.source_hash,
        confidence: p.confidence,
      }));
      const combinedEvidence = [...resumePointers, ...clPointers];

      logger?.info(`🔗 [Step 3] Combined evidence: ${resumePointers.length} resume + ${clPointers.length} cover letter = ${combinedEvidence.length} total`);

      // Phase 4: Build output files (DOCX, PDF, evidence JSON, verifier JSON)
      logger?.info(`📁 [Step 3] Building output files for ${job.company} - ${job.title}`);
      const buildResult = await buildOutputTool.execute({
        context: {
          job_id: job.job_id,
          company: job.company,
          title: job.title,
          resume: packetResult.resume,
          cover_letter: packetResult.cover_letter,
          evidenceMap: combinedEvidence,
          verifierResult: packetResult.final_report,
          scoringBreakdown: job.breakdown,
          totalScore: job.total_score,
          skip_pdf: false,
        },
        mastra,
      } as any);

      // Phase 5: Contact discovery (optional, non-blocking)
      try {
        logger?.info(`👥 [Step 3] Running contact discovery for ${job.company}`);
        await contactDiscoveryTool.execute({
          context: {
            job_id: job.job_id,
            company_name: job.company,
            job_title: job.title,
            location: job.location,
            target_function: "",
          },
          mastra,
        } as any);
      } catch (contactErr: any) {
        logger?.warn(`⚠️ [Step 3] Contact discovery failed (non-blocking): ${contactErr.message}`);
      }

      // Update job status
      await query(
        "UPDATE jobs SET status = $1 WHERE job_id = $2",
        [packetResult.pass ? "generated" : "generated-unverified", job.job_id],
      );

      results.push({
        job_id: job.job_id,
        company: job.company,
        title: job.title,
        total_score: job.total_score,
        truthPass: packetResult.pass,
        outputDir: buildResult.outputDir || "",
      });

      logger?.info(
        `✅ [Step 3] Packet complete for ${job.company} - ${job.title} (truth_pass=${packetResult.pass})`,
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

  // Mark any stale "running" runs older than 2 hours as failed
  try {
    const staleResult = await query(
      `UPDATE runs SET end_ts = NOW(), status = 'failed'
       WHERE status = 'running' AND start_ts < NOW() - INTERVAL '2 hours'
       RETURNING run_id`,
    );
    if (staleResult.rows.length > 0) {
      logger?.warn(
        `🧹 [DirectRunner] Cleaned up ${staleResult.rows.length} stale runs: ${staleResult.rows.map((r: any) => r.run_id).join(", ")}`,
      );
    }
  } catch (err) {
    logger?.warn(`⚠️ [DirectRunner] Failed to clean stale runs: ${err}`);
  }

  let runId: string | undefined;

  try {
    // Step 1: Fetch and parse emails
    logger?.info("▶️ [DirectRunner] Step 1: Fetch and parse emails");
    const step1Result = await executeFetchAndParse({ mastra });
    runId = step1Result.runId;

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
  } catch (err: any) {
    logger?.error(`❌ [DirectRunner] Workflow failed: ${err.message}\n${err.stack}`);

    // Mark this run as failed so it doesn't stay "running" forever
    if (runId) {
      try {
        await query(
          "UPDATE runs SET end_ts = NOW(), status = 'failed' WHERE run_id = $1",
          [runId],
        );
      } catch (dbErr) {
        logger?.error(`❌ [DirectRunner] Could not update run ${runId} to failed: ${dbErr}`);
      }
    }

    return {
      digestSent: false,
      summary: `Workflow failed: ${err.message}`,
    };
  }
}
