import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import {
  ExperienceInventorySchema,
  GapSchema,
  InterviewQuestionSchema,
} from "./profileSchemas";
import type { ExperienceInventory, Gap } from "./profileSchemas";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

/* ── Generate follow-up interview questions ─────────────────────── */

const GenerateQuestionsOutputSchema = z.object({
  questions: z.array(InterviewQuestionSchema),
});

export async function generateInterviewQuestions(
  draft: ExperienceInventory,
  gaps: Gap[],
  previousQA: Array<{ question: string; answer: string }>,
): Promise<z.infer<typeof InterviewQuestionSchema>[]> {
  const systemPrompt = `You are a career interview assistant helping build a comprehensive professional profile. Given a structured resume draft and a list of gaps, generate targeted follow-up questions to fill missing information.

Priority rules:
- HIGH: Missing metrics/numbers for bullet points (these are critical for the job application system to generate tailored resumes)
- HIGH: Missing tools/technologies per role
- MEDIUM: Missing dates or vague date ranges
- MEDIUM: Team size, budget, or scope details not yet captured
- LOW: Additional skills, certifications, or talking points that could strengthen the profile

Generate 3-5 questions per round. Be specific — reference the exact role and bullet point.
Example: "In your role as VP of Data at Acme Financial, you mentioned driving cost savings. Can you quantify the dollar amount saved and which technologies were used?"

Do NOT ask about things that have already been answered in the previous Q&A.`;

  const userPrompt = `Current draft:\n${JSON.stringify(draft, null, 2)}\n\nGaps:\n${JSON.stringify(gaps, null, 2)}\n\nPrevious Q&A:\n${JSON.stringify(previousQA, null, 2)}`;

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: GenerateQuestionsOutputSchema,
    system: systemPrompt,
    prompt: userPrompt,
    temperature: 0.4,
  });

  return object.questions;
}

/* ── Process answers and update the draft ────────────────────────── */

const ProcessAnswersOutputSchema = z.object({
  updatedDraft: ExperienceInventorySchema,
  remainingGaps: z.array(GapSchema),
  isComplete: z.boolean().describe("True when all high-priority gaps are resolved"),
});

export async function processAnswers(
  draft: ExperienceInventory,
  gaps: Gap[],
  newAnswers: Array<{ questionId: string; question: string; answer: string }>,
): Promise<{
  updatedDraft: ExperienceInventory;
  remainingGaps: Gap[];
  isComplete: boolean;
}> {
  const systemPrompt = `You are updating a structured professional profile based on interview answers. Given the current draft, a set of Q&A pairs, merge the new information into the draft.

Rules:
1. Only modify fields that the answers provide information about.
2. Preserve existing data — never remove information that was already in the draft.
3. Add new bullets only if the user describes achievements not already captured.
4. Extract metrics, tools, and dates from answers and place them in the correct schema fields.
5. Maintain the sequential ID scheme (exp-001, exp-001-b1, edu-001, cert-001, etc.).
6. Update the remainingGaps array to remove resolved items and add any new gaps discovered.
7. Set isComplete=true ONLY when all "high" priority gaps are resolved. It's OK to have some "medium" and "low" gaps remaining.
8. Do NOT fabricate any information. Only include what the user has explicitly stated.`;

  const userPrompt = `Current draft:\n${JSON.stringify(draft, null, 2)}\n\nCurrent gaps:\n${JSON.stringify(gaps, null, 2)}\n\nNew Q&A:\n${JSON.stringify(newAnswers, null, 2)}`;

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: ProcessAnswersOutputSchema,
    system: systemPrompt,
    prompt: userPrompt,
    temperature: 0.2,
  });

  return {
    updatedDraft: object.updatedDraft,
    remainingGaps: object.remainingGaps,
    isComplete: object.isComplete,
  };
}
