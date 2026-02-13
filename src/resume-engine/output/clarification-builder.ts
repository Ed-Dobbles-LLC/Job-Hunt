/**
 * Clarification Question Builder
 *
 * Converts gap analysis results (from the resume's gap_notes and the
 * mandate classifier's mandate_gaps) into structured clarification
 * questions that can be presented to the candidate.
 *
 * Each gap becomes an actionable "Do you have...?" question with:
 * - The original JD requirement
 * - The closest ledger match (for context)
 * - A severity classification (must_have vs nice_to_have)
 */

import type { GapNote } from "../../mastra/tools/tailoredResumePrompt";
import type { ClarificationQuestion, MandateGap } from "../types";

export type { ClarificationQuestion } from "../types";

// ── Gap Severity Heuristics ──────────────────────────────────────

/**
 * Signals in requirement text that indicate a must-have requirement.
 * These are phrases commonly used in JDs to denote non-negotiable
 * qualifications.
 */
const MUST_HAVE_SIGNALS: RegExp[] = [
  /\brequired\b/i,
  /\bmust\s+have\b/i,
  /\bessential\b/i,
  /\bmandatory\b/i,
  /\bminimum\b/i,
  /\bnon[- ]?negotiable\b/i,
  /\bcritical\b/i,
  /\bkey\s+requirement\b/i,
  /\b\d+\+?\s*years?\s+(?:of\s+)?experience\b/i,
];

/**
 * Signals that indicate a nice-to-have requirement. When neither
 * must-have nor nice-to-have signals are present, we default to
 * must_have to be conservative.
 */
const NICE_TO_HAVE_SIGNALS: RegExp[] = [
  /\bpreferred\b/i,
  /\bnice\s+to\s+have\b/i,
  /\bdesirable\b/i,
  /\bbonus\b/i,
  /\bplus\b/i,
  /\bideal(?:ly)?\b/i,
  /\badvantage\b/i,
  /\bfamiliarity\b/i,
  /\bexposure\s+to\b/i,
  /\bawareness\b/i,
];

/**
 * Determines severity for a gap based on the requirement text and any
 * explicit JD requirement entry. Defaults to "must_have" when ambiguous.
 */
function classifySeverity(
  requirementText: string,
  jdRequirement?: string,
): "must_have" | "nice_to_have" {
  const textToCheck = (requirementText + " " + (jdRequirement ?? "")).toLowerCase();

  // Check nice-to-have first since must-have is the conservative default
  for (const signal of NICE_TO_HAVE_SIGNALS) {
    if (signal.test(textToCheck)) return "nice_to_have";
  }

  // Explicit must-have signals
  for (const signal of MUST_HAVE_SIGNALS) {
    if (signal.test(textToCheck)) return "must_have";
  }

  // Default: assume must-have (conservative)
  return "must_have";
}

// ── Question Generation ──────────────────────────────────────────

/**
 * Generates a specific clarification question from a gap note.
 * Produces a "Do you have...?" style question that the candidate
 * can answer directly.
 */
function questionFromGapNote(gap: GapNote): string {
  const req = gap.requirement_text.trim();

  // If the requirement mentions a specific tool/technology, ask about it directly
  const toolMatch = req.match(
    /\b(?:experience\s+(?:with|in|using)|proficiency\s+(?:in|with)|knowledge\s+of)\s+(.+)/i,
  );
  if (toolMatch) {
    return `Do you have experience with ${toolMatch[1].replace(/[?.!]$/, "")}?`;
  }

  // If the requirement mentions years of experience
  const yearsMatch = req.match(/(\d+\+?)\s*years?\s+(?:of\s+)?(.+)/i);
  if (yearsMatch) {
    return `Do you have ${yearsMatch[1]} years of ${yearsMatch[2].replace(/[?.!]$/, "")}?`;
  }

  // If the requirement mentions a certification
  const certMatch = req.match(
    /\b(?:certification|certified|license|accreditation)\s+(?:in|for|as)?\s*(.+)/i,
  );
  if (certMatch) {
    return `Do you hold a certification in ${certMatch[1].replace(/[?.!]$/, "")}?`;
  }

  // If the requirement mentions a degree
  const degreeMatch = req.match(
    /\b(?:degree|diploma|masters?|bachelor'?s?|phd|doctorate)\s+(?:in|of)?\s*(.+)/i,
  );
  if (degreeMatch) {
    return `Do you have a degree in ${degreeMatch[1].replace(/[?.!]$/, "")}?`;
  }

  // Generic fallback: transform the requirement into a question
  const cleaned = req.replace(/[.!]+$/, "").trim();
  return `Do you have experience with ${cleaned.charAt(0).toLowerCase() + cleaned.slice(1)}?`;
}

/**
 * Generates a clarification question from a mandate gap. Mandate gaps
 * come from the mandate classifier and describe high-level capability
 * gaps rather than specific JD line items.
 */
function questionFromMandateGap(gap: MandateGap): string {
  const label = gap.label.trim();
  return `Can you describe any experience related to ${label.charAt(0).toLowerCase() + label.slice(1)}?`;
}

// ── JD Requirement Matching ──────────────────────────────────────

/**
 * Attempts to find the original JD requirement text that corresponds to
 * a gap note's requirement_text. This provides additional context for
 * severity classification.
 */
function findMatchingJdRequirement(
  gapText: string,
  jdRequirements?: string[],
): string | undefined {
  if (!jdRequirements || jdRequirements.length === 0) return undefined;

  const gapNorm = gapText.toLowerCase().trim();

  // Try exact substring match first
  for (const req of jdRequirements) {
    const reqNorm = req.toLowerCase().trim();
    if (reqNorm.includes(gapNorm) || gapNorm.includes(reqNorm)) {
      return req;
    }
  }

  // Try word overlap match
  const gapWordsArr = gapNorm.split(/\s+/).filter((w) => w.length > 3);
  const gapWordsSet = new Set(gapWordsArr);
  let bestMatch: string | undefined;
  let bestOverlap = 0;

  for (const req of jdRequirements) {
    const reqWords = new Set(req.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    let overlap = 0;
    for (let i = 0; i < gapWordsArr.length; i++) {
      if (reqWords.has(gapWordsArr[i])) overlap++;
    }
    const ratio = overlap / Math.max(gapWordsSet.size, 1);
    if (ratio > bestOverlap && ratio >= 0.4) {
      bestOverlap = ratio;
      bestMatch = req;
    }
  }

  return bestMatch;
}

// ── Deduplication ────────────────────────────────────────────────

/**
 * Deduplicates clarification questions by normalizing the requirement
 * text and checking for near-duplicates. Prefers the entry with a
 * closest_ledger_match when both exist.
 */
function deduplicateQuestions(questions: ClarificationQuestion[]): ClarificationQuestion[] {
  const seen = new Map<string, ClarificationQuestion>();

  for (const q of questions) {
    const key = q.jd_requirement
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, q);
    } else {
      // Keep the one with more context (closest_ledger_match)
      if (!existing.closest_ledger_match && q.closest_ledger_match) {
        seen.set(key, q);
      }
      // Prefer must_have over nice_to_have severity
      if (existing.gap_severity === "nice_to_have" && q.gap_severity === "must_have") {
        seen.set(key, { ...q, closest_ledger_match: q.closest_ledger_match || existing.closest_ledger_match });
      }
    }
  }

  return Array.from(seen.values());
}

// ── Main Entry Point ─────────────────────────────────────────────

/**
 * Converts gap analysis results into structured clarification questions.
 *
 * Takes two sources of gaps:
 * 1. `gapNotes` from the resume's `gap_notes` field (GapNote[]) --
 *    these are specific JD requirements the resume could not support.
 * 2. `mandateGaps` from the mandate classifier (MandateGap[]) --
 *    these are high-level mandate dimensions that lack inventory evidence.
 *
 * Optionally accepts the raw JD requirements list for improved severity
 * classification (checking for "required", "preferred", etc.).
 *
 * @param gapNotes  Gap notes from the resume (TailoredResume.gap_notes)
 * @param mandateGaps  Mandate gaps from the mandate classifier
 * @param jdRequirements  Optional list of raw JD requirement strings
 * @returns  Deduplicated list of clarification questions
 */
export function buildClarificationQuestions(
  gapNotes: GapNote[],
  mandateGaps: MandateGap[],
  jdRequirements?: string[],
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  // Process gap notes from the resume
  for (const gap of gapNotes) {
    const matchingJdReq = findMatchingJdRequirement(gap.requirement_text, jdRequirements);

    questions.push({
      jd_requirement: gap.requirement_text,
      question: questionFromGapNote(gap),
      closest_ledger_match: gap.closest_match || undefined,
      gap_severity: classifySeverity(gap.requirement_text, matchingJdReq),
    });
  }

  // Process mandate gaps from the classifier
  for (const gap of mandateGaps) {
    // Only generate questions for significant gaps (coverage below 0.3)
    if (gap.best_coverage >= 0.3) continue;

    questions.push({
      jd_requirement: gap.label,
      question: questionFromMandateGap(gap),
      closest_ledger_match: gap.suggestion || undefined,
      gap_severity: gap.weight >= 0.7 ? "must_have" : "nice_to_have",
    });
  }

  return deduplicateQuestions(questions);
}
