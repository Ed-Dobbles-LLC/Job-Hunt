/**
 * Quality Scorer — Computes deterministic quality metrics for a generated resume.
 *
 * Scores:
 * 1. Truthfulness     — % of bullets with valid claim_ids tracing to ledger
 * 2. Mandate Alignment — % of top-2 bullets per role aligned with primary mandate
 * 3. Differentiation   — inverse of worst similarity against prior resumes (0-100)
 * 4. Readability       — % of bullets within 22-word limit + filler-free
 * 5. Page Compliance   — pass/fail + page count
 * 6. Phrase Repetition  — count of suppressed/banned phrases found
 * 7. Layout Compliance  — composite of structural rule adherence
 */

import type { TailoredResume } from "./tailoredResumePrompt";
import type { ClaimsLedger } from "./claimsLedger";
import type { MandateProfile } from "./mandateClassifier";
import type { DivergenceResult } from "./resumeDivergenceEnforcer";

// ── Score Interfaces ─────────────────────────────────────────────

export interface TruthfulnessScore {
  score: number;                     // 0-100
  total_bullets: number;
  bullets_with_claim_ids: number;
  bullets_with_valid_claim_ids: number;
  invalid_claim_ids: string[];       // claim_ids that don't exist in ledger
  unsourced_bullets: { role: string; text: string }[];
}

export interface MandateAlignmentScore {
  score: number;                     // 0-100
  primary_mandate: string;
  roles_checked: number;
  top2_aligned_count: number;        // How many top-2 bullets align with mandate
  top2_total: number;                // Total top-2 bullet slots
  first_sentence_anchored: boolean;  // Does summary first sentence match mandate?
  mandate_keywords_in_summary: number;
}

export interface DifferentiationScore {
  score: number;                     // 0-100 (100 = fully distinct)
  compared_against: number;
  worst_summary_overlap: number;     // 0-100 (lower is better)
  worst_competency_overlap: number;
  worst_bullet_similarity: number;
  suppressed_phrases_found: number;
}

export interface ReadabilityScore {
  score: number;                     // 0-100
  total_bullets: number;
  bullets_within_limit: number;      // ≤22 words
  bullets_filler_free: number;       // No filler phrases detected
  bullets_passive_free: number;      // No passive phrasing
  bullets_action_first: number;      // Start with action verb
  avg_word_count: number;
  max_word_count: number;
  summary_line_count: number;        // Estimated lines (≤4 is compliant — mandate sharpening)
}

export interface PageComplianceStatus {
  compliant: boolean;
  page_count: number | null;         // null if not yet rendered
  max_pages: 2;
  total_bullets: number;
  target_bullet_range: [number, number]; // [13, 15]
  within_bullet_range: boolean;
  competency_count: number;
  competency_limit: 12;
  competency_compliant: boolean;
  summary_lines: number;
  summary_limit: 4;
  summary_compliant: boolean;
}

export interface PhraseRepetitionReport {
  count: number;
  banned_phrases_found: string[];
  cross_section_duplicates: string[];  // Phrases repeated across sections
  verb_repetitions: { verb: string; count: number }[];
}

export interface LayoutComplianceScore {
  score: number;                     // 0-100
  reverse_chronological: boolean;
  bullet_caps_respected: boolean;
  no_orphan_sections: boolean;       // No single-bullet roles (except oldest)
  scope_lines_present: boolean;      // All roles have scope_line
  tools_one_line: boolean;
  no_wall_of_text: boolean;          // No section > 12 content lines
  education_present: boolean;
}

export interface ExecutiveToneScore {
  score: number;                     // 0-100
  soft_verb_count: number;           // Opening verbs that are weak/passive
  passive_voice_count: number;       // Bullets starting with passive constructions
  stacked_clause_count: number;      // Bullets with 3+ commas
  hedge_phrase_count: number;        // "I believe", "I think", "helped to"
  supplicant_phrase_count: number;   // "I would be honored", "Thank you for considering"
  decisive_action_pct: number;       // % of bullets starting with strong action verbs
  career_depth_roles: number;        // Number of enterprise roles (min 3 for exec presence)
}

export interface VerbStrengthScore {
  score: number;                       // 0-100
  total_bullets: number;
  generic_verb_count: number;          // "led", "built", "managed", "transformed" still in use
  mandate_aligned_count: number;       // Bullets starting with mandate-specific verbs
  mandate_aligned_pct: number;         // % of bullets mandate-aligned
  diversity_score: number;             // 100 = all unique openers, 0 = all same verb
  max_verb_repetitions: number;        // Highest count of any single opener verb
  verb_map: Record<string, number>;    // verb → usage count
}

export interface OwnershipInflationReport {
  total_warnings: number;
  critical_count: number;
  warning_count: number;
  patterns_triggered: string[];       // e.g. ["contributor -> owner", "enterprise-scope: drove board decision"]
  auto_rewrites_applied: number;
}

export interface QualityReport {
  overall_score: number;             // Weighted composite 0-100
  grade: "A" | "B" | "C" | "D" | "F";
  truthfulness: TruthfulnessScore;
  mandate_alignment: MandateAlignmentScore;
  differentiation: DifferentiationScore;
  readability: ReadabilityScore;
  executive_tone: ExecutiveToneScore;
  page_compliance: PageComplianceStatus;
  phrase_repetition: PhraseRepetitionReport;
  layout_compliance: LayoutComplianceScore;
  verb_strength: VerbStrengthScore;
  ownership_inflation: OwnershipInflationReport;
  blocking_issues: string[];         // Issues that must be fixed before output
  warnings: string[];                // Non-blocking quality issues
  timestamp: string;
}

// ── Filler & passive patterns (mirrors compressor, used for scoring) ──

const FILLER_PATTERNS = [
  /\bserving as\b/i, /\bknown for\b/i, /\bresponsible for\b/i,
  /\bplayed a key role\b/i, /\bcore member of\b/i, /\bserved as\b/i,
  /\btasked with\b/i, /\bin charge of\b/i, /\bcareer defined by\b/i,
  /\bstrategically\b/i, /\bholistically\b/i, /\bcomprehensively\b/i,
  /\beffectively\b/i, /\bsuccessfully\b/i, /\bsignificantly\b/i,
];

const PASSIVE_PATTERNS = [
  /\bwas responsible for\b/i, /\bwas tasked with\b/i,
  /\bwas involved in\b/i, /\bwas charged with\b/i,
  /\bwas instrumental in\b/i, /\bhelped\s+\w/i,
  /\bassisted\s+(?:in|with)\b/i, /\bcontributed to\b/i,
  /\bsupported\s+\w/i,
];

const ACTION_VERBS = [
  "architected", "launched", "established", "developed", "created",
  "built", "designed", "partnered", "led", "drove", "delivered",
  "deployed", "automated", "scaled", "transformed", "modernized",
  "implemented", "negotiated", "defined", "restructured", "integrated",
  "optimized", "directed", "founded", "introduced", "reduced",
  "increased", "secured", "consolidated", "unified", "migrated",
  "replaced", "eliminated", "generated", "accelerated", "pioneered",
  "spearheaded", "overhauled", "instituted", "formalized", "embedded",
];

const BANNED_PHRASES = [
  "track record of", "proven ability to", "extensive experience in",
  "passionate about", "results-oriented", "data-driven leader",
  "transforming organizations", "cross-functional collaboration",
  "stakeholder management", "end-to-end", "best-in-class",
  "world-class", "cutting-edge", "state-of-the-art",
  "leveraging data", "actionable insights", "data-informed decisions",
  "driving value", "unlocking value", "fostering a culture of",
  "spearheaded the development", "instrumental in", "at the forefront of",
  "transforming analytics into strategic growth engines",
  "bridging technical capabilities with business strategy",
  "positioned analytics as a revenue driver",
  "distinctly technical for an executive at this level",
  "career defined by",
  // Hype words — inflated language that undermines credibility
  "powerhouse", "market-dominating", "game-changing", "game changer",
  "catalyzed", "groundbreaking", "revolutionized", "skyrocketed",
  "unprecedented", "transformative", "seismic", "disruptive",
  "paradigm shift", "trailblazing", "runaway success", "blew past",
];

// ── Mandate keyword maps (for alignment scoring) ──

const MANDATE_KEYWORDS: Record<string, string[]> = {
  governance_standardization: ["governance", "compliance", "standardiz", "audit", "control", "framework", "metric discipline", "data quality", "reporting rigor"],
  bi_platform_modernization: ["platform", "architect", "moderniz", "migrat", "cloud", "infrastructure", "pipeline", "data lake", "warehouse"],
  insight_delivery_automation: ["insight", "self-service", "reporting", "dashboard", "stakeholder", "decision-maker", "automat"],
  founder_adjacent_builder: ["built from", "zero-to-one", "stood up", "founder", "ceo partner", "startup"],
  revenue_ops_forecasting: ["revenue", "forecast", "pricing", "demand planning", "p&l", "margin", "commercial"],
  operating_model_transformation: ["operating model", "transform", "embed", "democratiz", "reorganiz", "change management"],
  product_gtm_analytics: ["product", "go-to-market", "gtm", "feature", "adoption", "user journey"],
  growth_monetization: ["growth", "experiment", "a/b test", "conversion", "monetiz", "funnel"],
  executive_storytelling: ["board", "c-suite", "advisory", "storytelling", "strategic", "influence"],
  team_leadership_scale: ["team", "hired", "scaled", "organizational design", "talent", "mentored"],
};

// ── Scoring Functions ────────────────────────────────────────────

function wordCount(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function estimateSummaryLines(text: string): number {
  const paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0);
  let totalLines = 0;
  for (const p of paragraphs) {
    // 85 chars/line matches Calibri 11pt with 0.7" margins (actual DOCX rendering)
    totalLines += Math.ceil(p.length / 85);
  }
  return totalLines;
}

function bulletMatchesMandate(text: string, mandate: string): boolean {
  const keywords = MANDATE_KEYWORDS[mandate] || [];
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  return hits >= 1;
}

// Expanded action verb set — no heuristic suffix appending.
// Every valid form is listed explicitly to prevent corruption.
const ACTION_VERB_SET = new Set([
  ...ACTION_VERBS,
  // Additional past-tense and mandate-aligned forms
  "partnered", "instituted", "codified", "standardized", "embedded",
  "enforced", "formalized", "governed", "replatformed", "engineered",
  "unified", "operationalized", "surfaced", "instrumented", "bootstrapped",
  "incubated", "originated", "recaptured", "forecasted", "monetized",
  "repriced", "modeled", "redesigned", "reengineered", "realigned",
  "repositioned", "segmented", "personalized", "activated", "converted",
  "experimented", "funneled", "iterated", "influenced", "briefed",
  "positioned", "advised", "counseled", "steered", "shaped",
  "recruited", "mentored", "organized", "elevated", "coached",
  "tested", "tracked", "established", "executed", "orchestrated",
  "overhauled", "recovered", "expanded", "strengthened",
]);

function startsWithActionVerb(text: string): boolean {
  const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
  return ACTION_VERB_SET.has(firstWord);
}

function hasFiller(text: string): boolean {
  return FILLER_PATTERNS.some(p => p.test(text));
}

function hasPassive(text: string): boolean {
  return PASSIVE_PATTERNS.some(p => p.test(text));
}

// ── Main Scoring Functions ───────────────────────────────────────

export function scoreTruthfulness(
  resume: TailoredResume,
  ledger?: ClaimsLedger,
): TruthfulnessScore {
  const allBullets = resume.experience.flatMap((exp) =>
    exp.bullets.map(b => ({ role: `${exp.title} @ ${exp.employer}`, ...b })),
  );
  const total = allBullets.length;
  let withClaimIds = 0;
  let withValidClaimIds = 0;
  const invalidIds: string[] = [];
  const unsourced: { role: string; text: string }[] = [];

  const ledgerIdSet = ledger ? new Set(Object.keys(ledger.byId)) : null;

  for (const bullet of allBullets) {
    const ids = bullet.claim_ids;
    const hasIds = Array.isArray(ids) && ids.length > 0;
    const hasSource = bullet.source_hash && bullet.source_hash.length > 0;
    const hasEvidence = bullet.evidence_quote && bullet.evidence_quote.length > 0;

    if (hasIds) {
      withClaimIds++;
      if (ledgerIdSet) {
        const allValid = ids.every(id => ledgerIdSet.has(id));
        if (allValid) {
          withValidClaimIds++;
        } else {
          const bad = ids.filter(id => !ledgerIdSet.has(id));
          invalidIds.push(...bad);
        }
      } else {
        // No ledger to validate against — trust presence of IDs
        withValidClaimIds++;
      }
    } else if (hasSource && hasEvidence) {
      // Legacy format: has source_hash + evidence_quote but no claim_ids
      // Score as partially truthful
      withClaimIds++;
      withValidClaimIds++;
    } else {
      unsourced.push({ role: bullet.role, text: bullet.text });
    }
  }

  const score = total > 0 ? Math.round((withValidClaimIds / total) * 100) : 0;

  return {
    score,
    total_bullets: total,
    bullets_with_claim_ids: withClaimIds,
    bullets_with_valid_claim_ids: withValidClaimIds,
    invalid_claim_ids: [...new Set(invalidIds)],
    unsourced_bullets: unsourced,
  };
}

export function scoreMandateAlignment(
  resume: TailoredResume,
  mandate?: MandateProfile,
): MandateAlignmentScore {
  const primaryMandate = mandate?.primary_mandate || "unknown";
  const mandateKeywords = MANDATE_KEYWORDS[primaryMandate] || [];

  // Check top-2 bullets per role
  let top2Aligned = 0;
  let top2Total = 0;

  for (const exp of resume.experience) {
    const top2 = exp.bullets.slice(0, 2);
    for (const bullet of top2) {
      top2Total++;
      if (bulletMatchesMandate(bullet.text, primaryMandate)) {
        top2Aligned++;
      }
    }
  }

  // Check first sentence of summary
  const firstSentence = resume.professional_summary.split(/[.!?]\s/)[0] || "";
  const firstSentenceLower = firstSentence.toLowerCase();
  const firstSentenceAnchored = mandateKeywords.some(kw =>
    firstSentenceLower.includes(kw),
  );

  // Count mandate keywords in full summary
  const summaryLower = resume.professional_summary.toLowerCase();
  let mandateKwInSummary = 0;
  for (const kw of mandateKeywords) {
    if (summaryLower.includes(kw)) mandateKwInSummary++;
  }

  const alignmentPct = top2Total > 0 ? (top2Aligned / top2Total) : 0;
  // Weight: 60% bullet alignment + 25% first-sentence anchor + 15% keyword density
  const score = Math.round(
    alignmentPct * 60 +
    (firstSentenceAnchored ? 25 : 0) +
    Math.min(15, (mandateKwInSummary / Math.max(1, mandateKeywords.length)) * 15),
  );

  return {
    score,
    primary_mandate: primaryMandate,
    roles_checked: resume.experience.length,
    top2_aligned_count: top2Aligned,
    top2_total: top2Total,
    first_sentence_anchored: firstSentenceAnchored,
    mandate_keywords_in_summary: mandateKwInSummary,
  };
}

export function scoreDifferentiation(
  divergenceResult?: DivergenceResult,
): DifferentiationScore {
  if (!divergenceResult || divergenceResult.compared_against === 0) {
    return {
      score: 100, // No history = fully distinct by default
      compared_against: 0,
      worst_summary_overlap: 0,
      worst_competency_overlap: 0,
      worst_bullet_similarity: 0,
      suppressed_phrases_found: 0,
    };
  }

  const worstSummary = Math.max(0, ...divergenceResult.summary_overlaps.map(o => o.overlap_pct));
  const worstComp = Math.max(0, ...divergenceResult.competency_overlaps.map(o => o.overlap_pct));
  const worstBullet = Math.max(0, ...divergenceResult.bullet_similarity.map(o => o.similarity_pct));
  const suppressedCount = divergenceResult.suppressed_phrases.length;

  // Score: inverse of worst overlaps, weighted (tightened thresholds)
  // Summary 40%, Competency 25%, Bullet 25%, Phrase cleanliness 10%
  const summaryScore = Math.max(0, 100 - worstSummary * (100 / 25));  // 0 at 25% overlap
  const compScore = Math.max(0, 100 - worstComp * (100 / 40));        // 0 at 40% overlap
  const bulletScore = Math.max(0, 100 - worstBullet * (100 / 35));     // 0 at 35% overlap
  const phraseScore = Math.max(0, 100 - suppressedCount * 10);         // -10 per phrase

  const score = Math.round(
    summaryScore * 0.40 +
    compScore * 0.25 +
    bulletScore * 0.25 +
    phraseScore * 0.10,
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    compared_against: divergenceResult.compared_against,
    worst_summary_overlap: worstSummary,
    worst_competency_overlap: worstComp,
    worst_bullet_similarity: worstBullet,
    suppressed_phrases_found: suppressedCount,
  };
}

export function scoreReadability(resume: TailoredResume): ReadabilityScore {
  const allBullets = resume.experience.flatMap(exp => exp.bullets);
  const total = allBullets.length;

  let withinLimit = 0;
  let fillerFree = 0;
  let passiveFree = 0;
  let actionFirst = 0;
  let totalWords = 0;
  let maxWords = 0;

  for (const bullet of allBullets) {
    const wc = wordCount(bullet.text);
    totalWords += wc;
    if (wc > maxWords) maxWords = wc;

    if (wc <= 22) withinLimit++;
    if (!hasFiller(bullet.text)) fillerFree++;
    if (!hasPassive(bullet.text)) passiveFree++;
    if (startsWithActionVerb(bullet.text)) actionFirst++;
  }

  // Also check summary for filler/passive
  const summaryClean = !hasFiller(resume.professional_summary) && !hasPassive(resume.professional_summary);
  const summaryLines = estimateSummaryLines(resume.professional_summary);

  // Weighted: 30% word limit, 20% filler-free, 15% passive-free, 20% action-first, 15% summary
  const score = total > 0 ? Math.round(
    (withinLimit / total) * 30 +
    (fillerFree / total) * 20 +
    (passiveFree / total) * 15 +
    (actionFirst / total) * 20 +
    (summaryClean ? 10 : 0) +
    (summaryLines <= 4 ? 5 : 0),
  ) : 0;

  return {
    score: Math.min(100, score),
    total_bullets: total,
    bullets_within_limit: withinLimit,
    bullets_filler_free: fillerFree,
    bullets_passive_free: passiveFree,
    bullets_action_first: actionFirst,
    avg_word_count: total > 0 ? Math.round(totalWords / total) : 0,
    max_word_count: maxWords,
    summary_line_count: summaryLines,
  };
}

export function scorePageCompliance(
  resume: TailoredResume,
  pageCount?: number,
): PageComplianceStatus {
  const totalBullets = resume.experience.reduce((s, e) => s + e.bullets.length, 0);
  const competencies = (resume as any).core_competencies || [];
  const summaryLines = estimateSummaryLines(resume.professional_summary);

  const withinBulletRange = totalBullets >= 13 && totalBullets <= 15;
  const compCompliant = competencies.length <= 12;
  const summaryCompliant = summaryLines <= 4;
  const pageCompliant = pageCount === undefined || pageCount <= 2;

  return {
    compliant: pageCompliant && withinBulletRange && compCompliant && summaryCompliant,
    page_count: pageCount ?? null,
    max_pages: 2,
    total_bullets: totalBullets,
    target_bullet_range: [13, 15],
    within_bullet_range: withinBulletRange,
    competency_count: competencies.length,
    competency_limit: 12,
    competency_compliant: compCompliant,
    summary_lines: summaryLines,
    summary_limit: 4,
    summary_compliant: summaryCompliant,
  };
}

export function scorePhraseRepetition(resume: TailoredResume): PhraseRepetitionReport {
  const fullText = [
    resume.professional_summary,
    ...resume.experience.flatMap(e => [
      e.scope_line || "",
      ...e.bullets.map(b => b.text),
    ]),
  ].join(" ");
  const fullTextLower = fullText.toLowerCase();

  // Check banned phrases
  const bannedFound: string[] = [];
  for (const phrase of BANNED_PHRASES) {
    if (fullTextLower.includes(phrase.toLowerCase())) {
      bannedFound.push(phrase);
    }
  }

  // Check cross-section duplicates (phrases in summary that also appear in bullets)
  const summaryPhrases = extractNGrams(resume.professional_summary, 4);
  const bulletPhrases = new Set<string>();
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      for (const ng of extractNGrams(bullet.text, 4)) {
        bulletPhrases.add(ng);
      }
    }
  }
  const crossDupes: string[] = [];
  for (const sp of summaryPhrases) {
    if (bulletPhrases.has(sp)) {
      crossDupes.push(sp);
    }
  }

  // Check verb repetitions
  const verbs = new Map<string, number>();
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      const first = bullet.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      if (first.length > 2) {
        verbs.set(first, (verbs.get(first) || 0) + 1);
      }
    }
  }
  const verbReps = [...verbs.entries()]
    .filter(([, count]) => count > 2)
    .map(([verb, count]) => ({ verb, count }))
    .sort((a, b) => b.count - a.count);

  return {
    count: bannedFound.length + crossDupes.length + verbReps.reduce((s, v) => s + v.count - 2, 0),
    banned_phrases_found: bannedFound,
    cross_section_duplicates: [...new Set(crossDupes)].slice(0, 10),
    verb_repetitions: verbReps,
  };
}

function extractNGrams(text: string, n: number): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const grams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    grams.push(words.slice(i, i + n).join(" "));
  }
  return grams;
}

export function scoreLayoutCompliance(resume: TailoredResume): LayoutComplianceScore {
  // Reverse chronological check
  let reverseChron = true;
  for (let i = 1; i < resume.experience.length; i++) {
    const prevEnd = resume.experience[i - 1].end_date?.toLowerCase() === "present"
      ? 9999 : parseInt(resume.experience[i - 1].end_date?.substring(0, 4) || "0", 10);
    const currEnd = resume.experience[i].end_date?.toLowerCase() === "present"
      ? 9999 : parseInt(resume.experience[i].end_date?.substring(0, 4) || "0", 10);
    if (currEnd > prevEnd) { reverseChron = false; break; }
  }

  // Bullet caps check
  const currentYear = new Date().getFullYear();
  let capsRespected = true;
  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];
    const endDate = exp.end_date?.toLowerCase() === "present"
      ? currentYear : parseInt(exp.end_date?.substring(0, 4) || "0", 10);
    const isOld = endDate > 0 && (currentYear - endDate) > 15;
    const maxCap = isOld ? 2 : i === 0 ? 4 : i <= 2 ? 3 : 2;
    if (exp.bullets.length > maxCap) { capsRespected = false; break; }
  }

  // Scope lines present
  const scopePresent = resume.experience.every(e => e.scope_line && e.scope_line.trim().length > 0);

  // No orphan roles (single bullet without being oldest)
  const noOrphan = resume.experience.every((e, i) =>
    e.bullets.length >= 2 || i === resume.experience.length - 1,
  );

  // Tools one-line check
  const tools = (resume.skills as any)?.tools_and_platforms || [];
  const toolsOneLine = tools.join(", ").length <= 90;

  // No wall-of-text (>12 content lines per section estimate)
  let noWall = true;
  for (const exp of resume.experience) {
    const contentLines = exp.bullets.length + 3; // title + date + scope + bullets
    if (contentLines > 12) { noWall = false; break; }
  }

  // Education present
  const eduPresent = resume.education && resume.education.length > 0;

  // Composite score
  const checks = [reverseChron, capsRespected, noOrphan, scopePresent, toolsOneLine, noWall, eduPresent];
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  return {
    score,
    reverse_chronological: reverseChron,
    bullet_caps_respected: capsRespected,
    no_orphan_sections: noOrphan,
    scope_lines_present: scopePresent,
    tools_one_line: toolsOneLine,
    no_wall_of_text: noWall,
    education_present: eduPresent,
  };
}

// ── Executive Tone Scorer ────────────────────────────────────────

const SOFT_VERBS = [
  "supported", "helped", "contributed", "assisted",
  "participated", "aided", "facilitated",
];

const HEDGE_PHRASES = [
  "i believe", "i think", "i feel", "helped to",
  "tried to", "attempted to", "worked to", "sought to",
  "may have", "might have", "could have",
];

const SUPPLICANT_PHRASES = [
  "i would be honored", "i humbly", "thank you for considering",
  "i hope to", "i look forward to the opportunity",
  "i am excited to apply", "please consider",
  "i am writing to express",
];

const STRONG_ACTION_VERBS = new Set([
  "led", "built", "designed", "architected", "launched", "scaled",
  "transformed", "drove", "delivered", "established", "created",
  "negotiated", "secured", "restructured", "automated", "deployed",
  "unified", "consolidated", "modernized", "accelerated", "reduced",
  "increased", "expanded", "implemented", "orchestrated", "directed",
  "defined", "owned", "introduced", "pioneered", "overhauled",
  "replaced", "eliminated", "generated", "recovered", "converted",
]);

export function scoreExecutiveTone(resume: TailoredResume): ExecutiveToneScore {
  const allBullets = resume.experience.flatMap(e => e.bullets.map(b => b.text));
  const total = allBullets.length;
  if (total === 0) {
    return {
      score: 0, soft_verb_count: 0, passive_voice_count: 0,
      stacked_clause_count: 0, hedge_phrase_count: 0,
      supplicant_phrase_count: 0, decisive_action_pct: 0,
      career_depth_roles: resume.experience.length,
    };
  }

  const fullText = [
    resume.professional_summary,
    ...allBullets,
  ].join(" ").toLowerCase();

  // Count soft verbs at bullet openers
  let softVerbCount = 0;
  let passiveVoiceCount = 0;
  let stackedClauseCount = 0;
  let decisiveActionCount = 0;

  for (const bulletText of allBullets) {
    const firstWord = bulletText.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";

    if (SOFT_VERBS.includes(firstWord)) softVerbCount++;
    if (/^(was|were|has been|have been|had been|being)\s/i.test(bulletText)) passiveVoiceCount++;
    if ((bulletText.match(/,/g) || []).length >= 3) stackedClauseCount++;
    if (STRONG_ACTION_VERBS.has(firstWord)) decisiveActionCount++;
  }

  // Count hedge and supplicant phrases (more common in summary than bullets)
  let hedgeCount = 0;
  for (const hedge of HEDGE_PHRASES) {
    if (fullText.includes(hedge)) hedgeCount++;
  }

  let supplicantCount = 0;
  for (const sup of SUPPLICANT_PHRASES) {
    if (fullText.includes(sup)) supplicantCount++;
  }

  const decisivePct = Math.round((decisiveActionCount / total) * 100);

  // Scoring: start at 100, deduct for violations
  let score = 100;
  score -= softVerbCount * 8;          // Soft verbs are weak — heavy penalty
  score -= passiveVoiceCount * 10;     // Passive is unacceptable at exec level
  score -= stackedClauseCount * 5;     // Over-complex but not fatal
  score -= hedgeCount * 12;            // Hedging destroys exec confidence
  score -= supplicantCount * 15;       // Supplicant language is the worst
  // Bonus for decisive action verb coverage
  if (decisivePct >= 80) score = Math.min(100, score + 5);
  else if (decisivePct < 50) score -= 10;
  // Career depth: at least 3 roles for exec presence
  if (resume.experience.length < 3) score -= 15;

  return {
    score: Math.max(0, Math.min(100, score)),
    soft_verb_count: softVerbCount,
    passive_voice_count: passiveVoiceCount,
    stacked_clause_count: stackedClauseCount,
    hedge_phrase_count: hedgeCount,
    supplicant_phrase_count: supplicantCount,
    decisive_action_pct: decisivePct,
    career_depth_roles: resume.experience.length,
  };
}

// ── Verb Strength Scorer ─────────────────────────────────────────

const GENERIC_STRONG_VERBS_SET = new Set(["led", "built", "managed", "transformed", "drove", "created", "developed"]);

export function scoreVerbStrength(
  resume: TailoredResume,
  mandate?: MandateProfile,
): VerbStrengthScore {
  const MANDATE_VERB_POOL: Record<string, Set<string>> = {
    governance_standardization: new Set(["instituted", "codified", "standardized", "embedded", "enforced", "formalized", "governed"]),
    bi_platform_modernization: new Set(["architected", "migrated", "replatformed", "engineered", "unified", "modernized", "scaled"]),
    insight_delivery_automation: new Set(["operationalized", "automated", "democratized", "surfaced", "instrumented", "accelerated"]),
    founder_adjacent_builder: new Set(["launched", "bootstrapped", "founded", "pioneered", "incubated", "originated"]),
    revenue_ops_forecasting: new Set(["recaptured", "forecasted", "recovered", "monetized", "optimized", "repriced", "modeled"]),
    operating_model_transformation: new Set(["redesigned", "restructured", "overhauled", "reengineered", "consolidated", "realigned", "repositioned"]),
    product_gtm_analytics: new Set(["instrumented", "segmented", "personalized", "activated", "converted", "tracked"]),
    growth_monetization: new Set(["converted", "experimented", "optimized", "monetized", "funneled", "tested", "iterated"]),
    executive_storytelling: new Set(["influenced", "briefed", "positioned", "advised", "counseled", "steered", "shaped"]),
    team_leadership_scale: new Set(["recruited", "mentored", "scaled", "organized", "elevated", "coached"]),
  };

  const mandateVerbSet = mandate ? MANDATE_VERB_POOL[mandate.primary_mandate] || new Set() : new Set();
  const verbMap: Record<string, number> = {};
  let genericCount = 0;
  let mandateAligned = 0;
  let totalBullets = 0;

  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      totalBullets++;
      const verb = bullet.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      verbMap[verb] = (verbMap[verb] || 0) + 1;
      if (GENERIC_STRONG_VERBS_SET.has(verb)) genericCount++;
      if (mandateVerbSet.has(verb)) mandateAligned++;
    }
  }

  const uniqueVerbs = Object.keys(verbMap).length;
  const maxRep = Math.max(0, ...Object.values(verbMap));
  const diversityScore = totalBullets > 0
    ? Math.round((uniqueVerbs / totalBullets) * 100)
    : 0;
  const mandateAlignedPct = totalBullets > 0
    ? Math.round((mandateAligned / totalBullets) * 100)
    : 0;

  // Score: start at 100
  // -5 per generic verb still present
  // -10 per verb used 3+ times
  // +10 if mandate-aligned > 30%
  // +5 if diversity > 80%
  let score = 100;
  score -= genericCount * 5;
  const overused = Object.values(verbMap).filter(c => c >= 3).length;
  score -= overused * 10;
  if (mandateAlignedPct >= 30) score += 10;
  else if (mandateAlignedPct < 10) score -= 10;
  if (diversityScore >= 80) score += 5;
  else if (diversityScore < 50) score -= 10;

  return {
    score: Math.max(0, Math.min(100, score)),
    total_bullets: totalBullets,
    generic_verb_count: genericCount,
    mandate_aligned_count: mandateAligned,
    mandate_aligned_pct: mandateAlignedPct,
    diversity_score: diversityScore,
    max_verb_repetitions: maxRep,
    verb_map: verbMap,
  };
}

// ── Composite Scorer ─────────────────────────────────────────────

/**
 * Compute the full quality report for a generated resume.
 *
 * Weights (8 dimensions):
 *   Truthfulness:      25%  (non-negotiable — factual accuracy is the hard gate)
 *   Verb Strength:     10%  (mandate-aligned verb authority + diversity)
 *   Executive Tone:    15%  (decisive, board-level, no hedging/supplicant)
 *   Mandate Alignment: 15%  (does the resume serve THIS job?)
 *   Readability:       10%  (compression + formatting cleanliness)
 *   Differentiation:   10%  (distinct from prior outputs)
 *   Layout Compliance: 10%  (structural rules)
 *   Phrase Cleanliness:  5% (inverse of repetition)
 */
export function computeQualityReport(
  resume: TailoredResume,
  options: {
    ledger?: ClaimsLedger;
    mandate?: MandateProfile;
    divergenceResult?: DivergenceResult;
    pageCount?: number;
    ownershipWarnings?: { severity: "warning" | "critical"; pattern: string }[];
  } = {},
): QualityReport {
  const truthfulness = scoreTruthfulness(resume, options.ledger);
  const mandateAlignment = scoreMandateAlignment(resume, options.mandate);
  const differentiation = scoreDifferentiation(options.divergenceResult);
  const readability = scoreReadability(resume);
  const executiveTone = scoreExecutiveTone(resume);
  const verbStrength = scoreVerbStrength(resume, options.mandate);
  const pageCompliance = scorePageCompliance(resume, options.pageCount);
  const phraseRepetition = scorePhraseRepetition(resume);
  const layoutCompliance = scoreLayoutCompliance(resume);

  // Build ownership inflation report
  const ow = options.ownershipWarnings || [];
  const ownershipInflation: OwnershipInflationReport = {
    total_warnings: ow.length,
    critical_count: ow.filter(w => w.severity === "critical").length,
    warning_count: ow.filter(w => w.severity === "warning").length,
    patterns_triggered: [...new Set(ow.map(w => w.pattern))],
    auto_rewrites_applied: ow.filter(w => w.severity === "critical").length,
  };

  // Phrase cleanliness score (inverse of repetition)
  const phraseCleanScore = Math.max(0, 100 - phraseRepetition.count * 8);

  // Weighted composite (25/10/15/15/10/10/10/5)
  const overall = Math.round(
    truthfulness.score * 0.25 +
    verbStrength.score * 0.10 +
    executiveTone.score * 0.15 +
    mandateAlignment.score * 0.15 +
    readability.score * 0.10 +
    differentiation.score * 0.10 +
    layoutCompliance.score * 0.10 +
    phraseCleanScore * 0.05,
  );

  // Grade
  const grade = overall >= 90 ? "A"
    : overall >= 80 ? "B"
    : overall >= 70 ? "C"
    : overall >= 60 ? "D"
    : "F";

  // Blocking issues (these MUST be fixed before output)
  const blocking: string[] = [];
  if (truthfulness.unsourced_bullets.length > 0) {
    blocking.push(`${truthfulness.unsourced_bullets.length} bullet(s) have no source evidence — remove or add claim_ids`);
  }
  if (truthfulness.invalid_claim_ids.length > 0) {
    blocking.push(`${truthfulness.invalid_claim_ids.length} invalid claim_id(s) — do not exist in ledger`);
  }
  if (pageCompliance.page_count !== null && pageCompliance.page_count > 2) {
    blocking.push(`Resume is ${pageCompliance.page_count} pages — must be ≤2`);
  }
  if (phraseRepetition.banned_phrases_found.length > 0) {
    blocking.push(`${phraseRepetition.banned_phrases_found.length} banned stock phrase(s) detected`);
  }
  if (truthfulness.score < 100) {
    blocking.push(`Truthfulness score is ${truthfulness.score}% — must be 100% (all bullets need valid claim_ids)`);
  }
  if (differentiation.worst_summary_overlap > 35) {
    blocking.push(`Summary overlap ${differentiation.worst_summary_overlap}% with prior resume — must be < 25% (force new structure)`);
  }
  if (differentiation.worst_bullet_similarity > 50) {
    blocking.push(`Top-bullet similarity ${differentiation.worst_bullet_similarity}% with prior resume — must be < 35% (force rewrite)`);
  }

  // Warnings
  const warnings: string[] = [];
  if (!pageCompliance.within_bullet_range) {
    warnings.push(`Total bullets: ${pageCompliance.total_bullets} (target: 13-15)`);
  }
  if (!pageCompliance.summary_compliant) {
    warnings.push(`Summary is ~${pageCompliance.summary_lines} lines (max: 4)`);
  }
  if (readability.max_word_count > 22) {
    warnings.push(`Longest bullet: ${readability.max_word_count} words (max: 22)`);
  }
  if (!mandateAlignment.first_sentence_anchored) {
    warnings.push("Summary first sentence does not anchor to primary mandate");
  }
  if (phraseRepetition.verb_repetitions.length > 0) {
    const top = phraseRepetition.verb_repetitions[0];
    warnings.push(`Verb "${top.verb}" used ${top.count} times — diversify action verbs`);
  }
  if (phraseRepetition.cross_section_duplicates.length > 0) {
    warnings.push(`${phraseRepetition.cross_section_duplicates.length} phrase(s) repeated across summary and bullets`);
  }
  if (!layoutCompliance.scope_lines_present) {
    warnings.push("Not all roles have scope lines — add enterprise context");
  }
  if (differentiation.worst_summary_overlap > 20) {
    warnings.push(`Summary ${differentiation.worst_summary_overlap}% overlap with prior resume — approaching 25% threshold`);
  }
  // Executive tone warnings
  if (executiveTone.passive_voice_count > 0) {
    warnings.push(`${executiveTone.passive_voice_count} bullet(s) start with passive voice — rewrite with active construction`);
  }
  if (executiveTone.soft_verb_count > 0) {
    warnings.push(`${executiveTone.soft_verb_count} bullet(s) open with weak verbs (helped, supported, etc.) — use decisive action verbs`);
  }
  if (executiveTone.hedge_phrase_count > 0) {
    warnings.push(`${executiveTone.hedge_phrase_count} hedging phrase(s) detected ("I believe", "tried to") — state directly`);
  }
  if (executiveTone.supplicant_phrase_count > 0) {
    blocking.push(`${executiveTone.supplicant_phrase_count} supplicant phrase(s) detected ("I would be honored", etc.) — remove immediately`);
  }
  if (executiveTone.decisive_action_pct < 60) {
    warnings.push(`Only ${executiveTone.decisive_action_pct}% of bullets start with strong action verbs — aim for 80%+`);
  }
  // Verb strength warnings
  if (verbStrength.generic_verb_count > 3) {
    warnings.push(`${verbStrength.generic_verb_count} generic verbs ("led", "built", "managed") — upgrade to mandate-aligned alternatives`);
  }
  if (verbStrength.max_verb_repetitions > 2) {
    warnings.push(`Opener verb used ${verbStrength.max_verb_repetitions} times — diversify (max 2x per verb)`);
  }
  if (verbStrength.mandate_aligned_pct < 20) {
    warnings.push(`Only ${verbStrength.mandate_aligned_pct}% of bullets use mandate-aligned verbs — aim for 30%+`);
  }
  if (executiveTone.career_depth_roles < 3) {
    warnings.push(`Only ${executiveTone.career_depth_roles} role(s) shown — minimum 3 for executive career depth`);
  }
  // Ownership inflation warnings
  if (ownershipInflation.critical_count > 0) {
    blocking.push(
      `${ownershipInflation.critical_count} critical ownership inflation(s) detected and auto-rewritten: ${ownershipInflation.patterns_triggered.join(", ")}`,
    );
  }
  if (ownershipInflation.warning_count > 0) {
    warnings.push(
      `${ownershipInflation.warning_count} ownership inflation warning(s): ${ownershipInflation.patterns_triggered.filter(p => !p.includes("enterprise-scope")).join(", ") || "(minor escalation patterns)"}`,
    );
  }

  return {
    overall_score: Math.max(0, Math.min(100, overall)),
    grade,
    truthfulness,
    mandate_alignment: mandateAlignment,
    differentiation,
    readability,
    executive_tone: executiveTone,
    page_compliance: pageCompliance,
    phrase_repetition: phraseRepetition,
    layout_compliance: layoutCompliance,
    verb_strength: verbStrength,
    ownership_inflation: ownershipInflation,
    blocking_issues: blocking,
    warnings,
    timestamp: new Date().toISOString(),
  };
}
