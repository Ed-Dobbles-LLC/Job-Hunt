import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { ExperienceInventorySchema, GapSchema } from "./profileSchemas";
import type { ExperienceInventory, Gap } from "./profileSchemas";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const StructuredResumeOutputSchema = z.object({
  draft: ExperienceInventorySchema,
  gaps: z.array(GapSchema),
});

/**
 * Takes raw resume text and uses GPT-4o to produce a structured
 * ExperienceInventory draft plus a list of gaps/missing info.
 */
export async function structureResume(
  rawText: string,
): Promise<{ draft: ExperienceInventory; gaps: Gap[] }> {
  const systemPrompt = `You are an expert resume parser. Given raw text extracted from a resume document, produce a structured JSON object following the ExperienceInventory schema exactly.

Rules:
1. Assign sequential IDs: "exp-001", "exp-002", etc. for experience entries.
2. Assign bullet IDs: "exp-001-b1", "exp-001-b2", etc. for each bullet under an experience entry.
3. Extract quantified metrics from bullets into the metrics array (dollar amounts, percentages, team sizes, throughput numbers, etc.).
4. Extract tools/technologies mentioned in bullets into the tools array.
5. Parse dates into YYYY-MM format where possible. Use "present" for current roles.
6. For the skills section, categorize into: leadership, technical, data_science, and domains.
7. Assign "edu-001", "edu-002", etc. for education and "cert-001", "cert-002", etc. for certifications.
8. If information is ambiguous or missing, leave the field as an empty string rather than guessing.
9. In the gaps array, list every field where information is missing, incomplete, or could be strengthened with more detail.
10. Prioritize gaps: "high" for missing metrics on bullet points and missing tools/technologies per role, "medium" for missing dates or vague details, "low" for nice-to-have enhancements.
11. Write the summary as a 1-3 sentence professional overview based on the resume content.
12. Do NOT fabricate any information. Only include what is explicitly stated or clearly implied in the resume text.`;

  const userPrompt = `Here is the raw resume text to parse:\n\n${rawText}`;

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: StructuredResumeOutputSchema,
    system: systemPrompt,
    prompt: userPrompt,
    temperature: 0.2,
  });

  return { draft: object.draft, gaps: object.gaps };
}
