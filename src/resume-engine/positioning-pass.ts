/**
 * Final Positioning Refinement Pass
 *
 * A deterministic post-pipeline quality gate that enforces 6 positioning dimensions:
 *
 * 1. SUMMARY MANDATE ANCHORING — First sentence must declare a strategic dimension
 *    matching the job's primary mandate. No generic openers. No scale-first framing.
 *
 * 2. BULLET IMPACT STRENGTHENING — Restore truncated outcome clauses when word
 *    budget allows. Ensure at least 2 impact bullets per major role.
 *
 * 3. AUTHORITY WITHOUT HYPE — Replace safe managerial phrasing with concrete
 *    authority signals. Suppress corporate clichés. No hedge language.
 *
 * 4. COVER LETTER UPGRADE — Validate 3-paragraph structure (mandate thesis,
 *    high-impact evidence, forward-looking contribution). No supplicant language.
 *
 * 5. DIFFERENTIATION MAINTENANCE — Flag summary/competency overlap with prior
 *    resumes. Enforce mandate-scoped competency ordering.
 *
 * 6. FINAL QA GATE — Consolidated gate across all 5 dimensions. Returns structured
 *    scores, flags, and a pass/fail verdict.
 *
 * RULES:
 * - Do not fabricate. Do not add new facts.
 * - Maintain 2-page band (1.6–2.0 pages).
 * - Resume-agnostic: works for any inventory/mandate combination.
 * - Mutations are SAFE and DETERMINISTIC only (pattern replacement, reordering).
 * - Detection flags returned for issues requiring LLM correction.
 *
 * Type: DETERMINISTIC (no LLM calls)
 */

import type { TailoredResume } from "../mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../mastra/tools/tailoredCoverLetterPrompt";
import type { MandateProfile } from "./stage2-mandate-classifier/classifier";
import type { ClaimsLedger } from "./types";

// ── Types ────────────────────────────────────────────────────────

export interface PositioningScore {
  summary_anchoring: number;    // 0-100
  bullet_impact: number;        // 0-100
  authority_tone: number;       // 0-100
  cover_letter: number;         // 0-100
  differentiation: number;      // 0-100
  composite: number;            // weighted average
  grade: "A" | "B" | "C" | "D" | "F";
}

export interface PositioningIssue {
  dimension: "summary" | "impact" | "authority" | "cover_letter" | "differentiation";
  location: string;
  issue: string;
  severity: "blocking" | "warning" | "info";
  auto_fixed: boolean;
  original?: string;
  replacement?: string;
}

export interface PositioningInput {
  resume: TailoredResume;
  coverLetter?: TailoredCoverLetter;
  mandate: MandateProfile;
  ledger?: ClaimsLedger;
  inventory?: Record<string, any>;
  priorSummaries?: string[];
  priorCompetencies?: string[][];
  logger?: any;
}

export interface PositioningResult {
  scores: PositioningScore;
  issues: PositioningIssue[];
  actions_taken: string[];
  passed: boolean;
  blocking_issues: string[];
  duration_ms: number;
}

// ── 1. SUMMARY MANDATE ANCHORING ────────────────────────────────
//
// The first sentence of the summary must declare a strategic dimension
// that matches the job's primary mandate. Not a generic identity
// claim, not a role descriptor, not a scale brag.

/** Strategic dimension keywords per mandate archetype. */
const MANDATE_STRATEGIC_DIMENSIONS: Record<string, {
  required_signals: string[];
  banned_openers: RegExp[];
  anchor_template: string;
}> = {
  governance_standardization: {
    required_signals: ["governance", "compliance", "standardiz", "control", "framework", "quality", "rigor", "audit", "data quality", "reporting discipline"],
    banned_openers: [/^(?:data|analytics)\s+(?:leader|executive)/i, /^(?:\$[\d,.]+[KMBTkmbt]?\s+)?revenue/i, /^built\s/i],
    anchor_template: "governance, compliance, or control-oriented framing",
  },
  bi_platform_modernization: {
    required_signals: ["platform", "architect", "moderniz", "migrat", "infrastructure", "replatform", "cloud", "warehouse", "pipeline", "scalab"],
    banned_openers: [/^governance/i, /^revenue/i],
    anchor_template: "platform architecture, modernization, or infrastructure framing",
  },
  insight_delivery_automation: {
    required_signals: ["insight", "self-service", "reporting", "dashboard", "stakeholder", "decision", "automat", "clarity", "democratiz"],
    banned_openers: [/^platform/i, /^revenue/i],
    anchor_template: "insight delivery, stakeholder enablement, or analytics clarity framing",
  },
  founder_adjacent_builder: {
    required_signals: ["built from", "zero-to-one", "stood up", "founder", "startup", "first hire", "from scratch", "established", "incubat"],
    banned_openers: [/^enterprise/i, /^governance/i],
    anchor_template: "zero-to-one building or function creation framing",
  },
  revenue_ops_forecasting: {
    required_signals: ["revenue", "forecast", "pricing", "demand", "p&l", "margin", "commercial", "financial", "monetiz"],
    banned_openers: [/^governance/i, /^platform/i],
    anchor_template: "revenue operations, forecasting, or commercial impact framing",
  },
  operating_model_transformation: {
    required_signals: ["operating model", "transform", "embed", "democratiz", "reorganiz", "change management", "redesign", "restructur"],
    banned_openers: [/^revenue\s+(?:growth|leader)/i],
    anchor_template: "operating model transformation or organizational redesign framing",
  },
  product_gtm_analytics: {
    required_signals: ["product", "go-to-market", "gtm", "feature", "adoption", "user journey", "engagement", "conversion"],
    banned_openers: [/^governance/i, /^infrastructure/i],
    anchor_template: "product analytics, GTM, or user engagement framing",
  },
  growth_monetization: {
    required_signals: ["growth", "experiment", "a/b", "conversion", "monetiz", "funnel", "optimization"],
    banned_openers: [/^governance/i, /^operating model/i],
    anchor_template: "growth experimentation or monetization framing",
  },
  executive_storytelling: {
    required_signals: ["board", "c-suite", "advisory", "storytelling", "strategic", "influence", "decision", "counsel"],
    banned_openers: [/^platform/i, /^revenue\s+growth/i],
    anchor_template: "executive advisory, board storytelling, or strategic influence framing",
  },
  team_leadership_scale: {
    required_signals: ["team", "hired", "scaled", "organizational design", "talent", "people", "culture", "recruiting", "coaching"],
    banned_openers: [/^platform/i, /^governance/i],
    anchor_template: "team building, organizational scaling, or talent leadership framing",
  },
};

/** Generic opener patterns banned across ALL mandates. */
const UNIVERSAL_BANNED_OPENERS: RegExp[] = [
  /^(?:data|analytics)\s+(?:and\s+)?(?:analytics\s+)?(?:leader|executive|professional)\s+(?:who|with|that)\b/i,
  /^(?:seasoned|accomplished|dynamic|experienced|senior|results-driven|data-driven|forward-thinking)\s+/i,
  /^(?:proven|established|recognized|respected)\s+(?:leader|executive|professional)\b/i,
  /^(?:a\s+)?(?:passionate|dedicated|committed)\s+/i,
  /^(?:innovative|visionary|strategic)\s+(?:leader|executive|thinker)\b/i,
  /^executive\s+with\s+(?:a\s+)?(?:track\s+record|proven|deep|extensive)\b/i,
  /^career\s+(?:marked|defined)\s+by\b/i,
  /^track\s+record\s+of\b/i,
  /^with\s+(?:over|more\s+than|\d+)\s+years?\b/i,
  /^known\s+for\b/i,
  /^(?:highly|uniquely)\s+(?:skilled|qualified|experienced)\b/i,
];

export function checkSummaryMandateAnchoring(
  summary: string,
  mandate: MandateProfile,
): {
  score: number;
  anchored: boolean;
  strategic_dimension_found: boolean;
  generic_opener_detected: boolean;
  banned_mandate_opener_detected: boolean;
  issues: PositioningIssue[];
} {
  const firstSentence = summary.split(/[.!?]\s/)[0] || "";
  const firstSentenceLower = firstSentence.toLowerCase();
  const issues: PositioningIssue[] = [];
  let score = 100;

  // Check for universal banned openers
  let genericOpenerDetected = false;
  for (const pattern of UNIVERSAL_BANNED_OPENERS) {
    if (pattern.test(firstSentence)) {
      genericOpenerDetected = true;
      score -= 30;
      issues.push({
        dimension: "summary",
        location: "professional_summary.first_sentence",
        issue: `Generic opener detected: "${firstSentence.substring(0, 60)}..."`,
        severity: "blocking",
        auto_fixed: false,
      });
      break;
    }
  }

  // Check for mandate-specific banned openers
  const mandateConfig = MANDATE_STRATEGIC_DIMENSIONS[mandate.primary_mandate];
  let bannedMandateOpener = false;
  if (mandateConfig) {
    for (const banned of mandateConfig.banned_openers) {
      if (banned.test(firstSentence)) {
        bannedMandateOpener = true;
        score -= 15;
        issues.push({
          dimension: "summary",
          location: "professional_summary.first_sentence",
          issue: `Mandate-mismatched opener for ${mandate.primary_mandate}: "${firstSentence.substring(0, 60)}..."`,
          severity: "warning",
          auto_fixed: false,
        });
        break;
      }
    }
  }

  // Check for strategic dimension keywords in first sentence
  let strategicDimensionFound = false;
  if (mandateConfig) {
    for (const signal of mandateConfig.required_signals) {
      if (firstSentenceLower.includes(signal)) {
        strategicDimensionFound = true;
        break;
      }
    }
  }

  if (!strategicDimensionFound) {
    score -= 25;
    issues.push({
      dimension: "summary",
      location: "professional_summary.first_sentence",
      issue: `First sentence lacks strategic dimension for ${mandate.primary_mandate.replace(/_/g, " ")}. Expected: ${mandateConfig?.anchor_template || "mandate-specific framing"}`,
      severity: "warning",
      auto_fixed: false,
    });
  }

  // Check for scale-first framing (revenue/team size in first sentence for non-revenue mandates)
  const REVENUE_MANDATES = new Set(["revenue_ops_forecasting", "growth_monetization"]);
  const scaleFirstPatterns = [/^\$[\d,.]+[MKBT]/i, /^\d+-person/i, /^\d+\+?\s*(?:person|fte|report)/i];
  if (!REVENUE_MANDATES.has(mandate.primary_mandate)) {
    for (const pattern of scaleFirstPatterns) {
      if (pattern.test(firstSentence)) {
        score -= 10;
        issues.push({
          dimension: "summary",
          location: "professional_summary.first_sentence",
          issue: "Scale-first framing in first sentence for non-revenue mandate",
          severity: "warning",
          auto_fixed: false,
        });
        break;
      }
    }
  }

  // Check summary-to-first-bullet repetition
  const anchored = strategicDimensionFound && !genericOpenerDetected;

  return {
    score: Math.max(0, Math.min(100, score)),
    anchored,
    strategic_dimension_found: strategicDimensionFound,
    generic_opener_detected: genericOpenerDetected,
    banned_mandate_opener_detected: bannedMandateOpener,
    issues,
  };
}

// ── 2. BULLET IMPACT STRENGTHENING ──────────────────────────────
//
// Ensure every major role has quantified impact. Restore truncated
// outcome clauses when word budget allows. Flag roles lacking impact.

/** Outcome patterns that indicate quantified business impact. */
const OUTCOME_PATTERNS: RegExp[] = [
  /\$[\d,.]+\s*[KMBTkmbt]?\b/,
  /\d+\.?\d*%/,
  /\d+[xX]\s+(?:improvement|increase|growth|reduction|faster|more)/i,
  /\b(?:revenue|savings|ROI|margin|profit|EBITDA|ARR|pipeline|cost\s+reduc)/i,
  /\b(?:resulting in|generating|producing|delivering|achieving|yielding|saving|recovering)\b/i,
];

function bulletHasQuantifiedOutcome(text: string): boolean {
  return OUTCOME_PATTERNS.some(p => p.test(text));
}

export function checkBulletImpact(
  resume: TailoredResume,
): {
  score: number;
  total_impact_bullets: number;
  roles_with_impact: number;
  roles_without_impact: string[];
  issues: PositioningIssue[];
} {
  const issues: PositioningIssue[] = [];
  let totalImpactBullets = 0;
  let rolesWithImpact = 0;
  const rolesWithoutImpact: string[] = [];

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];
    const impactCount = exp.bullets.filter(b => bulletHasQuantifiedOutcome(b.text)).length;
    totalImpactBullets += impactCount;

    if (impactCount > 0) {
      rolesWithImpact++;
    } else {
      rolesWithoutImpact.push(exp.employer);
    }

    // Major roles (first 3) must have at least 2 impact bullets
    if (i < 3 && impactCount < 2) {
      issues.push({
        dimension: "impact",
        location: `experience[${i}] (${exp.employer})`,
        issue: `Only ${impactCount} impact bullet(s) — major roles need at least 2 with quantified outcomes ($X, N%, etc.)`,
        severity: i === 0 ? "blocking" : "warning",
        auto_fixed: false,
      });
    }

    // Check each bullet for Action → Scale → Outcome structure
    for (let j = 0; j < exp.bullets.length; j++) {
      const bullet = exp.bullets[j];
      const words = bullet.text.split(/\s+/);

      // Check for outcome clause presence on first 2 bullets per major role
      if (i < 3 && j < 2 && !bulletHasQuantifiedOutcome(bullet.text)) {
        issues.push({
          dimension: "impact",
          location: `experience[${i}].bullets[${j}]`,
          issue: `Top-2 bullet lacks quantified outcome. Expected: Action → Scale → Outcome`,
          severity: "warning",
          auto_fixed: false,
        });
      }

      // Detect truncated bullets (likely lost outcome clause during compression)
      if (words.length >= 18 && words.length <= 22 && !bullet.text.match(/[.!?—]$/)) {
        const lastWord = words[words.length - 1];
        if (lastWord && !bulletHasQuantifiedOutcome(bullet.text) && /^[a-z]/.test(lastWord)) {
          issues.push({
            dimension: "impact",
            location: `experience[${i}].bullets[${j}]`,
            issue: `Bullet appears truncated (${words.length} words, no clean ending) — outcome clause may have been lost`,
            severity: "info",
            auto_fixed: false,
          });
        }
      }
    }
  }

  // Score calculation
  const totalBullets = resume.experience.reduce((s, e) => s + e.bullets.length, 0);
  const impactRatio = totalBullets > 0 ? totalImpactBullets / totalBullets : 0;

  let score = 0;
  // 40% for having impact bullets in major roles
  const majorRoleImpact = resume.experience.slice(0, 3).filter(
    exp => exp.bullets.filter(b => bulletHasQuantifiedOutcome(b.text)).length >= 2,
  ).length;
  score += Math.round((majorRoleImpact / Math.min(3, resume.experience.length)) * 40);

  // 30% for overall impact ratio
  score += Math.round(impactRatio * 30);

  // 30% for all roles having at least 1 impact bullet
  const allRolesHaveImpact = rolesWithoutImpact.length === 0;
  score += allRolesHaveImpact ? 30 : Math.round(((resume.experience.length - rolesWithoutImpact.length) / resume.experience.length) * 30);

  return {
    score: Math.max(0, Math.min(100, score)),
    total_impact_bullets: totalImpactBullets,
    roles_with_impact: rolesWithImpact,
    roles_without_impact: rolesWithoutImpact,
    issues,
  };
}

// ── 3. AUTHORITY WITHOUT HYPE ───────────────────────────────────
//
// Replace safe managerial phrasing with concrete authority signals.
// Suppress corporate clichés. Enforce executive tone.
//
// MUTATIONS: Deterministic pattern replacements ONLY.
// No semantic rewrites, no fact introduction.

/** Safe managerial phrasing that sounds impressive but conveys nothing. */
const SAFE_MANAGERIAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /^(?:oversaw|managed|responsible for)\s+(?:the\s+)?(?:day-to-day|daily|ongoing|routine)\b/i, label: "routine oversight" },
  { pattern: /^(?:managed|oversaw)\s+(?:a\s+)?team\s+(?:of\s+)?\w+\s+(?:to\s+)?(?:deliver|ensure|maintain|support)\b/i, label: "generic team management" },
  { pattern: /^ensured\s+(?:the\s+)?(?:quality|timely|smooth|successful)\b/i, label: "ensured quality" },
  { pattern: /^responsible\s+for\s+(?:managing|overseeing|ensuring|maintaining)\b/i, label: "responsible for" },
  { pattern: /^(?:served|acted|functioned)\s+as\s+(?:a\s+)?(?:key|primary|main|go-to)\b/i, label: "served as" },
  { pattern: /^(?:played|had)\s+(?:a\s+)?(?:key|critical|vital|important)\s+role\s+in\b/i, label: "played a key role" },
  { pattern: /^(?:worked\s+(?:closely|collaboratively|cross-functionally))\s+with\b/i, label: "worked closely with" },
  { pattern: /^(?:was\s+)?(?:instrumental|pivotal|critical)\s+in\b/i, label: "was instrumental in" },
  { pattern: /^(?:helped|assisted|supported|contributed\s+to)\s+(?:the\s+)?(?:team|organization|company|department)\b/i, label: "helped the team" },
];

/** Corporate clichés that weaken executive authority. Auto-replaced. */
export const CORPORATE_CLICHE_REPLACEMENTS: { pattern: RegExp; replacement: string; label: string }[] = [
  { pattern: /\bdrove synergies\b/gi, replacement: "integrated", label: "drove synergies" },
  { pattern: /\bleveraged\b/gi, replacement: "applied", label: "leveraged" },
  { pattern: /\bactionable insights\b/gi, replacement: "decision-ready analysis", label: "actionable insights" },
  { pattern: /\bunlocking value\b/gi, replacement: "recovering margin", label: "unlocking value" },
  { pattern: /\bcreating value\b/gi, replacement: "generating results", label: "creating value" },
  { pattern: /\bdriving value\b/gi, replacement: "producing outcomes", label: "driving value" },
  { pattern: /\bdelivering value\b/gi, replacement: "delivering results", label: "delivering value" },
  { pattern: /\bfostering a culture of\b/gi, replacement: "establishing", label: "fostering a culture of" },
  { pattern: /\bbuilding a culture of\b/gi, replacement: "establishing", label: "building a culture of" },
  { pattern: /\bat the forefront of\b/gi, replacement: "leading", label: "at the forefront of" },
  { pattern: /\bspearheaded the development of\b/gi, replacement: "developed", label: "spearheaded the development of" },
  { pattern: /\bdata-informed decisions\b/gi, replacement: "evidence-based decisions", label: "data-informed decisions" },
  { pattern: /\btranslating (?:complex )?data into\b/gi, replacement: "converting data into", label: "translating data into" },
  { pattern: /\bunique combination of\b/gi, replacement: "combination of", label: "unique combination of" },
  { pattern: /\brare blend of\b/gi, replacement: "blend of", label: "rare blend of" },
  { pattern: /\bthought leader(?:ship)?\b/gi, replacement: "subject-matter authority", label: "thought leader" },
];

/** Hedge phrases that signal lack of executive confidence. */
const HEDGE_PHRASES: { pattern: RegExp; label: string }[] = [
  { pattern: /\bi believe (?:that |i )/i, label: "I believe" },
  { pattern: /\bi think (?:that |my |i )/i, label: "I think" },
  { pattern: /\bhelped to\b/i, label: "helped to" },
  { pattern: /\btried to\b/i, label: "tried to" },
  { pattern: /\battempted to\b/i, label: "attempted to" },
  { pattern: /\bsought to\b/i, label: "sought to" },
  { pattern: /\bi am confident that\b/i, label: "I am confident that" },
  { pattern: /\bpotentially\b/i, label: "potentially" },
];

export function checkAuthorityTone(
  resume: TailoredResume,
  inventory?: Record<string, any>,
): {
  score: number;
  clichés_replaced: number;
  safe_managerial_flags: number;
  hedge_phrases_found: number;
  issues: PositioningIssue[];
  actions_taken: string[];
} {
  const issues: PositioningIssue[] = [];
  const actions: string[] = [];
  let clichésReplaced = 0;
  let safeManagerialFlags = 0;
  let hedgePhrases = 0;

  // Helper: scan and auto-replace corporate clichés (SAFE DETERMINISTIC MUTATION)
  function replaceClichés(text: string, location: string): string {
    let result = text;
    for (const cliché of CORPORATE_CLICHE_REPLACEMENTS) {
      cliché.pattern.lastIndex = 0;
      const match = result.match(cliché.pattern);
      if (match) {
        // Preserve initial capitalization of the matched text
        let replacement = cliché.replacement;
        if (match[0].length > 0 && match[0][0] === match[0][0].toUpperCase() && match[0][0] !== match[0][0].toLowerCase()) {
          replacement = replacement.charAt(0).toUpperCase() + replacement.slice(1);
        }
        result = result.replace(cliché.pattern, replacement);
        clichésReplaced++;
        actions.push(`Replaced "${match[0]}" → "${replacement}" at ${location}`);
        issues.push({
          dimension: "authority",
          location,
          issue: `Corporate cliché: "${match[0]}"`,
          severity: "info",
          auto_fixed: true,
          original: match[0],
          replacement,
        });
      }
    }
    return result;
  }

  // Scan and replace clichés in summary
  resume.professional_summary = replaceClichés(resume.professional_summary, "summary");

  // Scan bullets for safe managerial phrasing and clichés
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const loc = `experience[${i}].bullets[${j}]`;

      // Auto-replace corporate clichés
      bullet.text = replaceClichés(bullet.text, loc);

      // Detect safe managerial phrasing (flag only — too nuanced for auto-fix)
      for (const mp of SAFE_MANAGERIAL_PATTERNS) {
        if (mp.pattern.test(bullet.text)) {
          safeManagerialFlags++;
          issues.push({
            dimension: "authority",
            location: loc,
            issue: `Safe managerial phrasing: "${mp.label}" — says nothing substantive`,
            severity: "warning",
            auto_fixed: false,
          });
          break;
        }
      }

      // Detect hedge phrases
      for (const hp of HEDGE_PHRASES) {
        if (hp.pattern.test(bullet.text)) {
          hedgePhrases++;
          issues.push({
            dimension: "authority",
            location: loc,
            issue: `Hedge phrase: "${hp.label}" — weakens executive authority`,
            severity: "warning",
            auto_fixed: false,
          });
          break;
        }
      }
    }
  }

  // Also check summary for hedge phrases
  const summaryText = resume.professional_summary;
  for (const hp of HEDGE_PHRASES) {
    if (hp.pattern.test(summaryText)) {
      hedgePhrases++;
      issues.push({
        dimension: "authority",
        location: "summary",
        issue: `Hedge phrase in summary: "${hp.label}"`,
        severity: "warning",
        auto_fixed: false,
      });
    }
  }

  // Score: deductions for each issue type
  let score = 100;
  score -= safeManagerialFlags * 8;
  score -= hedgePhrases * 10;
  // Cliché replacements are auto-fixed, so no deduction

  return {
    score: Math.max(0, Math.min(100, score)),
    clichés_replaced: clichésReplaced,
    safe_managerial_flags: safeManagerialFlags,
    hedge_phrases_found: hedgePhrases,
    issues,
    actions_taken: actions,
  };
}

// ── 4. COVER LETTER QA ──────────────────────────────────────────
//
// Validate the 3-paragraph structure:
// - Opening: Mandate thesis (not generic interest)
// - Body: 1-2 high-impact evidence paragraphs
// - Closing: Forward-looking contribution (not supplicant)

/** Generic interest openers banned from cover letter. */
const CL_GENERIC_OPENERS: RegExp[] = [
  /^(?:i am writing|i am applying|i am interested|i would like to apply)\b/i,
  /^(?:dear hiring (?:manager|team),?\s+)?(?:i am writing|i am applying)\b/i,
  /^(?:i am (?:truly |deeply |very )?excited)\b/i,
  /^(?:please accept|this letter is)\b/i,
];

/** Supplicant language banned from cover letter closing. */
const CL_SUPPLICANT_PATTERNS: RegExp[] = [
  /\bthank you (?:so much )?for (?:your time|considering|this opportunity|reviewing)\b/i,
  /\bi (?:humbly |respectfully )?submit\b/i,
  /\bi hope (?:to |you will )\b/i,
  /\bplease (?:do not hesitate|feel free) to\b/i,
  /\bi would be honored\b/i,
  /\bi look forward to the opportunity to\b/i,
];

/** Resume recap signals in cover letter body. */
const CL_RESUME_RECAP_PATTERNS: RegExp[] = [
  /\b(?:i |at |during |while ).*(?:implemented|architected|built|launched|established|deployed|created)\b.*\d+/i,
];

export function checkCoverLetterPositioning(
  coverLetter: TailoredCoverLetter | undefined,
  mandate: MandateProfile,
): {
  score: number;
  issues: PositioningIssue[];
} {
  if (!coverLetter) {
    return { score: 0, issues: [] };
  }

  const issues: PositioningIssue[] = [];
  let score = 100;

  // Check opening paragraph for generic openers
  for (const pattern of CL_GENERIC_OPENERS) {
    if (pattern.test(coverLetter.opening_paragraph)) {
      score -= 20;
      issues.push({
        dimension: "cover_letter",
        location: "opening_paragraph",
        issue: `Generic opener: "${coverLetter.opening_paragraph.substring(0, 60)}..." — must lead with mandate alignment thesis`,
        severity: "blocking",
        auto_fixed: false,
      });
      break;
    }
  }

  // Check for mandate thesis in opening
  const mandateConfig = MANDATE_STRATEGIC_DIMENSIONS[mandate.primary_mandate];
  if (mandateConfig) {
    const openingLower = coverLetter.opening_paragraph.toLowerCase();
    const hasMandateSignal = mandateConfig.required_signals.some(s => openingLower.includes(s));
    if (!hasMandateSignal) {
      score -= 15;
      issues.push({
        dimension: "cover_letter",
        location: "opening_paragraph",
        issue: `Opening lacks mandate signal for ${mandate.primary_mandate.replace(/_/g, " ")}`,
        severity: "warning",
        auto_fixed: false,
      });
    }
  }

  // Check body paragraph count (must be 1-2)
  if (coverLetter.body_paragraphs.length > 2) {
    score -= 10;
    issues.push({
      dimension: "cover_letter",
      location: "body_paragraphs",
      issue: `${coverLetter.body_paragraphs.length} body paragraphs — max 2 for focused impact`,
      severity: "warning",
      auto_fixed: false,
    });
  }

  // Check for resume recap in body
  for (let i = 0; i < coverLetter.body_paragraphs.length; i++) {
    const para = coverLetter.body_paragraphs[i];
    for (const pattern of CL_RESUME_RECAP_PATTERNS) {
      if (pattern.test(para) && (para.match(/,/g) || []).length >= 3) {
        score -= 10;
        issues.push({
          dimension: "cover_letter",
          location: `body_paragraphs[${i}]`,
          issue: "Body paragraph reads as resume recap — use narrative framing",
          severity: "warning",
          auto_fixed: false,
        });
        break;
      }
    }
  }

  // Check closing for supplicant language
  const closingText = coverLetter.closing_paragraph;
  for (const pattern of CL_SUPPLICANT_PATTERNS) {
    if (pattern.test(closingText)) {
      score -= 15;
      issues.push({
        dimension: "cover_letter",
        location: "closing_paragraph",
        issue: `Supplicant language in closing: pattern matched — must use forward-looking contribution statement`,
        severity: "warning",
        auto_fixed: false,
      });
      break;
    }
  }

  // Check word count (250-350 target)
  const fullText = [
    coverLetter.salutation,
    coverLetter.opening_paragraph,
    ...coverLetter.body_paragraphs,
    coverLetter.closing_paragraph,
    coverLetter.sign_off,
  ].join(" ");
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;

  if (wordCount < 250 || wordCount > 350) {
    score -= 10;
    issues.push({
      dimension: "cover_letter",
      location: "word_count",
      issue: `Word count ${wordCount} outside 250-350 range`,
      severity: "warning",
      auto_fixed: false,
    });
  }

  // Check value claims exist and are backed
  if (!coverLetter.value_claims || coverLetter.value_claims.length === 0) {
    score -= 20;
    issues.push({
      dimension: "cover_letter",
      location: "value_claims",
      issue: "No value claims — cover letter must contain 1-3 specific, backed claims",
      severity: "blocking",
      auto_fixed: false,
    });
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    issues,
  };
}

// ── 5. DIFFERENTIATION MAINTENANCE ──────────────────────────────
//
// Flag summary/competency overlap with prior resumes.
// Enforce mandate-scoped competency ordering.

const STRUCTURAL_REWRITE_THRESHOLD = 0.35;
const COMPETENCY_OVERLAP_THRESHOLD = 0.50;

function wordOverlap(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const smaller = Math.min(wordsA.size, wordsB.size);
  return intersection.size / smaller;
}

function setOverlap(a: string[], b: string[]): number {
  const setA = new Set(a.map(c => c.toLowerCase().trim()));
  const setB = new Set(b.map(c => c.toLowerCase().trim()));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(c => setB.has(c)));
  const smaller = Math.min(setA.size, setB.size);
  return intersection.size / smaller;
}

/** Mandate keyword relevance for competency sorting. */
const MANDATE_COMP_KEYWORDS: Record<string, string[]> = {
  governance_standardization: ["governance", "compliance", "audit", "control", "framework", "quality", "risk", "standard"],
  bi_platform_modernization: ["platform", "cloud", "architecture", "pipeline", "infrastructure", "migration", "warehouse", "lake"],
  insight_delivery_automation: ["reporting", "dashboard", "self-service", "analytics", "insight", "automation", "visualization"],
  founder_adjacent_builder: ["startup", "zero-to-one", "product", "mvp", "agile", "lean", "build"],
  revenue_ops_forecasting: ["revenue", "forecast", "pricing", "financial", "p&l", "margin", "demand"],
  operating_model_transformation: ["operating model", "transformation", "change management", "process", "optimization", "redesign"],
  product_gtm_analytics: ["product", "go-to-market", "user", "adoption", "engagement", "feature", "journey"],
  growth_monetization: ["growth", "experiment", "a/b", "conversion", "funnel", "monetization", "testing"],
  executive_storytelling: ["storytelling", "board", "executive", "strategy", "advisory", "influence", "communication"],
  team_leadership_scale: ["leadership", "team", "talent", "organizational", "hiring", "mentoring", "scaling"],
};

export function checkDifferentiation(
  resume: TailoredResume,
  mandate: MandateProfile,
  priorSummaries?: string[],
  priorCompetencies?: string[][],
): {
  score: number;
  worst_summary_overlap: number;
  worst_competency_overlap: number;
  competencies_mandate_sorted: boolean;
  force_rewrite: boolean;
  issues: PositioningIssue[];
  actions_taken: string[];
} {
  const issues: PositioningIssue[] = [];
  const actions: string[] = [];
  let worstSummaryOverlap = 0;
  let worstCompOverlap = 0;
  let forceRewrite = false;

  // Check summary overlap against prior resumes
  if (priorSummaries && priorSummaries.length > 0) {
    for (const prior of priorSummaries) {
      const overlap = wordOverlap(resume.professional_summary, prior);
      if (overlap > worstSummaryOverlap) worstSummaryOverlap = overlap;
    }

    if (worstSummaryOverlap > STRUCTURAL_REWRITE_THRESHOLD) {
      forceRewrite = true;
      issues.push({
        dimension: "differentiation",
        location: "professional_summary",
        issue: `Summary overlap ${Math.round(worstSummaryOverlap * 100)}% exceeds ${STRUCTURAL_REWRITE_THRESHOLD * 100}% threshold — structural rewrite required`,
        severity: "blocking",
        auto_fixed: false,
      });
    } else if (worstSummaryOverlap > 0.25) {
      issues.push({
        dimension: "differentiation",
        location: "professional_summary",
        issue: `Summary overlap ${Math.round(worstSummaryOverlap * 100)}% approaching threshold`,
        severity: "warning",
        auto_fixed: false,
      });
    }
  }

  // Check competency overlap against prior resumes
  const currentComps = ((resume as any).core_competencies || []) as string[];
  if (priorCompetencies && priorCompetencies.length > 0) {
    for (const priorComps of priorCompetencies) {
      const overlap = setOverlap(currentComps, priorComps);
      if (overlap > worstCompOverlap) worstCompOverlap = overlap;
    }

    if (worstCompOverlap > COMPETENCY_OVERLAP_THRESHOLD) {
      issues.push({
        dimension: "differentiation",
        location: "core_competencies",
        issue: `Competency overlap ${Math.round(worstCompOverlap * 100)}% exceeds ${COMPETENCY_OVERLAP_THRESHOLD * 100}% — must reorganize by mandate`,
        severity: "warning",
        auto_fixed: false,
      });
    }
  }

  // Enforce mandate-scoped competency ordering (SAFE DETERMINISTIC MUTATION)
  const mandateKeywords = MANDATE_COMP_KEYWORDS[mandate.primary_mandate] || [];
  // First competency must be mandate-aligned — not just any of the top 3
  const mandateSorted = currentComps.length > 0 &&
    mandateKeywords.some(kw => currentComps[0].toLowerCase().includes(kw));

  if (!mandateSorted && currentComps.length > 0) {
    // Reorder competencies to lead with mandate-aligned ones
    const scored = currentComps.map(c => {
      const lower = c.toLowerCase();
      const mandateScore = mandateKeywords.filter(kw => lower.includes(kw)).length;
      return { comp: c, score: mandateScore };
    });
    scored.sort((a, b) => b.score - a.score);
    const reordered = scored.map(s => s.comp);

    // Only apply if the reordering actually changes something
    if (reordered[0] !== currentComps[0] || reordered[1] !== currentComps[1]) {
      (resume as any).core_competencies = reordered;
      actions.push(`Reordered competencies by mandate alignment (${mandate.primary_mandate})`);
      issues.push({
        dimension: "differentiation",
        location: "core_competencies",
        issue: "Competencies not mandate-sorted — reordered to lead with mandate-aligned skills",
        severity: "info",
        auto_fixed: true,
      });
    }
  }

  // Score calculation
  let score = 100;
  score -= Math.round(worstSummaryOverlap * 100 * 0.5);
  score -= Math.round(worstCompOverlap * 100 * 0.3);
  if (!mandateSorted) score -= 10;

  return {
    score: Math.max(0, Math.min(100, score)),
    worst_summary_overlap: Math.round(worstSummaryOverlap * 100),
    worst_competency_overlap: Math.round(worstCompOverlap * 100),
    competencies_mandate_sorted: mandateSorted || actions.length > 0,
    force_rewrite: forceRewrite,
    issues,
    actions_taken: actions,
  };
}

// ── 6. COMPOSITE SCORING & MAIN FUNCTION ────────────────────────

function computeGrade(composite: number): "A" | "B" | "C" | "D" | "F" {
  if (composite >= 90) return "A";
  if (composite >= 80) return "B";
  if (composite >= 70) return "C";
  if (composite >= 60) return "D";
  return "F";
}

/**
 * Run the Final Positioning Refinement Pass.
 *
 * Evaluates 6 positioning dimensions. Applies safe deterministic
 * mutations (corporate cliché replacement, competency reordering).
 * Returns structured scores, flags, and a pass/fail verdict.
 *
 * Does NOT fabricate facts. Does NOT add new content.
 * Does NOT break 2-page budget.
 */
export function runPositioningPass(input: PositioningInput): PositioningResult {
  const start = Date.now();
  const { resume, coverLetter, mandate, inventory, priorSummaries, priorCompetencies, logger } = input;
  const allIssues: PositioningIssue[] = [];
  const allActions: string[] = [];
  const blocking: string[] = [];

  logger?.info("🎯 [Positioning] Starting Final Positioning Refinement Pass...");

  // ── 1. Summary Mandate Anchoring ────────────────────────────────

  const summaryResult = checkSummaryMandateAnchoring(
    resume.professional_summary,
    mandate,
  );
  allIssues.push(...summaryResult.issues);
  for (const issue of summaryResult.issues) {
    if (issue.severity === "blocking") blocking.push(issue.issue);
  }
  logger?.info(`📝 [Positioning] Summary anchoring: ${summaryResult.score}/100 (anchored=${summaryResult.anchored})`);

  // ── 2. Bullet Impact Strengthening ──────────────────────────────

  const impactResult = checkBulletImpact(resume);
  allIssues.push(...impactResult.issues);
  for (const issue of impactResult.issues) {
    if (issue.severity === "blocking") blocking.push(issue.issue);
  }
  logger?.info(`💥 [Positioning] Bullet impact: ${impactResult.score}/100 (${impactResult.total_impact_bullets} impact bullets across ${impactResult.roles_with_impact} roles)`);

  // ── 3. Authority Without Hype ──────────────────────────────────

  const authorityResult = checkAuthorityTone(resume, inventory);
  allIssues.push(...authorityResult.issues);
  allActions.push(...authorityResult.actions_taken);
  logger?.info(`👔 [Positioning] Authority tone: ${authorityResult.score}/100 (${authorityResult.clichés_replaced} clichés replaced, ${authorityResult.safe_managerial_flags} managerial flags)`);

  // ── 4. Cover Letter QA ────────────────────────────────────────

  const clResult = checkCoverLetterPositioning(coverLetter, mandate);
  allIssues.push(...clResult.issues);
  for (const issue of clResult.issues) {
    if (issue.severity === "blocking") blocking.push(issue.issue);
  }
  logger?.info(`✉️ [Positioning] Cover letter: ${clResult.score}/100`);

  // ── 5. Differentiation Maintenance ────────────────────────────

  const diffResult = checkDifferentiation(
    resume,
    mandate,
    priorSummaries,
    priorCompetencies,
  );
  allIssues.push(...diffResult.issues);
  allActions.push(...diffResult.actions_taken);
  if (diffResult.force_rewrite) {
    blocking.push(`Summary overlap ${diffResult.worst_summary_overlap}% — structural rewrite required`);
  }
  logger?.info(`🔀 [Positioning] Differentiation: ${diffResult.score}/100 (summary overlap=${diffResult.worst_summary_overlap}%, comp overlap=${diffResult.worst_competency_overlap}%)`);

  // ── 6. Composite Scoring ──────────────────────────────────────

  // Weights: summary 25%, impact 25%, authority 20%, CL 15%, differentiation 15%
  const compositeScore = Math.round(
    summaryResult.score * 0.25 +
    impactResult.score * 0.25 +
    authorityResult.score * 0.20 +
    clResult.score * 0.15 +
    diffResult.score * 0.15,
  );

  const scores: PositioningScore = {
    summary_anchoring: summaryResult.score,
    bullet_impact: impactResult.score,
    authority_tone: authorityResult.score,
    cover_letter: clResult.score,
    differentiation: diffResult.score,
    composite: compositeScore,
    grade: computeGrade(compositeScore),
  };

  const passed = blocking.length === 0;
  const durationMs = Date.now() - start;

  logger?.info(`📊 [Positioning] Composite: ${compositeScore}/100 (${scores.grade}) — ${passed ? "PASS" : "FAIL"}`);
  if (!passed) {
    logger?.warn(`🚫 [Positioning] Blocking: ${blocking.join("; ")}`);
  }
  logger?.info(`🎯 [Positioning] Completed in ${durationMs}ms`);

  return {
    scores,
    issues: allIssues,
    actions_taken: allActions,
    passed,
    blocking_issues: blocking,
    duration_ms: durationMs,
  };
}
