import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const generateResumeTool = createTool({
  id: "generate-resume",
  description:
    "Generates a tailored ATS-friendly resume for a specific job posting. The agent should call this with the job description and the tailored resume content. IMPORTANT: Only use facts from the experience inventory. Do NOT invent metrics, titles, employers, dates, tools, or claims. Every bullet MUST have an evidence pointer with the inventory bullet ID (e.g., exp-001-b2).",
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
        claim_text: z.string().describe("The resume bullet or claim text"),
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
    resumeData: z.object({}).passthrough(),
    evidenceMap: z.array(z.object({
      claim_text: z.string(),
      evidence_id: z.string(),
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

    const totalBullets = context.resumeSections.experience.reduce(
      (sum, exp) => sum + exp.bullets.length, 0
    );
    logger?.info(`📄 [generateResume] Resume has ${totalBullets} bullets, ${context.evidenceMapping.length} evidence pointers`);

    if (context.evidenceMapping.length === 0) {
      logger?.warn(`⚠️ [generateResume] WARNING: No evidence mappings provided!`);
    }

    const missingIds = context.evidenceMapping.filter(e => !e.evidence_id || e.evidence_id.trim() === "");
    if (missingIds.length > 0) {
      logger?.warn(`⚠️ [generateResume] ${missingIds.length} evidence pointers missing evidence_id`);
    }

    return {
      success: true,
      job_id: context.job_id,
      resumeData: context.resumeSections,
      evidenceMap: context.evidenceMapping,
    };
  },
});
