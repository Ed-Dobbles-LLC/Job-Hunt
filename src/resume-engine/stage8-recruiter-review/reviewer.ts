/**
 * Stage 8: Recruiter Review
 *
 * Automated QA step that mimics a skeptical recruiter reviewing the final
 * resume + cover letter packet. Uses LLM (gpt-4o) with structured output
 * to return a RecruiterReviewReport with PASS/FAIL, categorized issues,
 * dimension scores, and actionable fixes.
 *
 * This is NOT a rewrite step — it is a review/audit that returns structured
 * feedback. A separate repair loop in the pipeline uses the feedback to
 * drive constrained corrections.
 *
 * Type: LLM (audit independence from the generation model)
 *
 * Checks:
 *   1. Truthfulness — new numbers, tools, or claims not in Claims Ledger
 *   2. Ownership inflation — scope escalation beyond inventory evidence
 *   3. Writing defects — corrupted words, typos, tense inconsistency
 *   4. Generic summary — templated opener lacking mandate specificity
 *   5. Repeated phrases — cross-section duplicates
 *   6. Vague claims — bullets without concrete impact
 *   7. Mandate mismatch — summary/top bullets misaligned with JD mandates
 *   8. Aesthetics — density, scannability, section rhythm, page band
 *   9. Cover letter — word count, generic enthusiasm, resume contradiction
 */

import { resilientGenerateObject } from "../llm-retry";
import { RecruiterReviewReportSchema, type RecruiterReviewReport } from "../types";
import type { ClaimsLedger } from "../types";
import type { MandateProfile } from "../types";
import type { TailoredResume } from "../../mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../../mastra/tools/tailoredCoverLetterPrompt";
import type { VerifierReport } from "../../mastra/tools/truthfulnessVerifier";

// ── Interfaces ──────────────────────────────────────────────────

export interface RecruiterReviewInput {
  /** Claims ledger from stage 1 */
  claimsLedger: ClaimsLedger;
  /** Mandate profile from stage 2 */
  mandateProfile: MandateProfile;
  /** Truth audit report from stage 7 */
  truthAuditReport: VerifierReport;
  /** Layout governor report from stage 6 */
  layoutReport: Record<string, any>;
  /** Raw JD text */
  jdText: string;
  /** Final plaintext resume (post stage 6) */
  plaintextResume: string;
  /** Final resume JSON (post stage 6) */
  resume: TailoredResume;
  /** Cover letter JSON (post stage 6) */
  coverLetter: TailoredCoverLetter;
  /** Last 3 resume summaries from resume_history for differentiation check */
  priorSummaries?: string[];
  /** Logger for structured telemetry */
  logger?: any;
}

export interface RecruiterReviewResult {
  report: RecruiterReviewReport;
  duration_ms: number;
}

// ── Prompt Builder ──────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a SKEPTICAL senior technical recruiter performing a final quality audit on a tailored resume and cover letter. Your job is to catch every issue that would make a hiring manager question the candidate's credibility, clarity, or fit.

## YOUR ROLE
You are the LAST line of defense before this packet goes to a real recruiter. Be rigorous. Be specific. Do not let mediocre work pass.

## GROUNDING RULES (CRITICAL)
Every claim in the resume MUST trace to the Claims Ledger provided. You will receive the full Claims Ledger JSON. If you find ANY of the following, flag as a CRITICAL issue:

1. **New numbers not in ledger** — Any metric ($X, Y%, Z people, Nx improvement) in the resume that does not appear in the Claims Ledger metrics or bullet_texts. This is fabrication.
2. **New tools/platforms not in ledger** — Any technology, platform, or tool mentioned that is not in the Claims Ledger tools list. This is hallucination.
3. **Board/investment/strategic pivot attribution** — Claims like "catalyzed board pivot", "drove 50% AI investment increase", "secured $XM funding" that do not appear verbatim or substantively in the ledger. This is ownership inflation.
4. **Ownership inflation language** — Verbs that escalate scope beyond what the source bullet supports: "catalyzed", "revolutionized", "single-handedly built", "transformed the organization". Compare draft language against ledger bullet_texts.

## WRITING DEFECT CHECKS
5. **Corrupted words** — Doubled suffixes (e.g., "Influencedd", "implementeded", "managinging"), orphaned fragments, non-ASCII artifacts. These come from automated string manipulation errors. Flag EVERY instance.
6. **Typos** — Misspelled words, wrong word forms, missing articles.
7. **Inconsistent tense** — All experience bullets should use past tense. Current role may use present tense. Mixed tense within a role is a defect.
8. **Generic summary template** — The professional summary's first sentence must be a mandate-specific thesis, NOT a generic opener like "Executive with track record...", "Data leader who has...", "Seasoned professional with...". These are FAIL signals.
9. **Repeated phrases** — The same 4+ word phrase appearing in different sections (summary and bullets, or across different roles). Shows lazy generation.
10. **Vague claims** — Bullets without concrete impact metrics or specific scope. "Improved processes" without numbers is vague.

## MANDATE ALIGNMENT CHECKS
11. **Summary first sentence** — Must anchor to the job's PRIMARY mandate archetype. Check against the MandateProfile.
12. **First 2 bullets of most recent role** — Must address the job's top 2 mandate dimensions. If they discuss irrelevant achievements, flag as MANDATE_MISMATCH.

## DIFFERENTIATION CHECKS
13. **Prior resume similarity** — If prior summaries are provided, the current summary must NOT be >30% similar to any of them. Check for formulaic repetition.

## AESTHETICS CHECKS
14. **Dense summary** — More than 5 lines at 85 chars/line signals over-packing.
15. **Competency bloat** — More than 10 core competencies signals lack of curation.
16. **Page band** — Senior roles should target 1.6–2.0 pages. Use the layout report's page estimate.
17. **Section rhythm** — Most recent role should have 3-4 bullets, older roles 2-3. Single-bullet roles look thin.

## COVER LETTER CHECKS
18. **Word count** — Must be 250-350 words. Outside this range is a defect.
19. **Generic enthusiasm** — Phrases like "excited to apply", "passionate about", "I would be honored" are FAIL signals.
20. **Resume contradiction** — Cover letter value claims must align with resume bullets, not introduce new achievements.

## SCORING GUIDE
- **truthfulness** (0-100): 100 = every claim grounded. Deduct 20 per ungrounded metric, 15 per ungrounded tool, 25 per ownership inflation.
- **ownership_inflation** (0-100): 100 = no inflation. Deduct 25 per escalation pattern detected.
- **mandate_alignment** (0-100): 100 = summary + top bullets perfectly match top mandates. Deduct 20 per misaligned section.
- **differentiation** (0-100): 100 = unique, specific, non-templated. Deduct 15 per generic/repeated element.
- **readability** (0-100): 100 = flawless prose. Deduct 10 per corrupted word, 5 per tense issue, 5 per vague claim.
- **aesthetics** (0-100): 100 = polished layout. Deduct 10 per density/rhythm issue.

## PASS/FAIL RULES
- **FAIL** if ANY critical_issues exist.
- **FAIL** if truthfulness < 80 OR ownership_inflation < 80.
- **FAIL** if any corrupted words are found.
- **PASS** only if zero critical issues AND all scores >= 70.

## safe_rewrite_allowed
Set to true ONLY if all issues can be fixed by text manipulation (word replacement, bullet trimming, reordering) without requiring new information from the candidate.`;
}

function buildUserPrompt(input: RecruiterReviewInput): string {
  const ledgerSummary = buildLedgerSummary(input.claimsLedger);
  const mandateSummary = buildMandateSummary(input.mandateProfile);
  const truthAuditSummary = buildTruthAuditSummary(input.truthAuditReport);
  const layoutSummary = buildLayoutSummary(input.layoutReport);
  const priorSummarySection = input.priorSummaries?.length
    ? `\n## PRIOR RESUME SUMMARIES (for differentiation check)\n${input.priorSummaries.map((s, i) => `### Resume ${i + 1}\n${s}`).join("\n\n")}`
    : "";

  return `## JOB DESCRIPTION
${input.jdText}

## CLAIMS LEDGER (source of truth)
${ledgerSummary}

## MANDATE PROFILE
${mandateSummary}

## TRUTH AUDIT REPORT (from Stage 7)
${truthAuditSummary}

## LAYOUT GOVERNOR REPORT (from Stage 6)
${layoutSummary}
${priorSummarySection}

## RESUME (plaintext — this is what the recruiter sees)
${input.plaintextResume}

## COVER LETTER
Salutation: ${input.coverLetter.salutation}
Opening: ${input.coverLetter.opening_paragraph}
Body: ${input.coverLetter.body_paragraphs.join("\n\n")}
Closing: ${input.coverLetter.closing_paragraph}
Sign-off: ${input.coverLetter.sign_off}
Word count: ${input.coverLetter.word_count}

## INSTRUCTIONS
Review the resume and cover letter against ALL checks described in your system instructions. Be skeptical and thorough. Return your structured report.`;
}

// ── Ledger Summary Builders ─────────────────────────────────────

function buildLedgerSummary(ledger: ClaimsLedger): string {
  const sections: string[] = [];

  sections.push(`Total claims: ${ledger.total_claims}`);

  if (ledger.metrics.length > 0) {
    sections.push(`### Metrics (${ledger.metrics.length})\n${ledger.metrics.map(m => `- ${m.value} [${m.id}]`).join("\n")}`);
  }

  if (ledger.tools.length > 0) {
    sections.push(`### Tools (${ledger.tools.length})\n${ledger.tools.map(t => `- ${t.value} [${t.id}]`).join("\n")}`);
  }

  if (ledger.roles.length > 0) {
    sections.push(`### Roles (${ledger.roles.length})\n${ledger.roles.map(r => `- ${r.value} [${r.id}]`).join("\n")}`);
  }

  if (ledger.scopes.length > 0) {
    sections.push(`### Scope Claims (${ledger.scopes.length})\n${ledger.scopes.map(s => `- ${s.value} [${s.id}]`).join("\n")}`);
  }

  if (ledger.bullet_texts.length > 0) {
    sections.push(`### Bullet Texts (${ledger.bullet_texts.length})\n${ledger.bullet_texts.map(b => `- ${b.value.substring(0, 120)}${b.value.length > 120 ? "..." : ""} [${b.id}]`).join("\n")}`);
  }

  return sections.join("\n\n");
}

function buildMandateSummary(mandate: MandateProfile): string {
  const top3 = mandate.top_3_archetypes
    .map(a => `${a.label} (score: ${a.score})`)
    .join(", ");

  return `Primary mandate: ${mandate.primary_mandate}
Secondary mandates: ${mandate.secondary_mandates.join(", ")}
Top 3 archetypes: ${top3}
Seniority level: ${mandate.seniority_level}
Calibrated headline: ${mandate.calibrated_headline}
Tone guidance: summary_posture="${mandate.tone_guidance.summary_posture}", bullet_framing="${mandate.tone_guidance.bullet_framing}"
Gaps vs inventory: ${mandate.gaps_vs_inventory.length > 0 ? mandate.gaps_vs_inventory.join("; ") : "None"}`;
}

function buildTruthAuditSummary(report: VerifierReport): string {
  const lines = [
    `Pass: ${report.pass}`,
    `Total checks: ${report.stats.total_checks}`,
    `Critical violations: ${report.stats.critical_violations}`,
    `Warnings: ${report.stats.warnings}`,
  ];

  if (report.violations.length > 0) {
    lines.push(`\n### Violations (${report.violations.length})`);
    for (const v of report.violations.slice(0, 20)) {
      lines.push(`- [${v.severity.toUpperCase()}] ${v.type} at ${v.location}: ${v.explanation}`);
    }
  }

  return lines.join("\n");
}

function buildLayoutSummary(layoutReport: Record<string, any>): string {
  const lines: string[] = [];

  if (layoutReport.page_estimate) {
    lines.push(`Page estimate: ${layoutReport.page_estimate.estimated_pages} pages (${layoutReport.page_estimate.estimated_lines} lines)`);
  }
  if (layoutReport.page_band) {
    const pb = layoutReport.page_band;
    lines.push(`Page band: ${pb.actual} pages (target: ${pb.min}–${pb.max}) ${pb.in_band ? "IN BAND" : "OUT OF BAND"}`);
  }
  if (layoutReport.bullet_cap_result) {
    lines.push(`Bullet caps: ${layoutReport.bullet_cap_result.final_count} bullets (capped: ${layoutReport.bullet_cap_result.capped})`);
  }
  if (layoutReport.tone_violations?.length > 0) {
    lines.push(`Tone violations: ${layoutReport.tone_violations.length}`);
  }
  if (layoutReport.competency_capped !== undefined) {
    lines.push(`Competencies capped: ${layoutReport.competency_capped}`);
  }
  lines.push(`Blocked: ${layoutReport.blocked ?? false}`);

  return lines.join("\n");
}

// ── Main Reviewer ───────────────────────────────────────────────

/**
 * Run the Stage 8 Recruiter Review.
 *
 * Calls OpenAI gpt-4o with generateObject to produce a structured
 * RecruiterReviewReport. The model acts as a skeptical recruiter
 * auditing the final resume + cover letter against the Claims Ledger,
 * mandate profile, and writing quality standards.
 *
 * @param input - All context needed for the review
 * @returns RecruiterReviewResult with report and timing
 */
export async function runRecruiterReview(
  input: RecruiterReviewInput,
): Promise<RecruiterReviewResult> {
  const start = Date.now();

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  const result = await resilientGenerateObject({
    schema: RecruiterReviewReportSchema,
    system: systemPrompt,
    prompt: userPrompt,
    temperature: 0.2,
    label: "Stage 8: recruiter-review",
    lane: "medium",
    logger: input.logger,
  });

  return {
    report: result.object,
    duration_ms: Date.now() - start,
  };
}

// ── Repair Prompt Builder ───────────────────────────────────────

/**
 * Build a constrained repair prompt from the recruiter review report.
 * This is used by the pipeline to feed stage 4 (or a dedicated repair
 * function) with specific fixes from the reviewer.
 *
 * Only includes issues that are safe to auto-repair (text-level fixes).
 */
export function buildRepairContext(report: RecruiterReviewReport): {
  repairInstructions: string;
  fixCount: number;
} {
  const fixes: string[] = [];

  for (const issue of report.critical_issues) {
    fixes.push(`[CRITICAL] ${issue.type} at ${issue.location}:\n  Evidence: "${issue.evidence}"\n  Fix: ${issue.fix}`);
  }

  for (const issue of report.major_issues) {
    fixes.push(`[MAJOR] ${issue.type} at ${issue.location}:\n  Evidence: "${issue.evidence}"\n  Fix: ${issue.fix}`);
  }

  const repairInstructions = `## RECRUITER REVIEW REPAIR INSTRUCTIONS

The following issues were flagged by the Recruiter Review (Stage 8).
You MUST fix every CRITICAL and MAJOR issue below. Do NOT introduce new violations.

### Scores
- Truthfulness: ${report.scores.truthfulness}/100
- Ownership Inflation: ${report.scores.ownership_inflation}/100
- Mandate Alignment: ${report.scores.mandate_alignment}/100
- Differentiation: ${report.scores.differentiation}/100
- Readability: ${report.scores.readability}/100
- Aesthetics: ${report.scores.aesthetics}/100

### Issues to Fix (${fixes.length})
${fixes.join("\n\n")}

### Rules
1. Fix EVERY listed issue.
2. Do NOT add new metrics, tools, or claims not in the Claims Ledger.
3. Do NOT inflate ownership language.
4. Do NOT change any claim_ids or source_hash references.
5. Maintain the same JSON structure.
6. Return ONLY the corrected JSON.`;

  return { repairInstructions, fixCount: fixes.length };
}
