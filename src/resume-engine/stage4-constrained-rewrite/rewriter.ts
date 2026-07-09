/**
 * Stage 4: Constrained Rewrite
 *
 * Produces a DraftResume with claim ID citations by calling the LLM
 * with structured output. Wraps the existing prompt builders and adds
 * claim_ids[] to every bullet.
 *
 * Type: LLM (structured output via generateObject)
 */

import { resilientGenerateObject } from "../llm-retry";
import { BANNED_AI_ISMS } from "../token-heuristics.js";
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
import { isClaudeAvailable } from "../llm-provider";
import {
  buildStrategicResumeSystemPrompt,
  buildStrategicCoverLetterSystemPrompt,
  buildStrategicResumeUserPrompt,
} from "../strategic-prompt-builder";
import type { PositioningBrief } from "../stage2b-positioning-strategy/strategist";
import type { CompanyResearch } from "../stage2c-company-research/researcher";
import type { MandateProfile } from "../stage2-mandate-classifier/classifier";
import type { ScoredBulletPlan, ClarificationQuestion, AttemptRecord } from "../types";
import type { Violation, LineItemFix, VerifierReport } from "../../mastra/tools/truthfulnessVerifier";

// ── Generic Opener Detection ─────────────────────────────────────

const GENERIC_OPENER_PATTERNS: RegExp[] = [
  // Generic role-first patterns
  /^[A-Za-z\s&/,-]+ leader who has\b/i,
  /^[A-Za-z\s&/,-]+ executive who has\b/i,
  /^[A-Za-z\s&/,-]+ leader with\b/i,
  /^[A-Za-z\s&/,-]+ executive with\b/i,
  /^executive with a track record\b/i,
  /^seasoned\b/i,
  /^accomplished\b/i,
  /^results-driven\b/i,
  /^dynamic\b/i,
  /^innovative\b/i,
  /^passionate\b/i,
  /^strategic leader\b/i,
  /^visionary\b/i,
  /^highly experienced\b/i,
  /^[A-Za-z\s&/,-]+ professional who\b/i,
  /^[A-Za-z\s&/,-]+ professional with\b/i,
  /^analytics executive transforming\b/i,
  /^data (?:&|and) analytics (?:leader|executive) (?:who|with|transforming)\b/i,
  // Descriptive/passive openers (not thesis-driven)
  /^career\s+marked\s+by\b/i,
  /^career\s+defined\s+by\b/i,
  /^track\s+record\s+of\b/i,
  /^known\s+for\b/i,
  /^the\s+board'?s?\s+decision\s+was\s+driven\s+by\b/i,
  /^with\s+(?:over|more than|\d+)\s+years?\b/i,
  /^proven\s+ability\s+to\b/i,
  /^extensive\s+experience\s+in\b/i,
  /^dedicated\s+(?:\w+\s+)?(?:leader|executive|professional)/i,
];

/**
 * Detect if the resume summary opens with a generic/banned pattern.
 * Returns the matched pattern text, or null if the opener is clean.
 */
function detectGenericOpener(summary: string): string | null {
  const firstSentence = summary.split(/[.!?]\s/)[0] || summary;
  for (const pattern of GENERIC_OPENER_PATTERNS) {
    const match = firstSentence.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * Validate ATS keywords by checking they actually appear in the resume text.
 * Returns the list of keywords NOT found in the resume.
 */
function validateAtsKeywords(resume: TailoredResume): string[] {
  const resumeText = [
    resume.professional_summary,
    ...(resume.core_competencies || []),
    ...resume.experience.flatMap(e => [
      e.title, e.employer, e.scope_line || "",
      ...e.bullets.map(b => b.text),
    ]),
    ...((resume.skills as any)?.tools_and_platforms || []),
    ...((resume.skills as any)?.enterprise_capabilities || []),
  ].join(" ").toLowerCase();

  return resume.ats_keywords_used.filter(kw => !resumeText.includes(kw.toLowerCase()));
}

/**
 * Detect if cover letter closely paraphrases resume bullet text.
 * Uses 4-gram overlap detection: if a 4-word sequence from a cover letter
 * paragraph matches a 4-word sequence from any resume bullet, flag it.
 */
function detectResumeRepetition(
  resume: TailoredResume,
  coverLetter: TailoredCoverLetter,
): { cl_phrase: string; resume_bullet: string }[] {
  const results: { cl_phrase: string; resume_bullet: string }[] = [];

  // Build set of 4-grams from all resume bullets
  const resumeNGrams = new Map<string, string>(); // 4-gram → source bullet text
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      const words = bullet.text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      for (let i = 0; i <= words.length - 4; i++) {
        const gram = words.slice(i, i + 4).join(" ");
        if (!resumeNGrams.has(gram)) {
          resumeNGrams.set(gram, bullet.text);
        }
      }
    }
  }

  // Check cover letter body paragraphs for matches
  const clTexts = [
    coverLetter.opening_paragraph,
    ...coverLetter.body_paragraphs,
  ];

  for (const clText of clTexts) {
    const words = clText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    for (let i = 0; i <= words.length - 4; i++) {
      const gram = words.slice(i, i + 4).join(" ");
      const sourceBullet = resumeNGrams.get(gram);
      if (sourceBullet) {
        results.push({
          cl_phrase: gram,
          resume_bullet: sourceBullet.substring(0, 80),
        });
        break; // One match per paragraph is enough to flag
      }
    }
  }

  return results;
}

// ── Cover Letter Enthusiasm & Structure Validation ───────────────

const GENERIC_ENTHUSIASM_PATTERNS: RegExp[] = [
  /\bi am (?:truly |deeply |very |genuinely )?excited\b/i,
  /\bi am (?:truly |deeply )?passionate about\b/i,
  /\bi am eager to\b/i,
  /\bi am thrilled\b/i,
  /\bthis role is (?:a |an )?(?:exciting|incredible|amazing|wonderful)\b/i,
  /\bwhat (?:a |an )?(?:exciting|incredible|amazing) opportunity\b/i,
  /\bi would (?:love|relish|welcome) the (?:chance|opportunity) to\b/i,
  /\bi can't wait to\b/i,
  /\bi am confident (?:that )?(?:i |my )\b/i,
  /\bthank you (?:so much )?for (?:your time|considering|this opportunity|reviewing)\b/i,
  /\bi (?:humbly |respectfully )?submit\b/i,
  /\bi hope (?:to |you will )\b/i,
  /\bplease (?:do not hesitate|feel free) to\b/i,
];

/**
 * Detect generic enthusiasm and defensive language in cover letter.
 * Returns matched phrases for correction.
 */
function detectGenericEnthusiasm(cl: TailoredCoverLetter): string[] {
  const fullText = [
    cl.opening_paragraph,
    ...cl.body_paragraphs,
    cl.closing_paragraph,
  ].join(" ");

  const matches: string[] = [];
  for (const pattern of GENERIC_ENTHUSIASM_PATTERNS) {
    const match = fullText.match(pattern);
    if (match) matches.push(match[0]);
  }
  return matches;
}

// ── Cover Letter Anti-Repetition Patterns ────────────────────────

const COVER_LETTER_REPETITION_PATTERNS: { pattern: RegExp; fix: string }[] = [
  { pattern: /\baligns? with [\w']+'s need for\b/gi, fix: "Remove 'aligns with [Company]'s need for' — weave connection implicitly" },
  { pattern: /\bthis aligns (?:directly )?with\b/gi, fix: "Remove 'this aligns with' — let specificity imply alignment" },
  { pattern: /\bwhich aligns (?:directly )?with\b/gi, fix: "Remove 'which aligns with' — implicit connection is stronger" },
  { pattern: /\bdirectly address(?:es|ing) [\w']+'s need for\b/gi, fix: "Remove 'directly addressing [Company]'s need' — too template-driven" },
  { pattern: /\bthis (?:directly )?mirrors\b/gi, fix: "Remove 'this mirrors' — redundant alignment language" },
  { pattern: /\bthis experience (?:directly )?translates to\b/gi, fix: "Remove 'this experience translates to' — resume recap language" },
];

/**
 * Detect template-driven repetition patterns in cover letter.
 * Returns matched patterns for correction.
 */
function detectCoverLetterRepetition(cl: TailoredCoverLetter): string[] {
  const fullText = [
    cl.opening_paragraph,
    ...cl.body_paragraphs,
    cl.closing_paragraph,
  ].join(" ");

  const matches: string[] = [];
  for (const { pattern, fix } of COVER_LETTER_REPETITION_PATTERNS) {
    pattern.lastIndex = 0;
    const match = fullText.match(pattern);
    if (match) matches.push(`"${match[0]}" — ${fix}`);
  }
  return matches;
}

/**
 * Validate cover letter follows the 3-paragraph strategic structure:
 * - Opening: mandate thesis (not recap)
 * - Body: 1-2 high-impact examples
 * - Closing: forward-looking contribution
 *
 * Returns violations if structure is wrong.
 */
function validateCoverLetterStructure(cl: TailoredCoverLetter): string[] {
  const violations: string[] = [];

  // Body must be 1-2 paragraphs (not 3 — opening and closing are separate)
  if (cl.body_paragraphs.length > 2) {
    violations.push(`Body has ${cl.body_paragraphs.length} paragraphs — max 2 for focused impact`);
  }

  // Opening must NOT be a generic interest statement
  if (/^(i am writing|i am applying|i am interested|i would like to apply)/i.test(cl.opening_paragraph)) {
    violations.push("Opening starts with generic interest — must lead with mandate alignment thesis");
  }

  // Closing must NOT be supplicant
  const closingLower = cl.closing_paragraph.toLowerCase();
  if (closingLower.includes("thank you for considering") || closingLower.includes("i hope to hear")) {
    violations.push("Closing uses supplicant language — must state forward-looking contribution");
  }

  // Check for resume recap in body paragraphs
  for (let i = 0; i < cl.body_paragraphs.length; i++) {
    const para = cl.body_paragraphs[i];
    // If paragraph starts with a list of achievements without narrative framing
    if (/^(?:I |At |During |While )/i.test(para) && (para.match(/[,;]/g) || []).length >= 3) {
      violations.push(`Body paragraph ${i + 1} reads as a resume recap — use narrative framing instead`);
    }
  }

  // Check for anti-repetition patterns
  const repetitions = detectCoverLetterRepetition(cl);
  for (const rep of repetitions) {
    violations.push(`Repetition: ${rep}`);
  }

  return violations;
}

/**
 * Count actual words in cover letter body text.
 */
function countCoverLetterWords(cl: TailoredCoverLetter): number {
  const fullText = [
    cl.salutation,
    cl.opening_paragraph,
    ...cl.body_paragraphs,
    cl.closing_paragraph,
    cl.sign_off,
  ].join(" ");
  return fullText.split(/\s+/).filter(w => w.length > 0).length;
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

### BULLET COUNT TARGETS (2 FULL PAGES REQUIRED)
The rendered resume must fill 2 full pages. Per-role bullet targets:
- Role 1 (most recent): 4 bullets
- Roles 2-3: 4 bullets each
- Roles 4+: 3-4 bullets each
Select from the ranked inventory bullets above — include as many as the inventory supports, up to the target. If a role's inventory has fewer bullets than the target, use ALL of them. NEVER fabricate a bullet to reach a count.

${bulletPlan.mandate_gaps.length > 0 ? `### MANDATE GAPS — DO NOT FABRICATE
${gapLines}` : "### No mandate gaps."}

### HEADLINE CALIBRATION
${mandate.seniority_level === "Sr Director" || mandate.seniority_level === "Director"
    ? `Role is ${mandate.seniority_level} level. Do NOT use C-Suite titles. Use: "${mandate.calibrated_headline}".`
    : `Role is ${mandate.seniority_level} level. Headline "${mandate.calibrated_headline}" is appropriate.`}

### CLAIM ID CITATION REQUIREMENT (HARD GATE)
For every resume bullet, you MUST populate the claim_ids array with at least one Claims Ledger ID.
IDs follow the format "cl-{roleIndex}-{type}-{seq}" (e.g., "cl-0-metric-1", "cl-1-tool-2").
An empty claim_ids array is a SCHEMA VIOLATION and will cause the bullet to be REJECTED.
If you cannot find claim IDs for a bullet, DROP THE BULLET — do not emit it.
Every metric, tool, team size, and scope fact must trace to a specific claim ID.

### POSITIONING ENFORCEMENT (CRITICAL)
The resume will be scored on 5 positioning dimensions post-generation. Optimize for ALL of them:
1. SUMMARY MANDATE ANCHORING: First sentence MUST declare a strategic dimension matching "${mandate.primary_mandate.replace(/_/g, " ")}". Not a generic identity claim.
2. IMPACT DENSITY: At least 2 bullets per major role (top 3) MUST contain quantified outcomes ($X, N%). The outcome clause is the most valuable part — never truncate it.
3. AUTHORITY TONE: No "managed day-to-day", "responsible for", "played a key role", "helped", "supported". Every opener must be a concrete executive action verb.
4. NO CLICHÉS: Ban "leveraged", "actionable insights", "unlocking value", "thought leader", "fostering a culture". Use precise, fact-anchored language.
5. OUTCOME PRESERVATION: Every bullet with a quantified result must end with the result intact. Pattern: Action → Context → Outcome (e.g., "Architected governance framework across 6 BUs — reducing compliance gaps 40%").

### METRIC INTEGRITY (HARD RULES — violations are auto-rejected)
6. NEVER invent aggregate or rolled-up figures. "$300M+ in enterprise impact" style totals that do not appear verbatim in the Claims Ledger are fabrications. Only dollar amounts, percentages, and counts that trace to a specific claim ID may appear.
7. ONE ROLE PER SENTENCE: All metrics in a single sentence must trace to the SAME role. Pairing one role's team size with another role's budget (e.g., "teams of 60+ FTEs with $17M budgets") misrepresents scope even when each number is individually true.
8. NO THIRD PERSON: The summary and bullets use implied-first-person executive voice. Never write the candidate's name or "he/she/they has led" constructions in the summary body.`;
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
  /** Positioning brief from Stage 2b (Phase 2) — enables strategic prompts */
  positioningBrief?: PositioningBrief;
  /** Company research from Stage 2c (Phase 3) — enriches context */
  companyResearch?: CompanyResearch;
  correctionContext?: {
    previousResume: TailoredResume;
    previousCoverLetter: TailoredCoverLetter;
    report: VerifierReport;
    attemptNumber: number;
  };
  /** Logger for structured telemetry */
  logger?: any;
}

export interface RewriteResult {
  resume: TailoredResume;
  coverLetter: TailoredCoverLetter;
  duration_ms: number;
}

/**
 * Build a bullet-plan addendum for cover letter generation.
 * Passes the top resume bullets so the LLM can align value claims.
 */
function buildCoverLetterBulletContext(
  resume: TailoredResume,
  bulletPlan: ScoredBulletPlan,
): string {
  const topBullets = resume.experience
    .flatMap(exp => exp.bullets.map(b => ({
      role: `${exp.title} @ ${exp.employer}`,
      text: b.text,
      source_hash: b.source_hash,
    })))
    .slice(0, 6);

  const topBulletLines = topBullets
    .map((b, i) => `  ${i + 1}. [${b.role}] "${b.text}" (source: ${b.source_hash})`)
    .join("\n");

  return `## RESUME BULLET ALIGNMENT (for cover letter value claims)
Select your 1-3 value claims from the TOP resume bullets below.
This ensures the cover letter reinforces (not contradicts) the resume's strongest achievements.
Do NOT pick achievements that are absent from the resume.

### Top Resume Bullets (by mandate relevance)
${topBulletLines}

Pick value claims from these bullets. Use different phrasing — do not copy bullet text verbatim.
The cover letter should AMPLIFY the resume's strongest signals, not introduce new ones.`;
}

/**
 * Execute the constrained rewrite stage.
 * Generates resume + cover letter with LLM, runs compression, handles corrections.
 * Includes post-LLM validation: generic opener detection, ATS keyword verification,
 * and cover letter word count enforcement.
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
      resume = (await resilientGenerateObject({
        schema: TailoredResumeSchema,
        system: resumeSystemPrompt,
        prompt: `${resumeUserPrompt}\n\n${corrPrompt}`,
        temperature: 0.2,
        label: `Stage 4: resume-correction-attempt${attemptNumber}`,
        lane: "medium",
        logger: input.logger,
      })).object;
    } else {
      resume = previousResume;
    }

    if (clViolations.length > 0) {
      const corrPrompt = buildCorrectionPrompt("cover_letter", JSON.stringify(previousCoverLetter, null, 2), clViolations, clFixes, attemptNumber);
      // On correction, also pass bullet alignment context from the (possibly corrected) resume
      const bulletContext = buildCoverLetterBulletContext(resume, input.bulletPlan);
      const clUserPrompt = buildCoverLetterUserPrompt(
        input.inventory, input.allowlist, input.requirements, input.title, input.company, input.companyContext,
      ) + "\n\n" + bulletContext;
      coverLetter = (await resilientGenerateObject({
        schema: TailoredCoverLetterSchema,
        system: clSystemPrompt,
        prompt: `${clUserPrompt}\n\n${corrPrompt}`,
        temperature: 0.2,
        label: `Stage 4: coverLetter-correction-attempt${attemptNumber}`,
        lane: "medium",
        logger: input.logger,
      })).object;
    } else {
      coverLetter = previousCoverLetter;
    }
  } else {
    // ── Initial Resume Generation ──
    // Phase 5: Use strategic prompts when positioning brief is available AND Claude is the provider
    const useStrategicPrompts = !!input.positioningBrief && isClaudeAvailable();

    let activeResumeSystemPrompt: string;
    let activeResumeUserPrompt: string;

    if (useStrategicPrompts) {
      input.logger?.info(`🧠 [Stage 4] Using STRATEGIC prompt (positioning brief available, Claude active)`);
      activeResumeSystemPrompt = buildStrategicResumeSystemPrompt(
        input.positioningBrief!,
        input.mandate,
        input.companyResearch,
        input.inventory?.ens,
      );
      activeResumeUserPrompt = buildStrategicResumeUserPrompt(
        input.inventory, input.allowlist, input.requirements, input.title, input.company,
      ) + "\n\n" + mandateContext;
    } else {
      input.logger?.info(`📋 [Stage 4] Using STANDARD prompt (legacy mode)`);
      activeResumeSystemPrompt = resumeSystemPrompt;
      activeResumeUserPrompt = resumeUserPrompt;
    }

    let finalPrompt = activeResumeUserPrompt;
    if (input.divergencePrompt) finalPrompt += "\n\n" + input.divergencePrompt;

    resume = (await resilientGenerateObject({
      schema: TailoredResumeSchema,
      system: activeResumeSystemPrompt,
      prompt: finalPrompt,
      temperature: useStrategicPrompts ? 0.4 : 0.3,
      label: `Stage 4: resume-initial${useStrategicPrompts ? " (strategic)" : ""}`,
      lane: "heavy",
      logger: input.logger,
    })).object;

    // ── Post-LLM Resume Validation: Generic Opener ──
    const genericOpener = detectGenericOpener(resume.professional_summary);
    if (genericOpener) {
      // Regenerate with explicit correction instruction at lower temperature
      const openerCorrectionPrompt = `${finalPrompt}\n\n## CRITICAL CORRECTION
The summary you generate MUST NOT open with a generic pattern.
BANNED opener detected in prior attempt: "${genericOpener}"
Rewrite the FIRST SENTENCE to reflect the job's PRIMARY MANDATE outcome.
Do NOT use "[Domain] leader/executive who has...", "Executive with a track record...",
"Seasoned/Accomplished/Results-driven...", or any "[Role] who/with" pattern.
Anchor the opener to THIS job's specific mandate: ${input.mandate.primary_mandate.replace(/_/g, " ")}.`;

      resume = (await resilientGenerateObject({
        schema: TailoredResumeSchema,
        system: resumeSystemPrompt,
        prompt: openerCorrectionPrompt,
        temperature: 0.2,
        label: "Stage 4: resume-opener-correction",
        lane: "medium",
        logger: input.logger,
      })).object;
    }

    // ── Post-LLM Resume Validation: ATS Keywords ──
    const phantomKeywords = validateAtsKeywords(resume);
    if (phantomKeywords.length > 0) {
      // Remove phantom keywords that don't actually appear in the resume
      resume.ats_keywords_used = resume.ats_keywords_used.filter(
        kw => !phantomKeywords.includes(kw),
      );
    }

    // ── Cover Letter Generation (with bullet alignment context) ──
    const bulletContext = buildCoverLetterBulletContext(resume, input.bulletPlan);

    let activeClSystemPrompt: string;
    if (useStrategicPrompts) {
      activeClSystemPrompt = buildStrategicCoverLetterSystemPrompt(
        input.positioningBrief!,
        input.mandate,
        input.companyResearch,
      );
    } else {
      activeClSystemPrompt = clSystemPrompt;
    }

    const clUserPrompt = buildCoverLetterUserPrompt(
      input.inventory, input.allowlist, input.requirements, input.title, input.company, input.companyContext,
    ) + "\n\n" + bulletContext;

    coverLetter = (await resilientGenerateObject({
      schema: TailoredCoverLetterSchema,
      system: activeClSystemPrompt,
      prompt: clUserPrompt,
      temperature: useStrategicPrompts ? 0.5 : 0.4,
      label: `Stage 4: coverLetter-initial${useStrategicPrompts ? " (strategic)" : ""}`,
      lane: "heavy",
      logger: input.logger,
    })).object;

    // ── Post-LLM Cover Letter Validation (combined single-pass correction) ──
    // Detect ALL issues first, then issue ONE combined correction call (saves 15-30s per extra issue).
    const actualWordCount = countCoverLetterWords(coverLetter);
    coverLetter.word_count = actualWordCount; // Correct LLM's self-reported count

    const clCorrectionSections: string[] = [];

    // Word count check
    if (actualWordCount < 300 || actualWordCount > 400) {
      const wcDirection = actualWordCount < 300 ? "TOO SHORT" : "TOO LONG";
      const wcTarget = actualWordCount < 300 ? "expand to 320-350 words" : "compress to 320-350 words";
      clCorrectionSections.push(`## WORD COUNT CORRECTION
The cover letter is ${wcDirection} at ${actualWordCount} words. MUST be 300-400 words.
${wcTarget}. Aim for ~350 words. Keep all value claims and evidence pointers.
${actualWordCount < 300 ? "Add more specific detail to body paragraphs — connect achievements to company needs." : "Remove redundant phrases and tighten language. Cut filler, not substance."}`);
    }

    // Resume repetition check
    const resumeRepetitions = detectResumeRepetition(resume, coverLetter);
    if (resumeRepetitions.length > 0) {
      const repList = resumeRepetitions
        .map((r, i) => `  ${i + 1}. CL phrase: "${r.cl_phrase}" ← resume bullet: "${r.resume_bullet}"`)
        .join("\n");
      clCorrectionSections.push(`## RESUME REPETITION CORRECTION
The cover letter copies or closely paraphrases ${resumeRepetitions.length} resume bullet(s). The cover letter must provide NARRATIVE context, not parrot resume text.

REPEATED PHRASES DETECTED:
${repList}

Rewrite the body_paragraphs to use DIFFERENT angles on the same achievements. The cover letter should AMPLIFY resume signals, not repeat them verbatim.
Pattern: instead of restating the achievement, explain the STRATEGIC CONTEXT — why you did it, what you learned, how it serves this company.`);
    }

    // Generic enthusiasm / structure check
    const enthusiasmMatches = detectGenericEnthusiasm(coverLetter);
    const structureViolations = validateCoverLetterStructure(coverLetter);
    if (enthusiasmMatches.length > 0 || structureViolations.length > 0) {
      const issues: string[] = [];
      if (enthusiasmMatches.length > 0) {
        issues.push(`GENERIC ENTHUSIASM detected: ${enthusiasmMatches.map(m => `"${m}"`).join(", ")}. Remove ALL generic enthusiasm. The tone must be strategic and confident, not eager or defensive.`);
      }
      for (const sv of structureViolations) {
        issues.push(`STRUCTURE: ${sv}`);
      }
      clCorrectionSections.push(`## TONE & STRUCTURE CORRECTION
${issues.join("\n")}

RULES:
- Paragraph 1 (opening): Mandate alignment thesis. NOT "I am excited to apply." State what THIS role requires and your proven capability.
- Paragraph 2 (body): 1-2 high-impact examples with metrics. No resume restatement.
- Paragraph 3 (closing): Forward-looking value proposition. NOT "Thank you for considering." State what strategic conversation you want to have.
- NO generic enthusiasm ("excited", "passionate", "thrilled")
- NO defensive hedging ("I am confident that", "I hope to")
- Tone: strategic peer, not eager applicant.`);
    }

    // Issue ONE combined correction call if any issues found (instead of up to 3 sequential calls)
    if (clCorrectionSections.length > 0) {
      input.logger?.info(`🔧 [Stage 4] CL combined correction: ${clCorrectionSections.length} issue(s) in single call`);
      const combinedCorrectionPrompt = `${clUserPrompt}\n\n${clCorrectionSections.join("\n\n")}`;
      coverLetter = (await resilientGenerateObject({
        schema: TailoredCoverLetterSchema,
        system: clSystemPrompt,
        prompt: combinedCorrectionPrompt,
        temperature: 0.2,
        label: `Stage 4: coverLetter-combined-correction (${clCorrectionSections.length} issues)`,
        lane: "medium",
        logger: input.logger,
      })).object;
      coverLetter.word_count = countCoverLetterWords(coverLetter);
    }

    // ── Post-LLM Cover Letter: Hype Word Suppression (deterministic) ──
    const COVER_LETTER_HYPE: { pattern: RegExp; replacement: string }[] = [
      { pattern: /\bcatalyzed\b/gi, replacement: "initiated" },
      { pattern: /\bcatalyze\b/gi, replacement: "initiate" },
      { pattern: /\bcatalyst\b/gi, replacement: "driver" },
      { pattern: /\bpowerhouse\b/gi, replacement: "team" }, // noun-for-noun: adjective swap corrupted sentences
      { pattern: /\bmarket-dominating\b/gi, replacement: "market-leading" },
      { pattern: /\bgame-changing\b/gi, replacement: "significant" },
      { pattern: /\bgame changer\b/gi, replacement: "significant improvement" },
      { pattern: /\bgroundbreaking\b/gi, replacement: "first-of-its-kind" },
      { pattern: /\brevolutionized\b/gi, replacement: "redesigned" },
      { pattern: /\bworld-class\b/gi, replacement: "enterprise-grade" },
      { pattern: /\bbest-in-class\b/gi, replacement: "competitive" },
      { pattern: /\bcutting-edge\b/gi, replacement: "modern" },
      { pattern: /\bstate-of-the-art\b/gi, replacement: "advanced" },
      { pattern: /\btransformative\b/gi, replacement: "impactful" },
      { pattern: /\bunprecedented\b/gi, replacement: "notable" },
      { pattern: /\bskyrocketed\b/gi, replacement: "increased significantly" },
      { pattern: /\bseismic\b/gi, replacement: "significant" },
      { pattern: /\bdisruptive\b/gi, replacement: "innovative" },
      { pattern: /\bdrove\s+(?:the\s+)?board\s+to\b/gi, replacement: "presented to the board" },
      ...BANNED_AI_ISMS,
    ];
    for (const hw of COVER_LETTER_HYPE) {
      coverLetter.opening_paragraph = coverLetter.opening_paragraph.replace(hw.pattern, hw.replacement);
      coverLetter.body_paragraphs = coverLetter.body_paragraphs.map(p => p.replace(hw.pattern, hw.replacement));
      coverLetter.closing_paragraph = coverLetter.closing_paragraph.replace(hw.pattern, hw.replacement);
    }
  }

  // Run compression pass (mandate-aware)
  compressResume(resume, input.mandate);

  return {
    resume,
    coverLetter,
    duration_ms: Date.now() - start,
  };
}
