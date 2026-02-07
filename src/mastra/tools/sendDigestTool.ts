import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import { sendEmail } from "./gmailClient";
import {
  renderDigestEmail,
  type DigestData,
  type DigestJob,
  type DigestStats,
} from "./digestEmailTemplate";

function loadRecipientEmail(): string {
  const inventoryPath = workspacePath("experience_inventory.json");
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  return inventory.profile?.email || "";
}

async function aggregateTodayStats(): Promise<{
  stats: DigestStats;
  jobs: DigestJob[];
}> {
  const today = new Date().toISOString().split("T")[0];

  const fetchedResult = await query(
    `SELECT COUNT(*) as count FROM jobs WHERE date_ingested::date = $1`,
    [today],
  );
  const jobsFetched = parseInt(fetchedResult.rows[0]?.count || "0");

  const scoredResult = await query(
    `SELECT COUNT(*) as count FROM scores s
     JOIN jobs j ON s.job_id = j.job_id
     WHERE j.date_ingested::date = $1`,
    [today],
  );
  const jobsScored = parseInt(scoredResult.rows[0]?.count || "0");

  const shortlistedResult = await query(
    `SELECT j.job_id, j.company, j.title, j.posting_url, j.location,
            j.keywords, j.jd_requirements,
            s.total_score, s.breakdown_json, s.match_report,
            a.truth_pass
     FROM jobs j
     JOIN scores s ON j.job_id = s.job_id
     LEFT JOIN artifacts a ON j.job_id = a.job_id
     WHERE j.date_ingested::date = $1
     ORDER BY s.total_score DESC`,
    [today],
  );

  const jobs: DigestJob[] = [];
  let truthPassCount = 0;
  let truthFailCount = 0;
  let packetsGenerated = 0;

  for (let i = 0; i < shortlistedResult.rows.length; i++) {
    const row = shortlistedResult.rows[i];
    const breakdown =
      typeof row.breakdown_json === "string"
        ? JSON.parse(row.breakdown_json)
        : row.breakdown_json || {};
    const matchReport =
      typeof row.match_report === "string"
        ? JSON.parse(row.match_report)
        : row.match_report || {};

    if (row.truth_pass !== null && row.truth_pass !== undefined) {
      packetsGenerated++;
      if (row.truth_pass) {
        truthPassCount++;
      } else {
        truthFailCount++;
      }
    }

    let topSkills: string[] = [];
    if (matchReport.top_matching_skills) {
      topSkills = matchReport.top_matching_skills.slice(0, 3);
    } else if (breakdown.skill_match_details) {
      topSkills = Object.keys(breakdown.skill_match_details).slice(0, 3);
    }

    let salaryRange: string | null = null;
    if (matchReport.salary_range) {
      salaryRange = matchReport.salary_range;
    } else if (breakdown.salary_range) {
      salaryRange = breakdown.salary_range;
    }

    let roleShape: string | null = null;
    if (matchReport.role_shape) {
      roleShape = matchReport.role_shape;
    } else if (breakdown.role_shape) {
      roleShape = breakdown.role_shape;
    }

    let gapNotes: string[] = [];
    if (matchReport.gap_notes) {
      gapNotes = matchReport.gap_notes.slice(0, 3);
    } else if (breakdown.gap_notes) {
      gapNotes = breakdown.gap_notes.slice(0, 3);
    }

    jobs.push({
      rank: i + 1,
      company: row.company || "Unknown",
      title: row.title || "Unknown",
      score: row.total_score || 0,
      truthPass: row.truth_pass ?? false,
      postingUrl: row.posting_url,
      location: row.location,
      salaryRange,
      roleShape,
      topSkills,
      gapNotes,
    });
  }

  return {
    stats: {
      jobsFetched,
      jobsScored,
      jobsShortlisted: shortlistedResult.rows.length,
      packetsGenerated,
      truthPassCount,
      truthFailCount,
    },
    jobs,
  };
}

export const sendDigestTool = createTool({
  id: "send-digest",
  description:
    "Aggregates today's job match results from the database, composes a rich HTML digest email with ranked job table, detail cards, and summary stats, then sends it via Gmail API. Stores digest metadata in the digests table.",
  inputSchema: z.object({
    recipientOverride: z
      .string()
      .email()
      .optional()
      .describe("Override recipient email (defaults to profile.email from experience_inventory.json)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, generate the email HTML but do not send it"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    digestId: z.number().optional(),
    recipientEmail: z.string(),
    jobCount: z.number(),
    emailSent: z.boolean(),
    htmlPreview: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const today = new Date().toISOString().split("T")[0];

    logger?.info(`📧 [sendDigest] Starting digest generation for ${today}`);

    const recipientEmail = context.recipientOverride || loadRecipientEmail();
    if (!recipientEmail) {
      logger?.error(`❌ [sendDigest] No recipient email found`);
      return {
        success: false,
        recipientEmail: "",
        jobCount: 0,
        emailSent: false,
        error: "No recipient email found in experience_inventory.json or recipientOverride",
      };
    }

    logger?.info(`📧 [sendDigest] Recipient: ${recipientEmail}`);

    let stats: DigestStats;
    let jobs: DigestJob[];

    try {
      const aggregated = await aggregateTodayStats();
      stats = aggregated.stats;
      jobs = aggregated.jobs;
      logger?.info(
        `📊 [sendDigest] Aggregated: ${stats.jobsFetched} fetched, ${stats.jobsScored} scored, ${stats.jobsShortlisted} shortlisted, ${stats.packetsGenerated} packets`,
      );
    } catch (err: any) {
      logger?.error(`❌ [sendDigest] Failed to aggregate stats: ${err.message}`);
      return {
        success: false,
        recipientEmail,
        jobCount: 0,
        emailSent: false,
        error: `Database aggregation failed: ${err.message}`,
      };
    }

    const digestData: DigestData = {
      date: today,
      stats,
      jobs,
      runTimestamp: new Date().toISOString(),
      modelUsed: "gpt-4o",
      promptVersion: "v2",
    };

    const html = renderDigestEmail(digestData);
    logger?.info(`📧 [sendDigest] HTML digest rendered (${html.length} chars)`);

    let emailSent = false;
    if (!context.dryRun) {
      try {
        const subject = jobs.length > 0
          ? `Job Match Digest – ${today} (${jobs.length} match${jobs.length !== 1 ? "es" : ""})`
          : `Job Match Digest – ${today} (No matches)`;

        await sendEmail(recipientEmail, subject, html);
        emailSent = true;
        logger?.info(`✅ [sendDigest] Email sent to ${recipientEmail}`);
      } catch (err: any) {
        logger?.error(`❌ [sendDigest] Failed to send email: ${err.message}`);
        return {
          success: false,
          recipientEmail,
          jobCount: jobs.length,
          emailSent: false,
          error: `Email send failed: ${err.message}`,
        };
      }
    } else {
      logger?.info(`⏩ [sendDigest] Dry run – email not sent`);
    }

    let digestId: number | undefined;
    try {
      const result = await query(
        `INSERT INTO digests (run_date, jobs_fetched, jobs_scored, jobs_shortlisted, packets_generated, truth_pass_count, truth_fail_count, email_sent, sent_at, recipient_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING digest_id`,
        [
          today,
          stats.jobsFetched,
          stats.jobsScored,
          stats.jobsShortlisted,
          stats.packetsGenerated,
          stats.truthPassCount,
          stats.truthFailCount,
          emailSent,
          emailSent ? new Date() : null,
          recipientEmail,
        ],
      );
      digestId = result.rows[0]?.digest_id;
      logger?.info(`💾 [sendDigest] Digest record saved: digest_id=${digestId}`);
    } catch (err: any) {
      logger?.error(`⚠️ [sendDigest] Failed to save digest record: ${err.message}`);
    }

    logger?.info(
      `✅ [sendDigest] Digest complete: ${jobs.length} jobs, email_sent=${emailSent}, digest_id=${digestId}`,
    );

    return {
      success: true,
      digestId,
      recipientEmail,
      jobCount: jobs.length,
      emailSent,
      htmlPreview: context.dryRun ? html : undefined,
    };
  },
});
