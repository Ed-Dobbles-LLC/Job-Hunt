import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";

export const enrichJobsTool = createTool({
  id: "enrich-jobs",
  description:
    "Updates job records in the database with enriched data from web search. Call this after looking up job details via web search to save the full job description, compensation, and other details back to the database.",
  inputSchema: z.object({
    enrichments: z.array(
      z.object({
        job_id: z.number().describe("Database job ID to enrich"),
        jd_text: z
          .string()
          .describe("Full job description text found via web search"),
        compensation: z
          .string()
          .optional()
          .describe("Compensation/salary range if found"),
        remote_hybrid: z
          .string()
          .optional()
          .describe("Remote/hybrid/on-site status if found"),
        requirements: z
          .string()
          .optional()
          .describe("Key requirements summary if found"),
      }),
    ),
  }),
  outputSchema: z.object({
    enrichedCount: z.number(),
    skippedCount: z.number(),
    enrichedJobIds: z.array(z.number()),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `🔍 [enrichJobs] Enriching ${context.enrichments.length} jobs with web search data`,
    );

    let enrichedCount = 0;
    let skippedCount = 0;
    const enrichedJobIds: number[] = [];

    for (const enrichment of context.enrichments) {
      const existing = await query(
        "SELECT job_id, jd_raw_text FROM jobs WHERE job_id = $1",
        [enrichment.job_id],
      );

      if (existing.rows.length === 0) {
        logger?.warn(
          `⚠️ [enrichJobs] Job ID ${enrichment.job_id} not found, skipping`,
        );
        skippedCount++;
        continue;
      }

      const currentJd = existing.rows[0].jd_raw_text || "";
      if (currentJd.length > 200) {
        logger?.info(
          `🔄 [enrichJobs] Job ID ${enrichment.job_id} already has a substantial JD (${currentJd.length} chars), skipping enrichment`,
        );
        skippedCount++;
        enrichedJobIds.push(enrichment.job_id);
        continue;
      }

      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (enrichment.jd_text) {
        updates.push(`jd_raw_text = $${paramIndex}`);
        values.push(enrichment.jd_text);
        paramIndex++;
      }

      if (enrichment.compensation) {
        updates.push(`compensation = $${paramIndex}`);
        values.push(enrichment.compensation);
        paramIndex++;
      }

      if (enrichment.remote_hybrid) {
        updates.push(`remote_hybrid = $${paramIndex}`);
        values.push(enrichment.remote_hybrid);
        paramIndex++;
      }

      if (updates.length === 0) {
        logger?.info(
          `⏭️ [enrichJobs] No enrichment data for job ID ${enrichment.job_id}`,
        );
        skippedCount++;
        continue;
      }

      updates.push(`status = $${paramIndex}`);
      values.push("enriched");
      paramIndex++;

      values.push(enrichment.job_id);

      await query(
        `UPDATE jobs SET ${updates.join(", ")} WHERE job_id = $${paramIndex}`,
        values,
      );

      enrichedCount++;
      enrichedJobIds.push(enrichment.job_id);
      logger?.info(
        `✅ [enrichJobs] Enriched job ID ${enrichment.job_id} with ${enrichment.jd_text.length} chars of JD text`,
      );
    }

    logger?.info(
      `📊 [enrichJobs] Done: ${enrichedCount} enriched, ${skippedCount} skipped`,
    );

    return {
      enrichedCount,
      skippedCount,
      enrichedJobIds,
    };
  },
});
