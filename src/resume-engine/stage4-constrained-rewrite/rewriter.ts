/**
 * Stage 4: Constrained Rewrite
 *
 * Produces a DraftResume with claim ID citations by calling the LLM
 * with structured output. Wraps the existing prompt builders and adds
 * claim_ids[] to every bullet.
 *
 * Type: LLM (structured output via generateObject)
 */

import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import {
  TailoredResumeSchema,
  buildResumeSystemPrompt,
  buildResumeUserPrompt,
  type TailoredResume,
} from "../../mastra/tools/tailoredResumePrompt";
import {
  TailoredCoverLetterSchema,
  buildCoverLetterSystemPrompt,
  buildCoverLetterUserPrompt,
  type TailoredCoverLetter,
} from "../../mastra/tools/tailoredCoverLetterPrompt";
import { compressResume } from "../../mastra/tools/resumeCompressor";
import {
  getArchetypeSummaryFraming,
} from "../../mastra/tools/resumeDivergenceEnforcer";
import type { MandateProfile } from "../stage2-mandate-classifier/classifier";
import type { ScoredBulletPlan, ClarificationQuestion, AttemptRecord } from "../types";
import type { Violation, LineItemFix, VerifierReport } from "../../mastra/tools/truthfulnessVerifier";

// ── OpenAI Client ────────────────────────────────────────────────

let _openai: ReturnType<typeof createOpenAI> | null = null;
function getOpenAI() {
  if (!_openai) {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI API key not configured.");
    _openai = createOpenAI({ apiKey });
  }
  return _openai;
}

// ── Safe Generate Object (with retries) ──────────────────────────

async function safeGenerateObject<T extends z.ZodTypeAny>(opts: {
  schema: T;
  system: string;
  prompt: string;
  temperature: number;
  label: string;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<z.infer<T>> {
  const { schema, system, prompt, temperature, label, timeoutMs = 120_000, maxRetries = 2 } = opts;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 30_000);
      await new Promise(r => setTimeout(r, backoffMs));
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const { object } = await generateObject({
        model: getOpenAI()("gpt-4o"),
        schema,
        system,
        prompt,
        temperature,
        abortSignal: controller.signal,
      });

      clearTimeout(timer);
      return object;
    } catch (err: any) {
      const msg = err.message || String(err);

      if (err.name === "AbortError" || msg.includes("abort")) {
        throw new Error(`[${label}] LLM timed out. Prompt may be too large (${prompt.length} chars).`);
      }
      if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("API key")) {
        throw new Error(`[${label}] OpenAI API key is invalid.`);
      }

      if (msg.includes("429") || msg.includes("rate") || msg.includes("Rate limit")) {
        lastError = new Error(`[${label}] Rate limited`);
        continue;
      }
      if (msg.includes("did not match schema") || msg.includes("No object generated")) {
        if (attempt < maxRetries) { lastError = new Error(`[${label}] Schema validation failed`); continue; }
      }
      if (msg.includes("500") || msg.includes("502") || msg.includes("503")) {
        if (attempt < maxRetries) { lastError = new Error(`[${label}] Server error`); continue; }
      }

      throw new Error(`[${label}] LLM call failed: ${msg.substring(0, 500)}`);
    }
  }

  throw lastError || new Error(`[${label}] All attempts failed`);
}

// ── Mandate Context Builder ──────────────────────────────────────

function buildMandateContext(
  mandate: MandateProfile,
  bulletPlan: ScoredBulletPlan,
): string {
  const top3 = mandate.top_3_archetypes
    .map((a, i) => `  ${i + 1}. ${a.label} (${a.score}/5)`)
    .join("\n");

  const archetypeScores = mandate.dimensions
    .filter(d => d.weight >= 0.1)
    .map(d => `  - ${d.label}: ${d.score_0_5}/5`)
    .join("\n");

  const topBulletsByRole: Record<string, string[]> = {};
  for (const bullet of bulletPlan.scored_bullets.filter(b => b.total_relevance > 0)) {
    if (!topBulletsByRole[bullet.experience_id]) topBulletsByRole[bullet.experience_id] = [];
    topBulletsByRole[bullet.experience_id].push(bullet.bullet_id);
  }
  const bulletRanking = Object.entries(topBulletsByRole)
    .map(([expId, ids]) => `  ${expId}: [${ids.slice(0, 6).join(", ")}]`)
    .join("\n");

  const gapLines = bulletPlan.mandate_gaps
    .map(g => `  - "${g.label}" (weight ${(g.weight * 5).toFixed(1)}/5): ${g.suggestion}`)
    .join("\n");

  const tone = mandate.tone_guidance;

  return `## MANDATE ARCHETYPE CLASSIFICATION
Primary mandate: ${mandate.primary_mandate.replace(/_/g, " ").toUpperCase()}
Seniority: ${mandate.seniority_level}
Headline: "${mandate.calibrated_headline}"

### Top 3 Archetypes
${top3}

### All Archetype Scores (0-5)
${archetypeScores}

### TONE CALIBRATION (${tone.seniority})
- Summary: ${tone.summary_posture}
- Bullets: ${tone.bullet_framing}
- Competencies: ${tone.competency_emphasis}
- Headline: ${tone.headline_tone}

### Bullet Order by Role (most relevant first)
${bulletRanking}

### First 2 bullets per role must align with top 3 archetypes.

${bulletPlan.mandate_gaps.length > 0 ? `### MANDATE GAPS — DO NOT FABRICATE
${gapLines}` : "### No mandate gaps."}

### HEADLINE CALIBRATION
${mandate.seniority_level === "Sr Director" || mandate.seniority_level === "Director"
    ? `Role is ${mandate.seniority_level} level. Do NOT use C-Suite titles. Use: "${mandate.calibrated_headline}".`
    : `Role is ${mandate.seniority_level} level. Headline "${mandate.calibrated_headline}" is appropriate.`}

### CLAIM ID CITATION REQUIREMENT
For every resume bullet, include a claim_ids array with the Claims Ledger IDs that back the bullet.
These are IDs like "cl-0-metric-1", "cl-1-tool-2", etc. from the inventory.
If you cannot find claim IDs for a bullet, include an empty array — but prefer bullets that CAN be cited.`;
}

// ── Correction Prompt Builder ────────────────────────────────────

export function buildCorrectionPrompt(
  docType: "resume" | "cover_letter",
  previousJson: string,
  violations: Violation[],
  fixes: LineItemFix[],
  attemptNumber: number,
): string {
  const criticals = violations.filter(v => v.severity === "critical");
  const warnings = violations.filter(v => v.severity === "warning");

  const violationDetails = criticals
    .map((v, i) => `${i + 1}. [${v.type}] at ${v.location}\n   Found: "${v.found_value}"\n   Problem: ${v.explanation}${v.expected ? `\n   Expected: "${v.expected}"` : ""}`)
    .join("\n");

  const fixDetails = fixes.slice(0, 10)
    .map((f, i) => `${i + 1}. at ${f.location}\n   Current: "${f.current_text.substring(0, 120)}"\n   Suggested: "${f.suggested_text.substring(0, 120)}"\n   Reason: ${f.reason}`)
    .join("\n");

  const warningDetails = warnings.length > 0
    ? `\n\n## WARNINGS (fix if possible)\n${warnings.map((w, i) => `${i + 1}. [${w.type}] at ${w.location}: ${w.explanation}`).join("\n")}`
    : "";

  return `## CORRECTION REQUIRED — Attempt ${attemptNumber}

Previous ${docType === "resume" ? "TailoredResume" : "TailoredCoverLetter"} FAILED with ${criticals.length} critical violation(s).

## PREVIOUS OUTPUT
${previousJson}

## CRITICAL VIOLATIONS TO FIX
${violationDetails}

## SUGGESTED FIXES
${fixDetails}
${warningDetails}

## INSTRUCTIONS
1. Fix EVERY critical violation.
2. NEW_ENTITY: Replace with allowlisted entity or remove.
3. UNSUPPORTED_METRIC: Replace with allowlisted metric or remove number.
4. PLACEHOLDER: Remove all placeholder text.
5. INCONSISTENT_DATE: Use only allowlisted dates.
6. STYLE_RULE_BROKEN: Ensure every bullet has source_hash + evidence_quote. Confidence >= 0.7.
7. ATS_RISK: Remove tables/special chars, add ATS keywords.
8. Do NOT introduce new violations.
9. Return ONLY the corrected JSON.`;
}

// ── Main Rewriter ────────────────────────────────────────────────

export interface RewriteInput {
  inventory: Record<string, any>;
  allowlist: Record<string, any>;
  requirements: Record<string, any>;
  title: string;
  company: string;
  mandate: MandateProfile;
  bulletPlan: ScoredBulletPlan;
  companyContext?: string;
  divergencePrompt?: string;
  correctionContext?: {
    previousResume: TailoredResume;
    previousCoverLetter: TailoredCoverLetter;
    report: VerifierReport;
    attemptNumber: number;
  };
}

export interface RewriteResult {
  resume: TailoredResume;
  coverLetter: TailoredCoverLetter;
  duration_ms: number;
}

/**
 * Execute the constrained rewrite stage.
 * Generates resume + cover letter with LLM, runs compression, handles corrections.
 */
export async function constrainedRewrite(input: RewriteInput): Promise<RewriteResult> {
  const start = Date.now();

  const mandateContext = buildMandateContext(input.mandate, input.bulletPlan);
  const archetypeFraming = getArchetypeSummaryFraming(input.mandate);

  const resumeSystemPrompt = buildResumeSystemPrompt();
  const resumeUserPrompt = buildResumeUserPrompt(
    input.inventory, input.allowlist, input.requirements, input.title, input.company,
  ) + "\n\n" + mandateContext + "\n\n" + archetypeFraming;

  const clSystemPrompt = buildCoverLetterSystemPrompt();
  const clUserPrompt = buildCoverLetterUserPrompt(
    input.inventory, input.allowlist, input.requirements, input.title, input.company, input.companyContext,
  );

  let resume: TailoredResume;
  let coverLetter: TailoredCoverLetter;

  if (input.correctionContext) {
    const { previousResume, previousCoverLetter, report, attemptNumber } = input.correctionContext;
    const resumeViolations = report.violations.filter(v => v.location.startsWith("resume"));
    const resumeFixes = report.line_item_fixes.filter(f => f.location.startsWith("resume"));
    const clViolations = report.violations.filter(v => v.location.startsWith("cover_letter"));
    const clFixes = report.line_item_fixes.filter(f => f.location.startsWith("cover_letter"));

    if (resumeViolations.length > 0) {
      const corrPrompt = buildCorrectionPrompt("resume", JSON.stringify(previousResume, null, 2), resumeViolations, resumeFixes, attemptNumber);
      resume = await safeGenerateObject({
        schema: TailoredResumeSchema,
        system: resumeSystemPrompt,
        prompt: `${resumeUserPrompt}\n\n${corrPrompt}`,
        temperature: 0.2,
        label: `resume-correction-attempt${attemptNumber}`,
      });
    } else {
      resume = previousResume;
    }

    if (clViolations.length > 0) {
      const corrPrompt = buildCorrectionPrompt("cover_letter", JSON.stringify(previousCoverLetter, null, 2), clViolations, clFixes, attemptNumber);
      coverLetter = await safeGenerateObject({
        schema: TailoredCoverLetterSchema,
        system: clSystemPrompt,
        prompt: `${clUserPrompt}\n\n${corrPrompt}`,
        temperature: 0.2,
        label: `coverLetter-correction-attempt${attemptNumber}`,
      });
    } else {
      coverLetter = previousCoverLetter;
    }
  } else {
    // Initial generation
    let finalPrompt = resumeUserPrompt;
    if (input.divergencePrompt) finalPrompt += "\n\n" + input.divergencePrompt;

    resume = await safeGenerateObject({
      schema: TailoredResumeSchema,
      system: resumeSystemPrompt,
      prompt: finalPrompt,
      temperature: 0.3,
      label: "resume-initial",
    });

    coverLetter = await safeGenerateObject({
      schema: TailoredCoverLetterSchema,
      system: clSystemPrompt,
      prompt: clUserPrompt,
      temperature: 0.4,
      label: "coverLetter-initial",
    });
  }

  // Run compression pass (mandate-aware)
  compressResume(resume, input.mandate);

  return {
    resume,
    coverLetter,
    duration_ms: Date.now() - start,
  };
}
