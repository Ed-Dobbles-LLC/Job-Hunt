import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
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

/* ── Role context for tailored questions ────────────────────────── */

export interface RoleContext {
  targetRole: string;
  interviewFocus: "leadership" | "balanced" | "technical" | string;
}

/* ── Generate follow-up interview questions ─────────────────────── */

const GenerateQuestionsOutputSchema = z.object({
  questions: z.array(InterviewQuestionSchema),
});

export async function generateInterviewQuestions(
  draft: ExperienceInventory,
  gaps: Gap[],
  previousQA: Array<{ question: string; answer: string }>,
  roleContext?: RoleContext,
): Promise<z.infer<typeof InterviewQuestionSchema>[]> {
  const focus = roleContext?.interviewFocus || "leadership";
  const targetRole = roleContext?.targetRole || "";

  // Build focus-specific priority rules
  let priorityRules: string;
  if (focus === "leadership") {
    priorityRules = `Priority rules (LEADERSHIP focus — this person is targeting senior/executive roles):
- HIGH: Quantified business outcomes — revenue generated, cost savings, efficiency gains, growth percentages
- HIGH: Team and organizational scope — team size, number of direct reports, cross-functional teams led, budget managed
- HIGH: Strategic initiatives — what they drove, why, and the measurable impact
- HIGH: Stakeholder management — who they influenced (C-suite, board, external partners) and how
- MEDIUM: Organizational change — transformations led, culture shifts, processes redesigned
- MEDIUM: Hiring, mentoring, and talent development track record
- LOW: Specific tools or technologies (only ask if a role explicitly lists them)
- LOW: Technical implementation details (skip unless directly relevant to the target role)

DO NOT ask about specific programming languages, frameworks, or tool versions unless the target role description explicitly requires them. Focus on WHAT was achieved and at WHAT scale, not HOW it was built technically.`;
  } else if (focus === "technical") {
    priorityRules = `Priority rules (TECHNICAL focus):
- HIGH: Missing metrics/numbers for bullet points
- HIGH: Specific tools, languages, frameworks, and architectures used
- HIGH: Technical challenges overcome and engineering decisions made
- MEDIUM: Team size and scope
- MEDIUM: Missing dates or vague date ranges
- LOW: Additional certifications or skills`;
  } else {
    priorityRules = `Priority rules (BALANCED focus):
- HIGH: Quantified business outcomes and metrics
- HIGH: Team size, scope, and leadership responsibilities
- MEDIUM: Key tools and technologies used
- MEDIUM: Strategic decisions and stakeholder management
- LOW: Missing dates, additional certifications`;
  }

  const roleLine = targetRole
    ? `\nThe candidate is targeting roles like: "${targetRole}". Tailor your questions to surface information that would be most compelling for that type of position.`
    : "";

  const systemPrompt = `You are a career interview assistant helping build a comprehensive professional profile. Given a structured resume draft and a list of gaps, generate targeted follow-up questions to fill missing information.
${roleLine}

${priorityRules}

Generate 3-5 questions per round. Be specific — reference the exact role and achievement.
Example (leadership): "As VP of Data at Acme Financial, you led a data platform migration. How large was the team you managed, what was the budget, and what business KPIs improved as a result?"
Example (leadership): "You mentioned driving $2M in cost savings. Can you walk me through the strategic decision that led to this and which senior stakeholders you partnered with?"

Do NOT ask about things that have already been answered in the previous Q&A.`;

  const userPrompt = `Current draft:\n${JSON.stringify(draft, null, 2)}\n\nGaps:\n${JSON.stringify(gaps, null, 2)}\n\nPrevious Q&A:\n${JSON.stringify(previousQA, null, 2)}`;

  try {
    const { object } = await generateObject({
      model: openai("gpt-4o"),
      schema: GenerateQuestionsOutputSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.4,
    });

    return object.questions;
  } catch (firstError: any) {
    console.error(`[profileInterview] Question generation failed: ${firstError.message}. Retrying...`);

    const { object } = await generateObject({
      model: openai("gpt-4o"),
      schema: GenerateQuestionsOutputSchema,
      system: systemPrompt + `\n\nIMPORTANT: Return a JSON object with a "questions" array. Each question must have: "id" (string), "question" (string), "targetField" (string), "priority" (one of "high", "medium", "low").`,
      prompt: userPrompt,
      temperature: 0.2,
    });

    return object.questions;
  }
}

/* ── Process answers and update the draft ────────────────────────── */

export async function processAnswers(
  draft: ExperienceInventory,
  gaps: Gap[],
  newAnswers: Array<{ questionId: string; question: string; answer: string }>,
  roleContext?: RoleContext,
): Promise<{
  updatedDraft: ExperienceInventory;
  remainingGaps: Gap[];
  isComplete: boolean;
}> {
  const focus = roleContext?.interviewFocus || "leadership";
  const targetRole = roleContext?.targetRole || "";

  let focusGuidance = "";
  if (focus === "leadership") {
    focusGuidance = `\nThis profile is being built for LEADERSHIP roles${targetRole ? ` (targeting: "${targetRole}")` : ""}. When extracting information from answers:
- Prioritize business outcomes, revenue impact, cost savings, and growth metrics
- Emphasize team size, org scope, budget, and stakeholder relationships
- Frame bullet points in terms of leadership impact, not technical implementation
- For the "metrics" field, focus on business KPIs (revenue, headcount, budget, efficiency %)
- For the "tools" field, only include tools that are strategic/platform-level, not low-level technical details`;
  } else if (focus === "technical") {
    focusGuidance = `\nThis profile is being built for TECHNICAL roles${targetRole ? ` (targeting: "${targetRole}")` : ""}. Emphasize tools, architectures, and technical achievements.`;
  }

  const systemPrompt = `You are updating a structured professional profile based on interview answers. Given the current draft, a set of Q&A pairs, merge the new information into the draft.
${focusGuidance}

Rules:
1. Only modify fields that the answers provide information about.
2. Preserve existing data — never remove information that was already in the draft.
3. Add new bullets only if the user describes achievements not already captured.
4. Extract metrics, tools, and dates from answers and place them in the correct schema fields.
5. Maintain the sequential ID scheme (exp-001, exp-001-b1, edu-001, cert-001, etc.).
6. Update the remainingGaps array to remove resolved items and add any new gaps discovered.
7. Set isComplete=true ONLY when all "high" priority gaps are resolved. It's OK to have some "medium" and "low" gaps remaining.
8. Do NOT fabricate any information. Only include what the user has explicitly stated.

Respond with ONLY a JSON object (no markdown fences, no explanation) with this structure:
{
  "updatedDraft": { "profile": {...}, "experience": [...], "education": [...], "skills": {...}, "certifications": [...] },
  "remainingGaps": [{ "field": "...", "description": "...", "priority": "high|medium|low" }],
  "isComplete": true/false
}`;

  const userPrompt = `Current draft:\n${JSON.stringify(draft, null, 2)}\n\nCurrent gaps:\n${JSON.stringify(gaps, null, 2)}\n\nNew Q&A:\n${JSON.stringify(newAnswers, null, 2)}`;

  const { text } = await generateText({
    model: openai("gpt-4o"),
    system: systemPrompt,
    prompt: userPrompt,
    temperature: 0.2,
  });

  // Extract JSON from the response (strip markdown fences if present)
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(jsonStr);

  // Safely extract with fallbacks
  const updatedDraft = parsed.updatedDraft || parsed.updated_draft || draft;
  const remainingGaps = (parsed.remainingGaps || parsed.remaining_gaps || []).map((g: any) => ({
    field: g.field || "",
    description: g.description || "",
    priority: ["high", "medium", "low"].includes(g.priority) ? g.priority : "medium",
  }));
  const isComplete = parsed.isComplete ?? parsed.is_complete ?? false;

  return { updatedDraft, remainingGaps, isComplete };
}
