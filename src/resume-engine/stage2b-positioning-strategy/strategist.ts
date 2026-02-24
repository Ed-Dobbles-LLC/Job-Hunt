/**
 * Stage 2b: Strategic Positioning Reasoning
 *
 * Runs AFTER mandate classification (Stage 2) and BEFORE generation (Stage 4).
 * Produces a PositioningBrief that tells the generator:
 *   - Which narrative angle to lead with
 *   - Which inventory roles/bullets to emphasize
 *   - What story arc to build across the resume
 *   - What makes this candidate rare for THIS specific role
 *   - What NOT to emphasize (anti-patterns for this mandate)
 *
 * This replaces the human-in-the-loop strategic thinking that happens
 * in the interactive Claude project but was missing from the automated pipeline.
 *
 * Type: LLM (lightweight reasoning call — uses the "light" concurrency lane)
 */

import { z } from "zod";
import { resilientGenerateObject } from "../llm-retry";
import type { MandateProfile } from "../stage2-mandate-classifier/classifier";
import type { ScoredBulletPlan } from "../types";
import type { CompanyResearch } from "../stage2c-company-research/researcher";

// ── Schema ──────────────────────────────────────────────────────

export const PositioningBriefSchema = z.object({
  narrative_angle: z.string().describe(
    "The primary narrative angle for this application. One sentence: what story are we telling? E.g., 'The enterprise architect who built governance from scratch at three Fortune 500s and can do it again here.'"
  ),
  lead_with: z.array(z.string()).min(1).max(3).describe(
    "Top 1-3 inventory roles or achievements to emphasize most heavily. Reference by employer name."
  ),
  story_arc: z.string().describe(
    "The career story arc across all roles. 2-3 sentences tracing the pattern. E.g., 'Started as a hands-on data architect, scaled to leading 45-person orgs, now operates at the intersection of data strategy and business transformation.'"
  ),
  rare_combination: z.string().describe(
    "What makes this candidate unusual for this type of role. The specific combination of skills/experience that is rare at this level. E.g., 'Executive who has done both platform architecture AND org design at enterprise scale — most candidates have one or the other.'"
  ),
  summary_thesis: z.string().describe(
    "The thesis statement for the executive summary's first sentence. This should be mandate-anchored and specific. Not a generic opener."
  ),
  de_emphasize: z.array(z.string()).max(3).describe(
    "What to de-emphasize or avoid leading with. E.g., 'Revenue metrics — this is a governance play, not a revenue play.'"
  ),
  cover_letter_hook: z.string().describe(
    "The opening hook for the cover letter. What should the first sentence convey? E.g., 'Lead with the Snowflake consolidation story — it directly mirrors what they need.'"
  ),
  company_alignment: z.string().optional().describe(
    "If company research is available, how to position the candidate specifically for this company's situation. E.g., 'They just acquired two brands — lead with multi-BU consolidation experience.'"
  ),
  positioning_warnings: z.array(z.string()).max(5).describe(
    "Potential pitfalls or risks in positioning. E.g., 'Candidate never held a Chief title — frame as VP-level with C-suite impact scope.'"
  ),
});
export type PositioningBrief = z.infer<typeof PositioningBriefSchema>;

// ── Input ───────────────────────────────────────────────────────

export interface StrategistInput {
  /** Job title */
  title: string;
  /** Company name */
  company: string;
  /** Mandate classification from Stage 2 */
  mandate: MandateProfile;
  /** Scored bullet plan from Stage 3 */
  bulletPlan: ScoredBulletPlan;
  /** Raw JD text for context */
  jdText: string;
  /** Experience inventory (full) */
  inventory: Record<string, any>;
  /** Company research if available (Phase 3) */
  companyResearch?: CompanyResearch;
  /** Successful positioning patterns from feedback loop (Phase 4) */
  priorSuccessPatterns?: string[];
  /** Logger */
  logger?: any;
}

// ── System Prompt ───────────────────────────────────────────────

function buildStrategistSystemPrompt(): string {
  return `You are a retained executive search strategist. Before writing a resume, you reason about positioning strategy.

Your job is to analyze a job description, mandate classification, and candidate inventory, then produce a PositioningBrief that guides the resume writer.

Think like a senior recruiter who has placed 200+ executives. You're not writing the resume — you're deciding the ANGLE before writing begins.

RULES:
- Be specific. "Lead with governance" is useless. "Lead with the Snowflake data governance framework he built at Overproof that standardized reporting across 6 BUs" is useful.
- Reference actual inventory content. You have the full inventory — cite specific roles, bullets, and achievements.
- The narrative_angle should be ONE clear thesis, not a list of everything the candidate can do.
- The rare_combination should identify what makes this candidate genuinely unusual — not generic "leadership + technical" claims.
- Be honest about positioning_warnings. If there's a gap, name it.
- If company research is provided, use it to sharpen positioning. Generic advice when company context exists is a failure.`;
}

// ── User Prompt ─────────────────────────────────────────────────

function buildStrategistUserPrompt(input: StrategistInput): string {
  const sections: string[] = [];

  sections.push(`## TARGET ROLE
Title: ${input.title}
Company: ${input.company}

## JOB DESCRIPTION
${input.jdText.substring(0, 4000)}

## MANDATE CLASSIFICATION
Primary: ${input.mandate.primary_mandate}
Secondary: ${input.mandate.secondary_mandates?.join(", ") || "none"}
Seniority: ${input.mandate.seniority_level}
Headline: ${input.mandate.calibrated_headline}`);

  // Top scored bullets for context
  const topBullets = input.bulletPlan.scored_bullets
    .slice(0, 15)
    .map(b => `  [${b.total_relevance.toFixed(2)}] ${b.experience_id}: ${b.bullet_text.substring(0, 100)}`)
    .join("\n");
  sections.push(`## TOP SCORED BULLETS (by mandate relevance)
${topBullets}`);

  // Mandate gaps
  if (input.bulletPlan.mandate_gaps.length > 0) {
    sections.push(`## MANDATE GAPS (requirements we can't fully address)
${input.bulletPlan.mandate_gaps.map(g => `  - ${g.label} (coverage: ${g.best_coverage}): ${g.suggestion}`).join("\n")}`);
  }

  // Inventory summary (roles only, not full bullets)
  const roles = (input.inventory.experience || []).map((exp: any) =>
    `  - ${exp.title} at ${exp.employer} (${exp.start_date}–${exp.end_date || "present"}): ${exp.bullets?.length || 0} bullets`
  ).join("\n");
  sections.push(`## CANDIDATE ROLES
${roles}`);

  // Company research if available
  if (input.companyResearch) {
    sections.push(`## COMPANY RESEARCH
Industry: ${input.companyResearch.industry || "unknown"}
Size: ${input.companyResearch.company_size || "unknown"}
Recent News: ${input.companyResearch.recent_developments?.join("; ") || "none available"}
Tech Stack: ${input.companyResearch.tech_stack?.join(", ") || "unknown"}
Culture Signals: ${input.companyResearch.culture_signals?.join("; ") || "none available"}
Challenges: ${input.companyResearch.likely_challenges?.join("; ") || "none identified"}`);
  }

  // Prior success patterns from feedback loop
  if (input.priorSuccessPatterns && input.priorSuccessPatterns.length > 0) {
    sections.push(`## SUCCESSFUL POSITIONING PATTERNS (from prior rated outputs)
${input.priorSuccessPatterns.map(p => `  - ${p}`).join("\n")}`);
  }

  sections.push(`## TASK
Produce a PositioningBrief JSON. Think strategically about what angle will win for THIS specific role at THIS specific company. Be specific — reference actual inventory content.`);

  return sections.join("\n\n");
}

// ── Main Function ───────────────────────────────────────────────

/**
 * Generate a strategic positioning brief for the application.
 *
 * This is the "think before you write" step that replaces
 * human strategic reasoning in the interactive project.
 */
export async function generatePositioningBrief(
  input: StrategistInput,
): Promise<{ brief: PositioningBrief; duration_ms: number }> {
  const start = Date.now();
  const { logger } = input;

  logger?.info(`🧠 [Strategist] Generating positioning brief for ${input.company} — ${input.title}`);

  const result = await resilientGenerateObject({
    schema: PositioningBriefSchema,
    system: buildStrategistSystemPrompt(),
    prompt: buildStrategistUserPrompt(input),
    temperature: 0.7,
    label: "Stage 2b: Positioning Strategy",
    lane: "light",
    maxTokens: 2000,
    logger,
  });

  const brief = result.object;
  const duration = Date.now() - start;

  logger?.info(`🧠 [Strategist] Brief generated in ${duration}ms`);
  logger?.info(`🧠 [Strategist] Angle: ${brief.narrative_angle}`);
  logger?.info(`🧠 [Strategist] Lead with: ${brief.lead_with.join(", ")}`);
  logger?.info(`🧠 [Strategist] De-emphasize: ${brief.de_emphasize.join(", ")}`);

  return { brief, duration_ms: duration };
}
