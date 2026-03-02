/**
 * Strategic Fit Assessor — LLM reasoning layer for match scoring.
 *
 * Complements the deterministic matchScorer with strategic narrative
 * assessment. Maps JD mandates to ENS signature problems and evaluates
 * proof anchor relevance.
 *
 * This is the module that closes the quality gap between "token overlap
 * scoring" and "Claude-in-conversation strategic assessment."
 *
 * Cost: ~$0.01-0.02 per call (single Sonnet call, ~1500 input tokens, ~500 output)
 * Latency: ~2-4 seconds per job
 */

import { z } from "zod";
import { generateObject } from "ai";
import { resolveProvider } from "../../resume-engine/llm-provider";

// ── Schema ──────────────────────────────────────────────────────

export const StrategicFitSchema = z.object({
  primary_mandate_problem: z.object({
    jd_mandate: z.string().describe("What problem is this role actually trying to solve? One sentence."),
    mapped_signature_problem: z.enum(["sp-1", "sp-2", "sp-3", "none"]).describe(
      "Which ENS signature problem does the JD mandate most closely map to? sp-1 = analytics disconnected from business, sp-2 = gap between vision and execution, sp-3 = analytics built at wrong speed, none = no clear mapping"
    ),
    mapping_confidence: z.number().min(0).max(1).describe("How confident are you in this mapping? 0.0-1.0"),
    mapping_rationale: z.string().describe("Why this signature problem maps (or doesn't). 1-2 sentences."),
  }),
  proof_anchor_relevance: z.array(z.object({
    anchor_id: z.string().describe("pa-1, pa-2, or pa-3"),
    relevance: z.enum(["direct", "adjacent", "weak", "none"]).describe(
      "direct = proof anchor directly addresses the JD mandate, adjacent = related but not primary, weak = tangential, none = not relevant"
    ),
    rationale: z.string().describe("How this proof anchor connects (or doesn't) to the role. 1 sentence."),
  })),
  narrative_fit: z.object({
    transformation_thread_relevant: z.boolean().describe("Does the 'data waiter to decision engine' thread resonate with what this role needs?"),
    differentiator_match: z.boolean().describe("Does the 'Geek that can Speak' differentiator align with what this role values?"),
    fit_summary: z.string().describe("Overall strategic fit in 2-3 sentences. Would a retained search consultant present this candidate for this role?"),
  }),
  strategic_score: z.number().min(0).max(25).describe(
    "Strategic fit score 0-25. 20-25 = strong strategic match (signature problem maps directly, 2+ proof anchors relevant). 12-19 = moderate fit (adjacent mapping, 1 strong proof anchor). 5-11 = weak fit (no clear signature problem mapping but some relevance). 0-4 = poor fit (different problem space entirely)."
  ),
  risk_notes: z.array(z.string()).max(3).describe(
    "Strategic risks or gaps. E.g., 'Role emphasizes platform engineering depth that the candidate's proof anchors don't address.'"
  ),
});
export type StrategicFitAssessment = z.infer<typeof StrategicFitSchema>;

// ── System Prompt ───────────────────────────────────────────────

function buildAssessorSystemPrompt(): string {
  return `You are a retained executive search consultant evaluating candidate-role fit at the strategic level.

You are NOT doing keyword matching. You are reading the job description to understand the ACTUAL PROBLEM the hiring manager is trying to solve, then assessing whether this candidate's career narrative and proof points address that problem.

SCORING FRAMEWORK:
- 20-25: The role's core mandate maps directly to one of the candidate's signature problems, AND 2+ proof anchors provide direct evidence. A retained search firm would present this candidate.
- 12-19: Adjacent fit — the mandate relates to the candidate's experience but isn't a direct signature problem match. 1 strong proof anchor applies.
- 5-11: Weak fit — some skill overlap but the fundamental problem being solved is different from what this candidate has demonstrated.
- 0-4: Different problem space. The role needs something this candidate's narrative doesn't address.

Be honest. A score of 12-15 for a role that's adjacent is more useful than an inflated 22 for a mediocre fit. The candidate benefits from accurate assessment, not flattery.`;
}

// ── User Prompt ─────────────────────────────────────────────────

function buildAssessorUserPrompt(jdText: string, ens: Record<string, any>): string {
  const sections: string[] = [];

  sections.push(`## JOB DESCRIPTION\n${jdText.substring(0, 3000)}`);

  sections.push(`## CANDIDATE'S EXECUTIVE NARRATIVE SPINE

**Core Identity:** ${ens.core_identity}

**Signature Problems (the recurring problems this candidate solves):**`);
  for (const sp of ens.signature_problems || []) {
    sections.push(`  ${sp.id}. ${sp.label}: ${sp.description}`);
  }

  sections.push(`\n**Proof Anchors (highest-impact evidence):**`);
  for (const pa of ens.proof_anchors || []) {
    sections.push(`  ${pa.id}. ${pa.label}: ${pa.summary}`);
  }

  sections.push(`\n**Transformation Thread:** ${ens.transformation_thread}
**Differentiator:** ${ens.differentiator}`);

  sections.push(`\n## TASK
Analyze the JD and produce a StrategicFitAssessment JSON:
1. What problem is this role ACTUALLY trying to solve? (Not just the title — read between the lines.)
2. Which signature problem does that map to? How confident are you?
3. Which proof anchors are relevant? Rate each one.
4. Does the transformation thread and differentiator resonate with this role?
5. Score the strategic fit 0-25 using the framework above.
6. Note any risks or gaps.

Return ONLY the JSON.`);

  return sections.join("\n\n");
}

// ── Main Function ───────────────────────────────────────────────

export interface StrategicFitInput {
  jdText: string;
  ens: Record<string, any>;
  logger?: any;
}

export async function assessStrategicFit(
  input: StrategicFitInput,
): Promise<{ assessment: StrategicFitAssessment; duration_ms: number }> {
  const start = Date.now();
  const { logger } = input;

  logger?.info(`🎯 [StrategicFit] Assessing strategic fit...`);

  const provider = resolveProvider();

  const result = await generateObject({
    model: provider.instance,
    schema: StrategicFitSchema,
    system: buildAssessorSystemPrompt(),
    prompt: buildAssessorUserPrompt(input.jdText, input.ens),
    temperature: 0.3,
    maxTokens: 1500,
  });

  const assessment = result.object;
  const duration = Date.now() - start;

  logger?.info(`🎯 [StrategicFit] Score: ${assessment.strategic_score}/25 | Mandate maps to: ${assessment.primary_mandate_problem.mapped_signature_problem} (${assessment.primary_mandate_problem.mapping_confidence})`);
  logger?.info(`🎯 [StrategicFit] Proof anchors: ${assessment.proof_anchor_relevance.map(p => `${p.anchor_id}=${p.relevance}`).join(", ")}`);

  return { assessment, duration_ms: duration };
}
