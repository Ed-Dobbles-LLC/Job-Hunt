import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const generateResumeTool = createTool({
  id: "generate-resume",
  description:
    "Generates a tailored ATS-friendly resume for a specific job posting. The agent should call this with the job description and the tailored resume content. IMPORTANT: Only use facts from the experience inventory. Do NOT invent metrics, titles, employers, dates, tools, or claims.",
  inputSchema: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    resumeSections: z.object({
      summary: z.string().describe("Tailored professional summary (3-4 sentences)"),
      experience: z.array(
        z.object({
          employer: z.string(),
          title: z.string(),
          start_date: z.string(),
          end_date: z.string(),
          location: z.string(),
          bullets: z.array(z.string()).describe("Tailored bullet points from inventory only"),
        }),
      ),
      skills: z.array(z.string()).describe("Relevant skills from inventory"),
      education: z.array(
        z.object({
          institution: z.string(),
          degree: z.string(),
          year: z.string(),
        }),
      ),
      certifications: z
        .array(
          z.union([
            z.string(),
            z.object({
              id: z.string().optional(),
              name: z.string(),
              year: z.string().optional(),
              issuer: z.string().optional(),
            }),
          ]),
        )
        .optional(),
    }),
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
    resumeData: z.object({}).passthrough(),
    evidenceMap: z.array(z.object({
      claim_text: z.string(),
      evidence_quote: z.string(),
      evidence_source_key: z.string(),
      confidence: z.number(),
    })),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `📄 [generateResume] Generating tailored resume for ${context.company} - ${context.title}`,
    );

    return {
      success: true,
      job_id: context.job_id,
      resumeData: context.resumeSections,
      evidenceMap: context.evidenceMapping,
    };
  },
});
