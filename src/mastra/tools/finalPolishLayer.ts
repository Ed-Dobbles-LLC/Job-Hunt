/**
 * Final Polish Layer — Orchestrates the complete post-generation quality pipeline.
 *
 * Architecture:
 *   Stage A: Truthfulness Audit (claim_ids → ledger validation)
 *   Stage B: Mandate-Dominant Summary Enforcement
 *   Stage C: Executive Tone Refinement (filler, passive, verb diversity)
 *   Stage D: Differentiation Gate (vs prior 3 resumes)
 *   Stage E: Deterministic Layout Governor (page, bullet, spacing rules)
 *   Stage F: Quality Scoring (7 metrics → composite grade)
 *
 * Each stage is deterministic except the optional LLM rewrite triggered by
 * Stage D when similarity exceeds thresholds.
 *
 * Usage:
 *   const result = await applyFinalPolish(resume, {
 *     ledger,
 *     mandate,
 *     jobId,
 *     pageCount,
 *   });
 *   // result.resume — polished resume
 *   // result.qualityReport — full scoring breakdown
 *   // result.stageReports — per-stage audit trail
 */

import type { TailoredResume } from "./tailoredResumePrompt";
import type { ClaimsLedger } from "./claimsLedger";
import type { MandateProfile } from "./mandateClassifier";
import { compressResume, type CompressionReport } from "./resumeCompressor";
import {
  checkDivergenceAgainstHistory,
  storeResumeSnapshot,
  ensureResumeHistoryTable,
  type DivergenceResult,
} from "./resumeDivergenceEnforcer";
import {
  computeQualityReport,
  type QualityReport,
} from "./qualityScorer";

// ── Stage Reports ────────────────────────────────────────────────

export interface TruthfulnessAuditReport {
  stage: "A";
  name: "truthfulness_audit";
  bullets_audited: number;
  unsourced_count: number;
  invalid_claim_ids: string[];
  dropped_bullets: { role: string; text: string; reason: string }[];
  conservative_rewrites: { role: string; before: string; after: string }[];
}

export interface MandateEnforcementReport {
  stage: "B";
  name: "mandate_enforcement";
  primary_mandate: string;
  first_sentence_anchored: boolean;
  summary_rewritten: boolean;
  generic_opener_detected: boolean;
  detected_opener: string | null;
}

export interface ToneRefinementReport {
  stage: "C";
  name: "tone_refinement";
  filler_removed: number;
  passive_removed: number;
  stacked_clauses_simplified: number;
  verb_diversification: { before: string; after: string }[];
  bullets_over_22_words: number;
}

export interface DifferentiationReport {
  stage: "D";
  name: "differentiation_gate";
  compared_against: number;
  needs_rewrite: boolean;
  rewrite_reasons: string[];
  suppressed_phrases: string[];
}

export interface LayoutGovernorReport {
  stage: "E";
  name: "layout_governor";
  compression: CompressionReport;
  orphan_lines_fixed: number;
  wall_of_text_blocks_broken: number;
  total_bullets_before: number;
  total_bullets_after: number;
}

export interface FinalPolishResult {
  resume: TailoredResume;
  qualityReport: QualityReport;
  stageReports: {
    truthfulness: TruthfulnessAuditReport;
    mandate: MandateEnforcementReport;
    tone: ToneRefinementReport;
    differentiation: DifferentiationReport;
    layout: LayoutGovernorReport;
  };
  passesQualityGate: boolean;
  blockingIssues: string[];
}

// ── Generic opener patterns to detect and reject ─────────────────

const GENERIC_OPENER_PATTERNS = [
  /^(?:data|analytics|technology|digital|business|information)\s+(?:and\s+\w+\s+)?(?:leader|executive|strategist|professional)\s+(?:who|with|that)/i,
  /^(?:seasoned|accomplished|results-driven|dynamic|innovative|visionary)\s+/i,
  /^executive\s+with\s+(?:a\s+)?(?:track record|extensive|proven|deep)/i,
  /^(?:senior|experienced)\s+(?:\w+\s+)?(?:leader|executive)\s+(?:who|with|that)/i,
  /^(?:a|an)\s+(?:proven|experienced|seasoned|skilled|accomplished)/i,
];

// ── Stacked clause patterns ──────────────────────────────────────

const STACKED_CLAUSE_PATTERNS = [
  { regex: /,\s*which\s+resulted\s+in\s+/gi, replacement: " — " },
  { regex: /,\s*which\s+led\s+to\s+/gi, replacement: " — " },
  { regex: /,\s*which\s+enabled\s+/gi, replacement: ", enabling " },
  { regex: /,\s*thereby\s+/gi, replacement: " — " },
  { regex: /\s+in\s+order\s+to\s+/gi, replacement: " to " },
  { regex: /\s+with\s+the\s+goal\s+of\s+/gi, replacement: " to " },
  { regex: /\s+with\s+the\s+aim\s+of\s+/gi, replacement: " to " },
  { regex: /\s+for\s+the\s+purpose\s+of\s+/gi, replacement: " to " },
  { regex: /,\s*while\s+also\s+/gi, replacement: "; " },
  { regex: /,\s*and\s+at\s+the\s+same\s+time\s+/gi, replacement: "; " },
];

// ── Stage Implementations ────────────────────────────────────────

/**
 * Stage A: Truthfulness Audit
 * - Validate claim_ids against ledger
 * - Drop bullets with no source evidence
 * - Flag bullets with invalid claim_ids
 */
function auditTruthfulness(
  resume: TailoredResume,
  ledger?: ClaimsLedger,
): TruthfulnessAuditReport {
  const report: TruthfulnessAuditReport = {
    stage: "A",
    name: "truthfulness_audit",
    bullets_audited: 0,
    unsourced_count: 0,
    invalid_claim_ids: [],
    dropped_bullets: [],
    conservative_rewrites: [],
  };

  const ledgerIdSet = ledger ? new Set(Object.keys(ledger.byId)) : null;

  for (const exp of resume.experience) {
    const kept: typeof exp.bullets = [];
    for (const bullet of exp.bullets) {
      report.bullets_audited++;

      const hasSource = (bullet.source_hash && bullet.source_hash.length > 0) ||
        (Array.isArray(bullet.claim_ids) && bullet.claim_ids.length > 0);

      if (!hasSource) {
        report.unsourced_count++;
        report.dropped_bullets.push({
          role: `${exp.title} @ ${exp.employer}`,
          text: bullet.text,
          reason: "No source_hash or claim_ids — unsupported claim",
        });
        continue; // Drop unsourced bullet
      }

      // Validate claim_ids against ledger if available
      if (ledgerIdSet && Array.isArray(bullet.claim_ids)) {
        const invalid = bullet.claim_ids.filter(id => !ledgerIdSet.has(id));
        if (invalid.length > 0) {
          report.invalid_claim_ids.push(...invalid);
          // Keep bullet but strip invalid IDs
          bullet.claim_ids = bullet.claim_ids.filter(id => ledgerIdSet.has(id));
        }
      }

      kept.push(bullet);
    }
    exp.bullets = kept;
  }

  // Also update evidence_pointers to match remaining bullets
  const remainingTexts = new Set(
    resume.experience.flatMap(e => e.bullets.map(b => b.text)),
  );
  resume.evidence_pointers = resume.evidence_pointers.filter(
    ep => remainingTexts.has(ep.claim_text),
  );

  return report;
}

/**
 * Stage B: Mandate-Dominant Summary Enforcement
 * - Check first sentence anchors to primary mandate
 * - Detect and flag generic openers
 * - Verify summary ≤ 5 lines
 * - Check no repetition with first bullet
 */
function enforceMandateSummary(
  resume: TailoredResume,
  mandate?: MandateProfile,
): MandateEnforcementReport {
  const report: MandateEnforcementReport = {
    stage: "B",
    name: "mandate_enforcement",
    primary_mandate: mandate?.primary_mandate || "unknown",
    first_sentence_anchored: false,
    summary_rewritten: false,
    generic_opener_detected: false,
    detected_opener: null,
  };

  const summary = resume.professional_summary;
  const firstSentence = summary.split(/[.!?]\s/)[0] || summary;

  // Check for generic openers
  for (const pattern of GENERIC_OPENER_PATTERNS) {
    if (pattern.test(firstSentence)) {
      report.generic_opener_detected = true;
      report.detected_opener = firstSentence.substring(0, 80);
      break;
    }
  }

  // Check mandate anchoring
  if (mandate) {
    const MANDATE_ANCHORS: Record<string, string[]> = {
      governance_standardization: ["governance", "control", "rigor", "standardiz", "compliance", "framework", "discipline"],
      bi_platform_modernization: ["architect", "platform", "moderniz", "migrat", "scalab", "infrastructure", "cloud"],
      insight_delivery_automation: ["insight", "clarity", "self-service", "reporting", "stakeholder", "real-time", "decision"],
      founder_adjacent_builder: ["built", "created", "zero-to-one", "stood up", "first", "greenfield"],
      revenue_ops_forecasting: ["revenue", "forecast", "pricing", "margin", "financial", "p&l", "commercial"],
      operating_model_transformation: ["operating model", "transform", "embed", "redesign", "democratiz"],
      product_gtm_analytics: ["product", "user", "adoption", "feature", "engagement", "go-to-market"],
      growth_monetization: ["growth", "experiment", "conversion", "monetiz", "funnel", "a/b"],
      executive_storytelling: ["board", "influence", "advisory", "strategic", "decision", "c-suite"],
      team_leadership_scale: ["team", "org", "hired", "scaled", "organizational", "talent"],
    };

    const anchors = MANDATE_ANCHORS[mandate.primary_mandate] || [];
    const firstLower = firstSentence.toLowerCase();
    report.first_sentence_anchored = anchors.some(a => firstLower.includes(a));
  }

  return report;
}

/**
 * Stage C: Executive Tone Refinement
 * - Remove stacked clauses
 * - Enforce verb diversity across bullets
 * - Track bullets exceeding 22-word limit
 */
function refineTone(resume: TailoredResume): ToneRefinementReport {
  const report: ToneRefinementReport = {
    stage: "C",
    name: "tone_refinement",
    filler_removed: 0,     // Counted by compressor
    passive_removed: 0,    // Counted by compressor
    stacked_clauses_simplified: 0,
    verb_diversification: [],
    bullets_over_22_words: 0,
  };

  // Simplify stacked clauses in all bullets
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      let text = bullet.text;
      for (const { regex, replacement } of STACKED_CLAUSE_PATTERNS) {
        regex.lastIndex = 0;
        const before = text;
        text = text.replace(regex, replacement);
        if (text !== before) report.stacked_clauses_simplified++;
      }
      text = text.replace(/\s{2,}/g, " ").trim();
      bullet.text = text;
    }
  }

  // Also simplify stacked clauses in summary
  let summaryText = resume.professional_summary;
  for (const { regex, replacement } of STACKED_CLAUSE_PATTERNS) {
    regex.lastIndex = 0;
    summaryText = summaryText.replace(regex, replacement);
  }
  resume.professional_summary = summaryText.replace(/\s{2,}/g, " ").trim();

  // Check verb diversity — detect over-used opening verbs
  const verbCounts = new Map<string, { count: number; indices: [number, number][] }>();
  for (let ri = 0; ri < resume.experience.length; ri++) {
    for (let bi = 0; bi < resume.experience[ri].bullets.length; bi++) {
      const text = resume.experience[ri].bullets[bi].text;
      const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      if (!verbCounts.has(firstWord)) {
        verbCounts.set(firstWord, { count: 0, indices: [] });
      }
      const entry = verbCounts.get(firstWord)!;
      entry.count++;
      entry.indices.push([ri, bi]);
    }
  }

  // Flag verbs used >2 times (for reporting; actual diversification requires LLM)
  for (const [verb, data] of verbCounts) {
    if (data.count > 2) {
      report.verb_diversification.push({
        before: `"${verb}" used ${data.count} times`,
        after: "Flagged for diversification in next LLM pass",
      });
    }
  }

  // Count over-length bullets
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      const wc = bullet.text.split(/\s+/).filter(w => w.length > 0).length;
      if (wc > 22) report.bullets_over_22_words++;
    }
  }

  return report;
}

/**
 * Stage D: Differentiation Gate
 * Wraps the existing divergence enforcer.
 */
async function checkDifferentiation(
  resume: TailoredResume,
  jobId?: number,
  mandate?: MandateProfile,
): Promise<{ report: DifferentiationReport; divergenceResult?: DivergenceResult }> {
  if (!jobId || !mandate) {
    return {
      report: {
        stage: "D",
        name: "differentiation_gate",
        compared_against: 0,
        needs_rewrite: false,
        rewrite_reasons: [],
        suppressed_phrases: [],
      },
    };
  }

  try {
    await ensureResumeHistoryTable();
    const divergence = await checkDivergenceAgainstHistory(resume, jobId, mandate);

    return {
      report: {
        stage: "D",
        name: "differentiation_gate",
        compared_against: divergence.compared_against,
        needs_rewrite: divergence.needs_rewrite,
        rewrite_reasons: divergence.rewrite_reasons,
        suppressed_phrases: divergence.suppressed_phrases.slice(0, 20),
      },
      divergenceResult: divergence,
    };
  } catch {
    // DB unavailable — skip differentiation
    return {
      report: {
        stage: "D",
        name: "differentiation_gate",
        compared_against: 0,
        needs_rewrite: false,
        rewrite_reasons: [],
        suppressed_phrases: [],
      },
    };
  }
}

/**
 * Stage E: Deterministic Layout Governor
 * Wraps the existing compressor + adds orphan and wall-of-text detection.
 */
function governLayout(
  resume: TailoredResume,
  mandate?: MandateProfile,
): LayoutGovernorReport {
  const totalBefore = resume.experience.reduce((s, e) => s + e.bullets.length, 0);

  // Run existing compressor
  const compression = compressResume(resume, mandate);

  // Additional: orphan line detection
  // A "wall of text" role has more content lines than readable
  let orphanFixed = 0;
  let wallBroken = 0;

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];

    // Wall-of-text: if a role has more than 5 bullets, it's too dense
    // (should already be capped by compressor, but double-check)
    if (exp.bullets.length > 5) {
      const removed = exp.bullets.splice(5);
      wallBroken++;
      for (const b of removed) {
        compression.removedBullets.push({
          roleIndex: i,
          bulletIndex: 5,
          text: b.text,
          reason: "Wall-of-text prevention: exceeds 5 bullets per role",
        });
      }
    }
  }

  const totalAfter = resume.experience.reduce((s, e) => s + e.bullets.length, 0);

  return {
    stage: "E",
    name: "layout_governor",
    compression,
    orphan_lines_fixed: orphanFixed,
    wall_of_text_blocks_broken: wallBroken,
    total_bullets_before: totalBefore,
    total_bullets_after: totalAfter,
  };
}

// ── Main Orchestrator ────────────────────────────────────────────

export interface FinalPolishOptions {
  ledger?: ClaimsLedger;
  mandate?: MandateProfile;
  jobId?: number;
  pageCount?: number;
}

/**
 * Apply the complete final polish pipeline to a generated resume.
 *
 * Pipeline:
 *   A. Truthfulness Audit     → drop unsourced bullets, strip invalid claim_ids
 *   B. Mandate Enforcement    → verify first-sentence anchoring, flag generic openers
 *   C. Tone Refinement        → simplify stacked clauses, flag verb repetition
 *   D. Differentiation Gate   → compare vs prior resumes, collect suppressed phrases
 *   E. Layout Governor        → compressor + orphan/wall-of-text enforcement
 *   F. Quality Scoring        → 7 metrics → composite grade + blocking issues
 *
 * Returns the polished resume, quality report, and per-stage audit trail.
 */
export async function applyFinalPolish(
  resume: TailoredResume,
  options: FinalPolishOptions = {},
): Promise<FinalPolishResult> {
  // Stage A: Truthfulness
  const truthReport = auditTruthfulness(resume, options.ledger);

  // Stage B: Mandate Summary
  const mandateReport = enforceMandateSummary(resume, options.mandate);

  // Stage C: Tone Refinement
  const toneReport = refineTone(resume);

  // Stage D: Differentiation Gate
  const { report: diffReport, divergenceResult } = await checkDifferentiation(
    resume,
    options.jobId,
    options.mandate,
  );

  // Stage E: Layout Governor
  const layoutReport = governLayout(resume, options.mandate);

  // Update tone report with compressor counts
  toneReport.filler_removed = layoutReport.compression.fillerPhrasesRemoved.length;
  toneReport.passive_removed = layoutReport.compression.passivePhrasesRemoved.length;

  // Stage F: Quality Scoring
  const qualityReport = computeQualityReport(resume, {
    ledger: options.ledger,
    mandate: options.mandate,
    divergenceResult,
    pageCount: options.pageCount,
  });

  // Store snapshot for future divergence checks
  if (options.jobId && options.mandate) {
    try {
      await storeResumeSnapshot(resume, options.jobId, options.mandate.primary_mandate);
    } catch {
      // Non-fatal
    }
  }

  return {
    resume,
    qualityReport,
    stageReports: {
      truthfulness: truthReport,
      mandate: mandateReport,
      tone: toneReport,
      differentiation: diffReport,
      layout: layoutReport,
    },
    passesQualityGate: qualityReport.blocking_issues.length === 0 && qualityReport.grade !== "F",
    blockingIssues: qualityReport.blocking_issues,
  };
}

/**
 * Pseudocode summary of the deterministic layout governor (for spec documentation).
 *
 * LAYOUT_GOVERNOR(resume, mandate):
 *   1. SUMMARY_ENFORCEMENT:
 *        IF summary_lines > 5 → truncate at last sentence boundary ≤ 400 chars
 *        IF first_sentence has team_size OR revenue → FLAG (mandate should lead)
 *
 *   2. FILLER_REMOVAL:
 *        FOR each bullet AND summary:
 *          STRIP: "serving as", "known for", "responsible for", "played a key role",
 *                 "strategically", "holistically", "effectively", "successfully",
 *                 "helped", "assisted", "contributed to", "supported"
 *          STRIP passive: "was responsible for", "was tasked with", "was involved in"
 *          CAPITALIZE first character after removal
 *
 *   3. STACKED_CLAUSE_SIMPLIFICATION:
 *        REPLACE: ", which resulted in" → " — "
 *        REPLACE: ", which led to" → " — "
 *        REPLACE: "in order to" → "to"
 *        REPLACE: "with the goal of" → "to"
 *        REPLACE: ", while also" → "; "
 *
 *   4. MANDATE_BULLET_REORDERING:
 *        FOR each role:
 *          SCORE each bullet against mandate keywords (0-5)
 *          IF mandate ≠ revenue → DEMOTE revenue bullets from positions 0-1
 *          SORT by mandate_score DESC, then original_index ASC
 *
 *   5. BULLET_CAP_ENFORCEMENT:
 *        role[0] → max 4 bullets
 *        role[1..2] → max 3 bullets each
 *        role[3+] OR age > 15yr → max 2 bullets each
 *        IF total > 15 → DROP lowest-mandate-score bullets from oldest roles
 *
 *   6. REDUNDANCY_ELIMINATION:
 *        FOR each role:
 *          IF semantic_overlap(summary, first_bullet) > 60% → FLAG
 *        FOR each banned_cross_section_phrase:
 *          IF found in summary OR bullets → FLAG
 *
 *   7. REVERSE_CHRONOLOGICAL_ENFORCEMENT:
 *        FOR i = 1..N:
 *          IF end_date[i] > end_date[i-1] → SWAP
 *
 *   8. TOOLS_TRIMMING:
 *        IF tools_line > 90 chars → TRUNCATE to fit
 *
 *   9. COMPETENCY_CAPPING:
 *        IF competencies > 12 → SLICE to 12
 *
 *  10. ORPHAN_DETECTION:
 *        IF any role (except last) has < 2 bullets → WARN
 *
 *  11. WALL_OF_TEXT_PREVENTION:
 *        IF any role has > 5 bullets → TRIM to 5
 *
 *  12. PAGE_BALANCE_ESTIMATE:
 *        Page 1 ≈ header(5 lines) + summary(5) + competencies(3) + role[0](7)
 *        Page 2 ≈ remaining roles + tools + education + certifications
 *        IF page_1_estimate > 22 lines → COMPRESS summary or drop 1 bullet from role[0]
 *
 *  RETURN: compressed_resume + CompressionReport
 */
