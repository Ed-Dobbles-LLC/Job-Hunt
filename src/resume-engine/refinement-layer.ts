/**
 * Final Refinement Layer
 *
 * A deterministic post-pipeline quality gate that addresses 6 dimensions:
 *
 * 1. VERB INTEGRITY CONTROL — Controlled whitelist, no blind mutation.
 *    Every bullet verb validated against content category. Misaligned verbs flagged.
 *
 * 2. MANDATE-ANCHORING SUMMARY — First sentence must reflect dominant job mandate.
 *    No generic transformation-first phrasing. No reusable templates.
 *
 * 3. AUTHORITY WITHOUT HYPE — Measured confidence, no inflation.
 *    No board/investment attribution without ledger support.
 *
 * 4. DIFFERENTIATION STRENGTHENING — Tighter thresholds, phrase suppression.
 *    Summary >35% overlap forces structural rewrite flag.
 *
 * 5. QA STABILITY PASS — Spellcheck, malformed tokens, semantic verb validation,
 *    ownership inflation check, mandate alignment in summary + first 2 bullets.
 *
 * 6. REFINEMENT SCORING — Structured metrics per dimension.
 *
 * Type: DETERMINISTIC (no LLM calls)
 */

import type { TailoredResume } from "../mastra/tools/tailoredResumePrompt";
import type { MandateProfile } from "./stage2-mandate-classifier/classifier";
import type { ClaimsLedger } from "./types";

// ── Types ────────────────────────────────────────────────────────

export interface RefinementScore {
  verb_integrity: number;        // 0-100
  mandate_alignment: number;     // 0-100
  ownership_inflation: number;   // 0-100 (100 = no inflation)
  differentiation: number;       // 0-100
  executive_authority: number;   // 0-100
  composite: number;             // weighted average
  grade: "A" | "B" | "C" | "D" | "F";
}

export interface VerbIssue {
  location: string;
  verb: string;
  expected_category: string | null;
  actual_category: string | null;
  issue: "misaligned" | "hype" | "downgraded" | "semantic_drift";
  explanation: string;
  auto_fixed: boolean;
  baseline_verb?: string;
}

export interface HypeIssue {
  location: string;
  text: string;
  type: "hype_word" | "inflated_adjective" | "ungrounded_attribution";
  replacement?: string;
  auto_fixed: boolean;
}

export interface QAIssue {
  location: string;
  text: string;
  type: "malformed_token" | "spellcheck" | "ownership_inflation" | "mandate_gap" | "corruption";
  severity: "blocking" | "warning";
  explanation: string;
}

export interface RefinementResult {
  scores: RefinementScore;
  verb_issues: VerbIssue[];
  mandate_issues: string[];
  hype_issues: HypeIssue[];
  differentiation_issues: string[];
  qa_issues: QAIssue[];
  actions_taken: string[];
  passed: boolean;
  blocking_issues: string[];
  duration_ms: number;
}

export interface RefinementInput {
  resume: TailoredResume;
  mandate: MandateProfile;
  ledger?: ClaimsLedger;
  inventory?: Record<string, any>;
  priorSummaries?: string[];
  priorCompetencies?: string[][];
  logger?: any;
}

// ── 1. VERB WHITELIST ────────────────────────────────────────────
//
// Controlled verb categories. Each verb belongs to categories where
// it semantically fits. A verb is "aligned" if the bullet's content
// signals match the verb's category.

export const VERB_WHITELIST: Record<string, {
  verbs: Set<string>;
  content_signals: RegExp[];
  description: string;
}> = {
  build_scale: {
    verbs: new Set([
      "built", "scaled", "established", "assembled", "formed",
      "recruited", "staffed", "expanded", "grew", "hired",
      "launched", "created", "founded", "bootstrapped", "incubated",
    ]),
    content_signals: [
      /team/i, /organization/i, /function/i, /\d+-person/i, /headcount/i,
      /hired/i, /practice/i, /department/i, /FTE/i, /from\s+\d+\s+to\s+\d+/i,
      /center of excellence/i, /capability/i, /pod/i, /squad/i,
    ],
    description: "Building teams, organizations, or functions",
  },
  transform_redesign: {
    verbs: new Set([
      "transformed", "redesigned", "restructured", "overhauled",
      "reengineered", "consolidated", "modernized", "repositioned",
      "realigned", "revamped", "retooled",
    ]),
    content_signals: [
      /operating model/i, /process/i, /workflow/i, /organizational/i,
      /legacy/i, /transition/i, /restructur/i, /before.*after/i,
      /from.*to/i, /migration/i, /overhaul/i,
    ],
    description: "Transforming processes, models, or structures",
  },
  generate_drive: {
    verbs: new Set([
      "generated", "drove", "delivered", "produced", "captured",
      "secured", "achieved", "accelerated", "increased", "boosted",
      "recovered", "recaptured", "monetized", "yielded", "attained",
    ]),
    content_signals: [
      /\$[\d.]+[MBK]/i, /\d+%/i, /revenue/i, /growth/i, /savings/i,
      /ROI/i, /profit/i, /margin/i, /pipeline/i, /ARR/i, /EBITDA/i,
      /cost\s+reduc/i, /cost\s+sav/i,
    ],
    description: "Driving revenue, growth, or measurable outcomes",
  },
  implement_deploy: {
    verbs: new Set([
      "implemented", "deployed", "integrated", "automated", "architected",
      "migrated", "engineered", "configured", "developed", "designed",
      "replatformed", "instrumented", "unified",
    ]),
    content_signals: [
      /platform/i, /system/i, /infrastructure/i, /pipeline/i, /cloud/i,
      /API/i, /tool/i, /framework/i, /stack/i, /Snowflake/i, /dbt/i,
      /Spark/i, /Kubernetes/i, /ETL/i, /data\s+lake/i, /warehouse/i,
    ],
    description: "Implementing, deploying, or automating systems",
  },
  standardize_operationalize: {
    verbs: new Set([
      "standardized", "operationalized", "codified", "formalized",
      "instituted", "governed", "defined", "enacted", "embedded",
      "enforced", "introduced",
    ]),
    content_signals: [
      /governance/i, /standard/i, /compliance/i, /policy/i,
      /methodology/i, /quality/i, /audit/i, /framework/i,
      /best practice/i, /SOX/i, /cadence/i,
    ],
    description: "Establishing standards, governance, or frameworks",
  },
  influence_advise: {
    verbs: new Set([
      "influenced", "advised", "briefed", "positioned", "counseled",
      "steered", "shaped", "partnered",
    ]),
    content_signals: [
      /board/i, /c-suite/i, /executive/i, /CEO/i, /CTO/i, /CFO/i,
      /stakeholder/i, /advisory/i, /strategic\s+direction/i, /leadership/i,
    ],
    description: "Influencing or advising senior leadership",
  },
  optimize_improve: {
    verbs: new Set([
      "optimized", "streamlined", "reduced", "eliminated", "improved",
      "refined", "replaced", "cut", "compressed",
    ]),
    content_signals: [
      /cost/i, /efficiency/i, /latency/i, /cycle\s*time/i, /redundan/i,
      /waste/i, /bottleneck/i, /turnaround/i, /SLA/i, /downtime/i,
    ],
    description: "Optimizing processes or reducing inefficiencies",
  },
  mentor_develop: {
    verbs: new Set([
      "mentored", "coached", "developed", "trained", "elevated",
      "guided", "nurtured",
    ]),
    content_signals: [
      /mentor/i, /coach/i, /develop/i, /talent/i, /career/i,
      /promoted/i, /retention/i, /succession/i, /training/i,
      /upskill/i, /onboard/i,
    ],
    description: "Mentoring, coaching, or developing people",
  },
};

/**
 * All approved verbs across all categories (flat set for quick lookup).
 */
export const ALL_APPROVED_VERBS = new Set<string>();
for (const cat of Object.values(VERB_WHITELIST)) {
  for (const verb of cat.verbs) {
    ALL_APPROVED_VERBS.add(verb);
  }
}

/**
 * Infer the content category of a bullet from keyword signals.
 * Returns the best-matching category, or null if ambiguous.
 */
export function inferContentCategory(bulletText: string): string | null {
  let bestCategory: string | null = null;
  let bestScore = 0;

  for (const [category, { content_signals }] of Object.entries(VERB_WHITELIST)) {
    const score = content_signals.filter(sig => sig.test(bulletText)).length;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestScore >= 1 ? bestCategory : null;
}

/**
 * Find which whitelist categories a verb belongs to.
 */
export function getVerbCategories(verb: string): string[] {
  const lower = verb.toLowerCase();
  const categories: string[] = [];
  for (const [category, { verbs }] of Object.entries(VERB_WHITELIST)) {
    if (verbs.has(lower)) categories.push(category);
  }
  return categories;
}

/**
 * Check if a verb is semantically aligned with its bullet content.
 * Returns null if aligned, or an explanation if misaligned.
 */
export function checkVerbAlignment(verb: string, bulletText: string): {
  aligned: boolean;
  verb_categories: string[];
  content_category: string | null;
  explanation: string;
} {
  const verbCategories = getVerbCategories(verb);
  const contentCategory = inferContentCategory(bulletText);

  // If the verb isn't in any whitelist category, it's novel — don't flag
  if (verbCategories.length === 0) {
    return { aligned: true, verb_categories: [], content_category: contentCategory, explanation: "Verb not in whitelist — accepted as-is" };
  }

  // If content category is ambiguous, accept the verb
  if (!contentCategory) {
    return { aligned: true, verb_categories: verbCategories, content_category: null, explanation: "Content category ambiguous — verb accepted" };
  }

  // Check if the verb's categories overlap with the content category
  if (verbCategories.includes(contentCategory)) {
    return { aligned: true, verb_categories: verbCategories, content_category: contentCategory, explanation: "Verb aligned with content" };
  }

  return {
    aligned: false,
    verb_categories: verbCategories,
    content_category: contentCategory,
    explanation: `Verb "${verb}" belongs to [${verbCategories.join(", ")}] but bullet content signals [${contentCategory}]`,
  };
}

// ── 2. MANDATE-ANCHORING SUMMARY ────────────────────────────────

const MANDATE_FIRST_SENTENCE_KEYWORDS: Record<string, string[]> = {
  governance_standardization: ["governance", "compliance", "standardiz", "audit", "control", "framework", "metric discipline", "data quality", "reporting rigor"],
  bi_platform_modernization: ["platform", "architect", "moderniz", "migrat", "cloud", "infrastructure", "pipeline", "data lake", "warehouse", "replatform"],
  insight_delivery_automation: ["insight", "self-service", "reporting", "dashboard", "stakeholder", "decision", "automat", "clarity"],
  founder_adjacent_builder: ["built from", "zero-to-one", "stood up", "founder", "ceo partner", "startup", "first hire", "from scratch"],
  revenue_ops_forecasting: ["revenue", "forecast", "pricing", "demand", "p&l", "margin", "commercial", "financial"],
  operating_model_transformation: ["operating model", "transform", "embed", "democratiz", "reorganiz", "change management", "redesign"],
  product_gtm_analytics: ["product", "go-to-market", "gtm", "feature", "adoption", "user journey", "engagement"],
  growth_monetization: ["growth", "experiment", "a/b test", "conversion", "monetiz", "funnel"],
  executive_storytelling: ["board", "c-suite", "advisory", "storytelling", "strategic", "influence", "decision"],
  team_leadership_scale: ["team", "hired", "scaled", "organizational design", "talent", "people", "culture"],
};

const GENERIC_SUMMARY_PATTERNS: RegExp[] = [
  /^(?:data|analytics)\s+(?:and\s+)?(?:analytics\s+)?(?:leader|executive|professional)\s+(?:who|with|that)\b/i,
  /^(?:seasoned|accomplished|dynamic|experienced|senior|results-driven|data-driven|forward-thinking)\s+/i,
  /^(?:proven|established|recognized|respected)\s+(?:leader|executive|professional)\b/i,
  /^(?:transforming|driving|leading|building|delivering)\s+(?:organizations?|businesses?|teams?|growth)\b/i,
  /^(?:a\s+)?(?:passionate|dedicated|committed)\s+/i,
];

/**
 * Check if the summary first sentence is mandate-anchored.
 */
export function checkMandateAnchoredSummary(
  summary: string,
  mandate: MandateProfile,
): {
  first_sentence_anchored: boolean;
  uses_generic_opener: boolean;
  matched_generic_pattern: string | null;
  revenue_first_non_revenue: boolean;
  mandate_keywords_found: number;
  issues: string[];
} {
  const firstSentence = summary.split(/[.!?]\s/)[0] || "";
  const firstSentenceLower = firstSentence.toLowerCase();
  const issues: string[] = [];

  // Check for generic openers
  let matchedGenericPattern: string | null = null;
  for (const pattern of GENERIC_SUMMARY_PATTERNS) {
    if (pattern.test(firstSentence)) {
      matchedGenericPattern = firstSentence.substring(0, 60);
      issues.push(`Summary opens with generic pattern: "${matchedGenericPattern}..."`);
      break;
    }
  }

  // Check for mandate keywords in first sentence
  const mandateKeywords = MANDATE_FIRST_SENTENCE_KEYWORDS[mandate.primary_mandate] || [];
  let mandateKeywordsFound = 0;
  for (const kw of mandateKeywords) {
    if (firstSentenceLower.includes(kw)) mandateKeywordsFound++;
  }

  const firstSentenceAnchored = mandateKeywordsFound >= 1 && !matchedGenericPattern;

  if (!firstSentenceAnchored && mandateKeywordsFound === 0) {
    issues.push(`First sentence lacks mandate keywords for ${mandate.primary_mandate.replace(/_/g, " ")}`);
  }

  // Check for revenue-first framing in non-revenue roles
  const REVENUE_MANDATES = new Set(["revenue_ops_forecasting", "growth_monetization"]);
  const revenuePatterns = [/\$[\d.]+[MBK]/i, /revenue/i, /ARR/i, /margin/i, /EBITDA/i];
  const isRevenueFirst = revenuePatterns.some(p => p.test(firstSentence));
  const revenueFirstNonRevenue = isRevenueFirst && !REVENUE_MANDATES.has(mandate.primary_mandate);

  if (revenueFirstNonRevenue) {
    issues.push("Summary leads with revenue framing but role is not monetization-led");
  }

  return {
    first_sentence_anchored: firstSentenceAnchored,
    uses_generic_opener: !!matchedGenericPattern,
    matched_generic_pattern: matchedGenericPattern,
    revenue_first_non_revenue: revenueFirstNonRevenue,
    mandate_keywords_found: mandateKeywordsFound,
    issues,
  };
}

// ── 3. AUTHORITY WITHOUT HYPE ───────────────────────────────────

/** Inflated adjectives that undermine executive credibility. */
export const INFLATED_ADJECTIVES: { pattern: RegExp; replacement: string; label: string }[] = [
  { pattern: /\bsingle-handedly\b/gi, replacement: "independently", label: "single-handedly" },
  { pattern: /\bfirst-ever\b/gi, replacement: "first", label: "first-ever" },
  { pattern: /\bnever-before-seen\b/gi, replacement: "new", label: "never-before-seen" },
  { pattern: /\bunprecedented\b/gi, replacement: "notable", label: "unprecedented" },
  { pattern: /\bexponential(?:ly)?\b/gi, replacement: "substantial", label: "exponential" },
  { pattern: /\bmassive\b/gi, replacement: "large-scale", label: "massive" },
  { pattern: /\btransformative\b/gi, replacement: "impactful", label: "transformative" },
  { pattern: /\bextraordinary\b/gi, replacement: "strong", label: "extraordinary" },
  { pattern: /\bphenomenal\b/gi, replacement: "strong", label: "phenomenal" },
  { pattern: /\bstellar\b/gi, replacement: "strong", label: "stellar" },
  { pattern: /\bunrivaled\b/gi, replacement: "competitive", label: "unrivaled" },
  { pattern: /\bunmatched\b/gi, replacement: "competitive", label: "unmatched" },
  { pattern: /\bunparalleled\b/gi, replacement: "industry-leading", label: "unparalleled" },
  { pattern: /\bpowerhouse\b/gi, replacement: "high-performing", label: "powerhouse" },
  { pattern: /\bseismic\b/gi, replacement: "significant", label: "seismic" },
];

/** Patterns that claim board/investment authority without explicit support. */
const UNGROUNDED_AUTHORITY_PATTERNS: { pattern: RegExp; label: string; requires_ledger: boolean }[] = [
  { pattern: /\b(?:drove|led|directed)\s+board\s+(?:decision|vote|approval)/i, label: "board decision attribution", requires_ledger: true },
  { pattern: /\b(?:secured|raised|closed)\s+\$[\d.]+[MBK]?\s+(?:in\s+)?(?:funding|investment|capital)/i, label: "funding/investment attribution", requires_ledger: true },
  { pattern: /\b(?:owned|drove)\s+(?:the\s+)?(?:strategic|corporate)\s+(?:pivot|direction|agenda)/i, label: "strategic pivot attribution", requires_ledger: true },
  { pattern: /\bsingle-handedly\s+(?:built|created|designed|transformed)/i, label: "sole credit attribution", requires_ledger: true },
  { pattern: /\b(?:advised|counseled)\s+(?:the\s+)?(?:CEO|CFO|CTO|COO|board)\b/i, label: "C-suite advisory attribution", requires_ledger: true },
];

/**
 * Check for hype and inflated language. Returns issues found.
 * Auto-fixes inflated adjectives in-place.
 */
export function checkAuthorityWithoutHype(
  resume: TailoredResume,
  inventory?: Record<string, any>,
): { issues: HypeIssue[]; actions_taken: string[] } {
  const issues: HypeIssue[] = [];
  const actions: string[] = [];
  const inventoryText = inventory ? JSON.stringify(inventory).toLowerCase() : "";

  function scanAndFix(text: string, location: string): string {
    let result = text;

    // Check inflated adjectives — auto-fix
    for (const adj of INFLATED_ADJECTIVES) {
      adj.pattern.lastIndex = 0;
      const match = result.match(adj.pattern);
      if (match) {
        result = result.replace(adj.pattern, adj.replacement);
        issues.push({
          location,
          text: match[0],
          type: "inflated_adjective",
          replacement: adj.replacement,
          auto_fixed: true,
        });
        actions.push(`Replaced inflated adjective "${match[0]}" → "${adj.replacement}" at ${location}`);
      }
    }

    // Check ungrounded authority claims — flag only
    for (const claim of UNGROUNDED_AUTHORITY_PATTERNS) {
      claim.pattern.lastIndex = 0;
      const match = result.match(claim.pattern);
      if (match) {
        // Check if the inventory supports this claim
        const supported = inventoryText && inventoryText.includes(match[0].toLowerCase().split(/\s+/).slice(0, 3).join(" "));
        if (!supported) {
          issues.push({
            location,
            text: match[0],
            type: "ungrounded_attribution",
            auto_fixed: false,
          });
        }
      }
    }

    return result;
  }

  // Scan summary
  resume.professional_summary = scanAndFix(resume.professional_summary, "summary");

  // Scan bullets
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      resume.experience[i].bullets[j].text = scanAndFix(
        resume.experience[i].bullets[j].text,
        `experience[${i}].bullets[${j}]`,
      );
    }
    const exp = resume.experience[i] as any;
    if (exp.scope_line) {
      exp.scope_line = scanAndFix(exp.scope_line, `experience[${i}].scope_line`);
    }
  }

  return { issues, actions_taken: actions };
}

// ── 4. DIFFERENTIATION STRENGTHENING ────────────────────────────

const STRUCTURAL_REWRITE_THRESHOLD = 0.35; // > 35% summary overlap → force structural rewrite

/**
 * Check differentiation against prior outputs.
 * Returns issues and whether a structural rewrite is needed.
 */
export function checkDifferentiationStrength(
  resume: TailoredResume,
  mandate: MandateProfile,
  priorSummaries?: string[],
  priorCompetencies?: string[][],
): {
  issues: string[];
  force_structural_rewrite: boolean;
  worst_summary_overlap: number;
  worst_competency_overlap: number;
  competencies_mandate_sorted: boolean;
} {
  const issues: string[] = [];
  let worstSummaryOverlap = 0;
  let worstCompOverlap = 0;
  let forceRewrite = false;

  if (priorSummaries && priorSummaries.length > 0) {
    for (const prior of priorSummaries) {
      const overlap = wordOverlap(resume.professional_summary, prior);
      if (overlap > worstSummaryOverlap) worstSummaryOverlap = overlap;
    }

    if (worstSummaryOverlap > STRUCTURAL_REWRITE_THRESHOLD) {
      forceRewrite = true;
      issues.push(`Summary overlap ${Math.round(worstSummaryOverlap * 100)}% exceeds ${STRUCTURAL_REWRITE_THRESHOLD * 100}% threshold — structural rewrite required`);
    } else if (worstSummaryOverlap > 0.25) {
      issues.push(`Summary overlap ${Math.round(worstSummaryOverlap * 100)}% approaching threshold`);
    }
  }

  // Check competency cluster overlap
  const currentComps = ((resume as any).core_competencies || []) as string[];
  if (priorCompetencies && priorCompetencies.length > 0) {
    for (const priorComps of priorCompetencies) {
      const overlap = setOverlap(currentComps, priorComps);
      if (overlap > worstCompOverlap) worstCompOverlap = overlap;
    }

    if (worstCompOverlap > 0.50) {
      issues.push(`Competency overlap ${Math.round(worstCompOverlap * 100)}% — must reorganize based on mandate`);
    }
  }

  // Check if competencies are mandate-sorted (top competencies should match mandate keywords)
  const mandateKeywords = MANDATE_FIRST_SENTENCE_KEYWORDS[mandate.primary_mandate] || [];
  const topComps = currentComps.slice(0, 3);
  const mandateSorted = topComps.some(comp =>
    mandateKeywords.some(kw => comp.toLowerCase().includes(kw)),
  );

  if (!mandateSorted && currentComps.length > 0) {
    issues.push("Top competencies not mandate-sorted — reorganize to lead with mandate-aligned skills");
  }

  return {
    issues,
    force_structural_rewrite: forceRewrite,
    worst_summary_overlap: Math.round(worstSummaryOverlap * 100),
    worst_competency_overlap: Math.round(worstCompOverlap * 100),
    competencies_mandate_sorted: mandateSorted,
  };
}

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

// ── Phrase Suppression List ─────────────────────────────────────

export const PHRASE_SUPPRESSION_LIST: string[] = [
  "track record of", "proven ability to", "extensive experience in",
  "passionate about", "results-oriented", "data-driven leader",
  "forward-thinking leader", "thought leader", "seasoned executive",
  "accomplished leader", "dynamic leader", "visionary leader",
  "cross-functional collaboration", "stakeholder management",
  "end-to-end", "best-in-class", "world-class", "cutting-edge",
  "state-of-the-art", "next-generation", "industry-leading",
  "leveraging data", "actionable insights", "data-informed decisions",
  "driving value", "unlocking value", "creating value", "delivering value",
  "fostering a culture of", "building a culture of",
  "spearheaded the development", "instrumental in", "at the forefront of",
  "played a pivotal role", "served as a trusted advisor",
  "unique combination of", "rare blend of", "deep expertise in",
  "strong background in", "adept at navigating",
  "translating complex data into", "translating insights into action",
  "career defined by", "comprehensive understanding of",
];

/**
 * Scan resume for suppressed phrases. Returns all found.
 */
export function findSuppressedPhrasesInResume(resume: TailoredResume): string[] {
  const fullText = [
    resume.professional_summary,
    ...resume.experience.flatMap(e => [
      e.scope_line || "",
      ...e.bullets.map(b => b.text),
    ]),
  ].join(" ").toLowerCase();

  return PHRASE_SUPPRESSION_LIST.filter(phrase => fullText.includes(phrase.toLowerCase()));
}

// ── 5. QA STABILITY PASS ────────────────────────────────────────

/**
 * Comprehensive QA check: spellcheck, malformed tokens, semantic verb
 * validation, ownership inflation, mandate alignment.
 */
function runQAStabilityPass(
  resume: TailoredResume,
  mandate: MandateProfile,
  verbIssues: VerbIssue[],
  inventory?: Record<string, any>,
): QAIssue[] {
  const issues: QAIssue[] = [];

  function scanText(text: string, location: string) {
    const words = text.split(/\s+/);
    for (const raw of words) {
      const word = raw.replace(/[^a-zA-Z'-]/g, "");
      if (word.length < 3) continue;

      // Malformed token: impossible consonant clusters
      if (/^[bcdfghjklmnpqrstvwxyz]{4,}/i.test(word)) {
        issues.push({ location, text: raw, type: "malformed_token", severity: "blocking", explanation: "Impossible consonant cluster at word start" });
      }
      if (/[bcdfghjklmnpqrstvwxyz]{4,}$/i.test(word)) {
        issues.push({ location, text: raw, type: "malformed_token", severity: "blocking", explanation: "Impossible consonant cluster at word end" });
      }

      // Triple+ same letter
      if (/(.)\1{2,}/i.test(word)) {
        const tripled = word.match(/(.)\1{2,}/)?.[0] || "";
        if (tripled.length >= 3) {
          issues.push({ location, text: raw, type: "spellcheck", severity: "blocking", explanation: `Tripled letter: "${tripled}"` });
        }
      }

      // Doubled suffixes (skip legitimate words)
      const lower = word.toLowerCase();
      const LEGIT_EDED = new Set(["succeeded", "exceeded", "preceded", "proceeded", "needed", "seeded", "heeded", "superseded", "conceded", "impeded"]);
      if (lower.endsWith("eded") && lower.length > 6 && !LEGIT_EDED.has(lower)) {
        issues.push({ location, text: raw, type: "corruption", severity: "blocking", explanation: "Doubled -ed suffix" });
      }
      const LEGIT_INGING = new Set(["singing", "bringing", "ringing", "stinging", "clinging", "swinging", "springing"]);
      if (lower.endsWith("inging") && lower.length > 8 && !LEGIT_INGING.has(lower)) {
        issues.push({ location, text: raw, type: "corruption", severity: "blocking", explanation: "Doubled -ing suffix" });
      }
    }
  }

  // Scan all text sections
  scanText(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
    const exp = resume.experience[i] as any;
    if (exp.scope_line) scanText(exp.scope_line, `experience[${i}].scope_line`);
  }

  // Semantic verb validation (convert verb issues to QA issues)
  const misaligned = verbIssues.filter(v => v.issue === "misaligned" || v.issue === "semantic_drift");
  if (misaligned.length > 0) {
    issues.push({
      location: "verbs",
      text: misaligned.map(v => v.verb).join(", "),
      type: "malformed_token",
      severity: "warning",
      explanation: `${misaligned.length} verb(s) semantically misaligned with bullet content`,
    });
  }

  // Ownership inflation check (escalation patterns)
  const ESCALATION_PATTERNS: { weak: RegExp; strong: RegExp; label: string }[] = [
    { weak: /contributed/i, strong: /\b(?:built|created|architected|owned)\b/i, label: "contributor → owner" },
    { weak: /team member/i, strong: /\bsingle-handedly\b/i, label: "team member → sole credit" },
    { weak: /(?:assisted|helped|supported)/i, strong: /\b(?:led|drove|directed|transformed)\b/i, label: "helper → leader" },
  ];

  const inventoryText = inventory ? JSON.stringify(inventory).toLowerCase() : "";

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const bulletLower = bullet.text.toLowerCase();

      for (const pattern of ESCALATION_PATTERNS) {
        if (pattern.strong.test(bulletLower)) {
          // Check if the inventory only has the weak form
          const sourceHash = bullet.source_hash || "";
          const evidence = bullet.evidence_quote || "";
          const sourceText = (evidence + " " + sourceHash).toLowerCase();
          if (sourceText && pattern.weak.test(sourceText) && !pattern.strong.test(sourceText)) {
            issues.push({
              location: `experience[${i}].bullets[${j}]`,
              text: bullet.text.substring(0, 60),
              type: "ownership_inflation",
              severity: "warning",
              explanation: `Ownership escalation: ${pattern.label}`,
            });
          }
        }
      }
    }
  }

  // Mandate alignment in summary and first 2 bullets
  const mandateKeywords = MANDATE_FIRST_SENTENCE_KEYWORDS[mandate.primary_mandate] || [];
  const firstTwoBullets = resume.experience.slice(0, 2).flatMap(e => e.bullets.slice(0, 2));
  let alignedBullets = 0;
  for (const bullet of firstTwoBullets) {
    const bulletLower = bullet.text.toLowerCase();
    if (mandateKeywords.some(kw => bulletLower.includes(kw))) {
      alignedBullets++;
    }
  }

  if (firstTwoBullets.length > 0 && alignedBullets === 0) {
    issues.push({
      location: "experience[0-1].bullets[0-1]",
      text: "First 2 bullets across top roles",
      type: "mandate_gap",
      severity: "warning",
      explanation: `None of the first 2 bullets per role align with primary mandate (${mandate.primary_mandate.replace(/_/g, " ")})`,
    });
  }

  return issues;
}

// ── 6. SCORING ──────────────────────────────────────────────────

function computeVerbIntegrityScore(verbIssues: VerbIssue[]): number {
  let score = 100;
  for (const issue of verbIssues) {
    switch (issue.issue) {
      case "misaligned": score -= 15; break;
      case "hype": score -= 10; break;
      case "downgraded": score -= 12; break;
      case "semantic_drift": score -= 15; break;
    }
  }
  return Math.max(0, Math.min(100, score));
}

function computeMandateAlignmentScore(
  mandateCheck: ReturnType<typeof checkMandateAnchoredSummary>,
  resume: TailoredResume,
  mandate: MandateProfile,
): number {
  let score = 0;
  const mandateKeywords = MANDATE_FIRST_SENTENCE_KEYWORDS[mandate.primary_mandate] || [];

  // 35% — first sentence anchored to mandate
  if (mandateCheck.first_sentence_anchored) score += 35;
  else if (mandateCheck.mandate_keywords_found > 0) score += 15;

  // 15% — no generic opener
  if (!mandateCheck.uses_generic_opener) score += 15;

  // 10% — no revenue-first for non-revenue role
  if (!mandateCheck.revenue_first_non_revenue) score += 10;

  // 40% — first 2 bullets per role aligned with mandate
  const firstTwoBullets = resume.experience.flatMap(e => e.bullets.slice(0, 2));
  let aligned = 0;
  for (const bullet of firstTwoBullets) {
    const lower = bullet.text.toLowerCase();
    if (mandateKeywords.some(kw => lower.includes(kw))) aligned++;
  }
  const bulletPct = firstTwoBullets.length > 0 ? aligned / firstTwoBullets.length : 0;
  score += Math.round(bulletPct * 40);

  return Math.max(0, Math.min(100, score));
}

function computeOwnershipInflationScore(qaIssues: QAIssue[]): number {
  const inflationIssues = qaIssues.filter(i => i.type === "ownership_inflation");
  let score = 100;
  for (const issue of inflationIssues) {
    score -= issue.severity === "blocking" ? 25 : 10;
  }
  return Math.max(0, Math.min(100, score));
}

function computeExecutiveAuthorityScore(
  resume: TailoredResume,
  hypeIssues: HypeIssue[],
): number {
  let score = 100;

  // Deduct for hype/inflated language
  score -= hypeIssues.filter(h => h.type === "hype_word" || h.type === "inflated_adjective").length * 5;

  // Deduct for ungrounded authority claims
  score -= hypeIssues.filter(h => h.type === "ungrounded_attribution").length * 15;

  // Check for soft verb openers
  const SOFT_VERBS = ["supported", "helped", "contributed", "assisted", "participated", "aided", "facilitated"];
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      const firstWord = bullet.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      if (SOFT_VERBS.includes(firstWord)) score -= 8;
    }
  }

  // Check for passive voice
  const PASSIVE_PATTERNS = [/^was\s/i, /^were\s/i, /^has been\s/i, /^have been\s/i];
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      if (PASSIVE_PATTERNS.some(p => p.test(bullet.text))) score -= 10;
    }
  }

  // Check for hedge phrases
  const HEDGE_PHRASES = ["i believe", "i think", "helped to", "tried to", "attempted to", "sought to"];
  const fullText = [
    resume.professional_summary,
    ...resume.experience.flatMap(e => e.bullets.map(b => b.text)),
  ].join(" ").toLowerCase();
  for (const hedge of HEDGE_PHRASES) {
    if (fullText.includes(hedge)) score -= 12;
  }

  return Math.max(0, Math.min(100, score));
}

// ── MAIN REFINEMENT FUNCTION ────────────────────────────────────

/**
 * Run the complete Final Refinement Layer.
 *
 * Mutates the resume in-place for auto-fixable issues (inflated adjectives).
 * Returns structured scores and issues for all other checks.
 */
export function runRefinementLayer(input: RefinementInput): RefinementResult {
  const start = Date.now();
  const { resume, mandate, ledger, inventory, priorSummaries, priorCompetencies, logger } = input;
  const verbIssues: VerbIssue[] = [];
  const allActions: string[] = [];
  const blocking: string[] = [];

  logger?.info("🔬 [Refinement] Starting Final Refinement Layer...");

  // ── 1. Verb Integrity Control ──────────────────────────────────

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const firstWord = bullet.text.trim().split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, "") || "";
      const verb = firstWord.toLowerCase();
      const location = `experience[${i}].bullets[${j}]`;

      if (!verb || verb.length < 3) continue;

      const alignment = checkVerbAlignment(verb, bullet.text);

      if (!alignment.aligned) {
        verbIssues.push({
          location,
          verb: firstWord,
          expected_category: alignment.content_category,
          actual_category: alignment.verb_categories[0] || null,
          issue: "misaligned",
          explanation: alignment.explanation,
          auto_fixed: false,
        });
      }

      // Check for hype verbs
      const HYPE_VERBS = ["catalyzed", "revolutionized", "disrupted", "synergized", "ideated", "evangelized"];
      if (HYPE_VERBS.includes(verb)) {
        verbIssues.push({
          location,
          verb: firstWord,
          expected_category: alignment.content_category,
          actual_category: null,
          issue: "hype",
          explanation: `Hype verb "${verb}" undermines credibility`,
          auto_fixed: false,
        });
      }
    }
  }

  const verbIntegrityScore = computeVerbIntegrityScore(verbIssues);
  logger?.info(`🔤 [Refinement] Verb integrity: ${verbIntegrityScore}/100 (${verbIssues.length} issue(s))`);

  // ── 2. Mandate-Anchoring Summary ──────────────────────────────

  const mandateCheck = checkMandateAnchoredSummary(resume.professional_summary, mandate);
  const mandateAlignmentScore = computeMandateAlignmentScore(mandateCheck, resume, mandate);
  const mandateIssues = mandateCheck.issues;

  if (mandateCheck.uses_generic_opener) {
    blocking.push(`Generic summary opener: "${mandateCheck.matched_generic_pattern}"`);
  }

  logger?.info(`🎯 [Refinement] Mandate alignment: ${mandateAlignmentScore}/100 (${mandateIssues.length} issue(s))`);

  // ── 3. Authority Without Hype ─────────────────────────────────

  const hypeResult = checkAuthorityWithoutHype(resume, inventory);
  allActions.push(...hypeResult.actions_taken);

  const executiveAuthorityScore = computeExecutiveAuthorityScore(resume, hypeResult.issues);

  for (const issue of hypeResult.issues) {
    if (issue.type === "ungrounded_attribution") {
      blocking.push(`Ungrounded authority claim: "${issue.text}" at ${issue.location}`);
    }
  }

  logger?.info(`👔 [Refinement] Executive authority: ${executiveAuthorityScore}/100 (${hypeResult.issues.length} hype issue(s))`);

  // ── 4. Differentiation Strengthening ──────────────────────────

  const diffCheck = checkDifferentiationStrength(resume, mandate, priorSummaries, priorCompetencies);
  const differentiationScore = Math.max(0, 100 - diffCheck.worst_summary_overlap * 2 - diffCheck.worst_competency_overlap);

  if (diffCheck.force_structural_rewrite) {
    blocking.push(`Summary similarity ${diffCheck.worst_summary_overlap}% exceeds 35% — structural rewrite required`);
  }

  // Phrase suppression check
  const suppressedFound = findSuppressedPhrasesInResume(resume);
  if (suppressedFound.length > 0) {
    diffCheck.issues.push(`${suppressedFound.length} suppressed phrase(s) found: ${suppressedFound.slice(0, 3).map(p => `"${p}"`).join(", ")}`);
  }

  logger?.info(`🔀 [Refinement] Differentiation: ${differentiationScore}/100 (${diffCheck.issues.length} issue(s))`);

  // ── 5. QA Stability Pass ──────────────────────────────────────

  const qaIssues = runQAStabilityPass(resume, mandate, verbIssues, inventory);
  const ownershipInflationScore = computeOwnershipInflationScore(qaIssues);

  const blockingQA = qaIssues.filter(i => i.severity === "blocking");
  for (const bqa of blockingQA) {
    blocking.push(`QA: ${bqa.explanation} at ${bqa.location}`);
  }

  logger?.info(`🔎 [Refinement] Ownership inflation: ${ownershipInflationScore}/100, QA issues: ${qaIssues.length}`);

  // ── 6. Composite Scoring ──────────────────────────────────────

  // Weights: verb 20%, mandate 25%, ownership 20%, differentiation 15%, authority 20%
  const composite = Math.round(
    verbIntegrityScore * 0.20 +
    mandateAlignmentScore * 0.25 +
    ownershipInflationScore * 0.20 +
    differentiationScore * 0.15 +
    executiveAuthorityScore * 0.20,
  );

  const grade = composite >= 90 ? "A"
    : composite >= 80 ? "B"
    : composite >= 70 ? "C"
    : composite >= 60 ? "D"
    : "F" as const;

  const scores: RefinementScore = {
    verb_integrity: verbIntegrityScore,
    mandate_alignment: mandateAlignmentScore,
    ownership_inflation: ownershipInflationScore,
    differentiation: differentiationScore,
    executive_authority: executiveAuthorityScore,
    composite,
    grade,
  };

  const passed = blocking.length === 0;

  logger?.info(`📊 [Refinement] Composite: ${composite}/100 (${grade}) — ${passed ? "PASS" : "FAIL"}`);
  if (!passed) {
    logger?.warn(`🚫 [Refinement] Blocking: ${blocking.join("; ")}`);
  }

  return {
    scores,
    verb_issues: verbIssues,
    mandate_issues: mandateIssues,
    hype_issues: hypeResult.issues,
    differentiation_issues: diffCheck.issues,
    qa_issues: qaIssues,
    actions_taken: allActions,
    passed,
    blocking_issues: blocking,
    duration_ms: Date.now() - start,
  };
}
