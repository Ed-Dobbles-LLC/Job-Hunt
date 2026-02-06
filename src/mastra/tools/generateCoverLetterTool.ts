import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const generateCoverLetterTool = createTool({
  id: "generate-cover-letter",
  description:
    "Generates a tailored cover letter for a specific job posting. The agent should call this with the tailored cover letter text. IMPORTANT: Only use facts from the experience inventory. Do NOT invent metrics, titles, employers, dates, tools, or claims. Cover letter must be 250-350 words.",
  inputSchema: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    coverLetterText: z.string().describe("The full cover letter text, 250-350 words"),
    evidenceMapping: z.array(
      z.object({
        claim_text: z.string(),
        evidence_quote: z.string(),
        evidence_source_key: z.string(),
        confidence: z.number(),
      }),
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    job_id: z.number(),
    coverLetterText: z.string(),
    evidenceMap: z.array(z.object({
      claim_text: z.string(),
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

    return {
      success: true,
      job_id: context.job_id,
      coverLetterText: context.coverLetterText,
      evidenceMap: context.evidenceMapping,
      wordCount,
    };
  },
});
