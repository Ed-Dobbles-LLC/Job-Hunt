import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const generateCoverLetterTool = createTool({
  id: "generate-cover-letter",
  description:
    "Generates a tailored cover letter for a specific job posting. The agent should call this with the tailored cover letter text. IMPORTANT: Only use facts from the experience inventory. Do NOT invent metrics, titles, employers, dates, tools, or claims. Cover letter must be 250-350 words. Every factual claim MUST have an evidence pointer with the inventory bullet ID.",
  inputSchema: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    coverLetterText: z.string().describe("The full cover letter text, 250-350 words"),
    evidenceMapping: z.array(
      z.object({
        claim_text: z.string().describe("The cover letter claim text"),
        evidence_id: z.string().describe("Inventory bullet ID (e.g., exp-001-b2, edu-001, cert-001)"),
        evidence_quote: z.string().describe("Exact or near-exact quote from inventory"),
        evidence_source_key: z.string().describe("Inventory path (e.g., experience[0].bullets[1])"),
        confidence: z.number().min(0).max(1),
      }),
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    job_id: z.number(),
    coverLetterText: z.string(),
    evidenceMap: z.array(z.object({
      claim_text: z.string(),
      evidence_id: z.string(),
      evidence_quote: z.string(),
      evidence_source_key: z.string(),
      confidence: z.number(),
    })),
    wordCount: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const wordCount = context.coverLetterText.split(/\s+/).length;
    logger?.info(
      `📝 [generateCoverLetter] Generated cover letter for ${context.company} - ${context.title} (${wordCount} words)`,
    );

    if (context.evidenceMapping.length === 0) {
      logger?.warn(`⚠️ [generateCoverLetter] WARNING: No evidence mappings provided!`);
    }

    const missingIds = context.evidenceMapping.filter(e => !e.evidence_id || e.evidence_id.trim() === "");
    if (missingIds.length > 0) {
      logger?.warn(`⚠️ [generateCoverLetter] ${missingIds.length} evidence pointers missing evidence_id`);
    }

    return {
      success: true,
      job_id: context.job_id,
      coverLetterText: context.coverLetterText,
      evidenceMap: context.evidenceMapping,
      wordCount,
    };
  },
});
