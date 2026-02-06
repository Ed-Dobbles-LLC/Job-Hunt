import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";

export const clayEnrichTool = createTool({
  id: "clay-enrich",
  description:
    "Sends job and company data to a Clay webhook for enrichment (company details, contacts, hiring signals). Requires CLAY_WEBHOOK_URL environment variable. Results are pushed back asynchronously by Clay.",
  inputSchema: z.object({
    jobs: z.array(
      z.object({
        job_id: z.number(),
        company: z.string(),
        title: z.string(),
        location: z.string(),
        posting_url: z.string().optional(),
      }),
    ),
  }),
  outputSchema: z.object({
    sentCount: z.number(),
    skippedCount: z.number(),
    webhookConfigured: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const webhookUrl = process.env.CLAY_WEBHOOK_URL;

    if (!webhookUrl) {
      logger?.info(
        "⏭️ [clayEnrich] CLAY_WEBHOOK_URL not configured, skipping Clay enrichment",
      );
      return {
        sentCount: 0,
        skippedCount: context.jobs.length,
        webhookConfigured: false,
        message:
          "Clay webhook URL not configured. Set CLAY_WEBHOOK_URL environment variable to enable Clay enrichment.",
      };
    }

    logger?.info(
      `🏺 [clayEnrich] Sending ${context.jobs.length} jobs to Clay webhook`,
    );

    let sentCount = 0;
    let skippedCount = 0;

    for (const job of context.jobs) {
      try {
        const companyDomain = guessCompanyDomain(job.company);

        const payload = {
          job_id: job.job_id,
          company_name: job.company,
          company_domain: companyDomain,
          job_title: job.title,
          job_url: job.posting_url || "",
          location: job.location,
          source: "job-match-automation",
          timestamp: new Date().toISOString(),
        };

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          sentCount++;
          logger?.info(
            `✅ [clayEnrich] Sent to Clay: ${job.company} - ${job.title}`,
          );
        } else {
          skippedCount++;
          logger?.warn(
            `⚠️ [clayEnrich] Clay webhook returned ${response.status} for ${job.company}`,
          );
        }
      } catch (err) {
        skippedCount++;
        logger?.error(
          `❌ [clayEnrich] Failed to send ${job.company} to Clay: ${err}`,
        );
      }
    }

    logger?.info(
      `📊 [clayEnrich] Done: ${sentCount} sent, ${skippedCount} skipped`,
    );

    return {
      sentCount,
      skippedCount,
      webhookConfigured: true,
      message: `Sent ${sentCount} jobs to Clay for enrichment. Results will be available in your Clay table.`,
    };
  },
});

function guessCompanyDomain(companyName: string): string {
  const cleaned = companyName
    .toLowerCase()
    .replace(/\s*(inc\.?|corp\.?|llc|ltd\.?|group|holdings?|co\.?)\s*$/i, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "")
    .trim();
  return `${cleaned}.com`;
}
