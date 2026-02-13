/**
 * Stage 7: Truth Audit
 *
 * Wraps the existing truthfulness verifier and adds ownership inflation
 * detection. The verifier catches hallucinated entities, metrics, dates,
 * placeholders, and style violations. This auditor layer adds a new class
 * of check: detecting when the LLM inflates ownership language beyond
 * what the source inventory supports.
 *
 * Example: inventory says "contributed to migration" but the draft resume
 * says "architected migration" -- that is ownership inflation.
 */

import {
  runTruthfulnessVerification,
  type VerifierReport,
} from "../../mastra/tools/truthfulnessVerifier";
import type { TailoredResume } from "../../mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../../mastra/tools/tailoredCoverLetterPrompt";
import type { EntityAllowlist } from "../../mastra/tools/entityAllowlist";
import type { OwnershipInflationWarning } from "../types";

// Re-export the upstream types so consumers can import from this module
export type { VerifierReport } from "../../mastra/tools/truthfulnessVerifier";
export type { OwnershipInflationWarning } from "../types";

// ── Inflation Pattern Pairs ──────────────────────────────────────
//
// Each pair has a `weak` regex (language found in the inventory) and a
// `strong` regex (inflated language found in the draft). If a resume
// bullet matches `strong` AND its source inventory bullet matches `weak`,
// we flag it as ownership inflation.

interface InflationPair {
  weak: RegExp;
  strong: RegExp;
  label: string;
}

const INFLATION_PAIRS: InflationPair[] = [
  {
    weak: /\b(?:contributed|helped|assisted|supported|participated|involved)\b/i,
    strong: /\b(?:built|created|architected|spearheaded|led|launched|established|drove|owned)\b/i,
    label: "contributor -> owner",
  },
  {
    weak: /\b(?:member|part of|team|collaborative)\b/i,
    strong: /\b(?:single-handedly|solely|independently|single.?handedly)\b/i,
    label: "team member -> sole contributor",
  },
  {
    weak: /\b(?:helped|supported|assisted)\b/i,
    strong: /\b(?:transformed|revolutionized|pioneered)\b/i,
    label: "helper -> transformer",
  },
];

// ── Inventory Bullet Extraction ──────────────────────────────────

interface InventoryBullet {
  id: string;
  text: string;
  experienceIndex: number;
  employer: string;
}

/**
 * Flattens the inventory into a list of all experience bullets with their
 * IDs, so we can look up the source bullet for each resume bullet by
 * source_hash.
 */
function extractInventoryBullets(inventory: Record<string, any>): InventoryBullet[] {
  const bullets: InventoryBullet[] = [];
  const experiences = inventory.experience || [];

  for (let i = 0; i < experiences.length; i++) {
    const exp = experiences[i];
    for (const bullet of exp.bullets || []) {
      if (bullet.id && bullet.text) {
        bullets.push({
          id: bullet.id.toLowerCase().trim(),
          text: bullet.text,
          experienceIndex: i,
          employer: exp.employer || exp.company || `experience[${i}]`,
        });
      }
    }
  }

  return bullets;
}

/**
 * Find the inventory source bullet that matches a given source_hash.
 */
function findSourceBullet(
  sourceHash: string,
  inventoryBullets: InventoryBullet[],
): InventoryBullet | undefined {
  const normalized = sourceHash.toLowerCase().trim();
  return inventoryBullets.find((b) => b.id === normalized);
}

// ── Ownership Inflation Detection ────────────────────────────────

/**
 * Scans the tailored resume for ownership inflation relative to the
 * source inventory. For each resume bullet that has a source_hash, we
 * look up the original inventory text and check if the draft inflates
 * the ownership language.
 *
 * Returns an array of warnings, each describing the inflation found.
 */
export function detectOwnershipInflation(
  resume: TailoredResume,
  inventory: Record<string, any>,
): OwnershipInflationWarning[] {
  const warnings: OwnershipInflationWarning[] = [];
  const inventoryBullets = extractInventoryBullets(inventory);

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];

    for (let j = 0; j < exp.bullets.length; j++) {
      const bullet = exp.bullets[j];

      if (!bullet.source_hash) continue;

      const source = findSourceBullet(bullet.source_hash, inventoryBullets);
      if (!source) continue;

      const originalText = source.text;
      const draftText = bullet.text;

      for (const pair of INFLATION_PAIRS) {
        const originalHasWeak = pair.weak.test(originalText);
        const draftHasStrong = pair.strong.test(draftText);

        if (originalHasWeak && draftHasStrong) {
          // Extract the specific matched words for the explanation
          const weakMatch = originalText.match(pair.weak);
          const strongMatch = draftText.match(pair.strong);

          const severity = pair.label === "team member -> sole contributor"
            ? "critical" as const
            : "warning" as const;

          warnings.push({
            location: `resume.experience[${i}].bullets[${j}]`,
            original_text: originalText,
            draft_text: draftText,
            pattern: pair.label,
            severity,
            explanation:
              `Inventory uses "${weakMatch?.[0] ?? "(weak language)"}" but draft ` +
              `escalates to "${strongMatch?.[0] ?? "(strong language)"}". ` +
              `Pattern: ${pair.label}. ` +
              (severity === "critical"
                ? "This is a critical inflation that misrepresents the candidate's role."
                : "Consider toning down the language to match the inventory's ownership level."),
          });
        }
      }
    }
  }

  return warnings;
}

// ── Claim IDs Verification ───────────────────────────────────────

interface ClaimAuditResult {
  violations: { location: string; issue: string }[];
  total_bullets: number;
  bullets_with_claims: number;
  bullets_without_claims: number;
}

/**
 * Verify that all resume bullets reference Claims Ledger IDs.
 * Bullets without claim_ids cannot be traced to the source of truth
 * and should be blocked.
 */
function verifyClaimIds(resume: TailoredResume): ClaimAuditResult {
  const violations: { location: string; issue: string }[] = [];
  let totalBullets = 0;
  let withClaims = 0;
  let withoutClaims = 0;

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      totalBullets++;
      const bullet = resume.experience[i].bullets[j];
      const claimIds = (bullet as any).claim_ids;

      if (!claimIds || !Array.isArray(claimIds) || claimIds.length === 0) {
        withoutClaims++;
        violations.push({
          location: `resume.experience[${i}].bullets[${j}]`,
          issue: `Bullet "${bullet.text.substring(0, 50)}..." has no claim_ids — cannot trace to Claims Ledger`,
        });
      } else {
        withClaims++;
      }
    }
  }

  return { violations, total_bullets: totalBullets, bullets_with_claims: withClaims, bullets_without_claims: withoutClaims };
}

// ── Summary Generic Opener Detection ────────────────────────────

const BANNED_SUMMARY_OPENERS = [
  /^data\s+(?:and\s+)?analytics?\s+(?:leader|executive)\s+who/i,
  /^executive\s+with\s+a\s+track\s+record/i,
  /^analytics?\s+executive\s+transform/i,
  /^seasoned\s+(?:\w+\s+)?(?:leader|executive|professional)/i,
  /^accomplished\s+(?:\w+\s+)?(?:leader|executive|professional)/i,
  /^results[- ]driven\s+/i,
  /^\w+\s+leader\s+who\s+has\b/i,
  /^\w+\s+executive\s+who\s+has\b/i,
  /^\w+\s+(?:leader|executive)\s+with\s+(?:\d+|over|more than)/i,
];

interface SummaryOpenerAudit {
  has_banned_opener: boolean;
  matched_pattern: string;
}

function auditSummaryOpener(resume: TailoredResume): SummaryOpenerAudit {
  const summary = resume.professional_summary.trim();
  const firstSentence = summary.split(/[.!?]/)[0] || summary;

  for (const pattern of BANNED_SUMMARY_OPENERS) {
    if (pattern.test(firstSentence)) {
      return {
        has_banned_opener: true,
        matched_pattern: firstSentence.substring(0, 80),
      };
    }
  }

  return { has_banned_opener: false, matched_pattern: "" };
}

// ── Combined Truth Audit ─────────────────────────────────────────

export interface TruthAuditResult {
  report: VerifierReport;
  ownershipWarnings: OwnershipInflationWarning[];
  claimAudit: ClaimAuditResult;
  summaryOpenerAudit: SummaryOpenerAudit;
  blocked: boolean;
  block_reasons: string[];
}

/**
 * Runs the full truth audit: the existing truthfulness verification
 * (entities, metrics, dates, placeholders, style rules, ATS risks,
 * claims ledger checks) PLUS:
 * - Ownership inflation detection
 * - Claim IDs verification (all bullets must reference Claims Ledger)
 * - Summary opener audit (banned generic opener detection)
 *
 * Returns blocked=true if unsupported claims are detected or critical
 * violations cannot be resolved.
 */
export function runTruthAudit(
  resume: TailoredResume,
  coverLetter: TailoredCoverLetter,
  allowlist: EntityAllowlist,
  inventory: Record<string, any>,
): TruthAuditResult {
  // Run the existing comprehensive truthfulness verification
  const report = runTruthfulnessVerification(resume, coverLetter, allowlist, inventory);

  // Run the new ownership inflation detection
  const ownershipWarnings = detectOwnershipInflation(resume, inventory);

  // Verify claim IDs on all bullets
  const claimAudit = verifyClaimIds(resume);

  // Audit summary opener for banned generic patterns
  const summaryOpenerAudit = auditSummaryOpener(resume);

  // Determine if output should be BLOCKED
  const blockReasons: string[] = [];

  // Block if unsupported metrics (new numbers that don't exist in inventory)
  const unsupportedMetrics = report.violations.filter(
    v => v.type === "UNSUPPORTED_METRIC" && v.severity === "critical",
  );
  if (unsupportedMetrics.length > 0) {
    blockReasons.push(
      `${unsupportedMetrics.length} unsupported metric(s) detected — no new numbers allowed`,
    );
  }

  // Block if hallucinated entities (new tools/companies not in inventory)
  const newEntities = report.violations.filter(
    v => v.type === "NEW_ENTITY" && v.severity === "critical",
  );
  if (newEntities.length > 0) {
    blockReasons.push(
      `${newEntities.length} new entity/entities hallucinated — not in inventory`,
    );
  }

  // Block if critical ownership inflation (team member -> sole contributor)
  const criticalInflation = ownershipWarnings.filter(w => w.severity === "critical");
  if (criticalInflation.length > 0) {
    blockReasons.push(
      `${criticalInflation.length} critical ownership inflation(s) — scope expanded beyond inventory`,
    );
  }

  // Add claim audit violations to the report as warnings (non-blocking but tracked)
  for (const v of claimAudit.violations) {
    report.violations.push({
      type: "STYLE_RULE_BROKEN",
      severity: "warning",
      location: v.location,
      found_value: "missing claim_ids",
      explanation: v.issue,
    });
    report.stats.warnings++;
  }

  // Add summary opener violation if banned pattern detected
  if (summaryOpenerAudit.has_banned_opener) {
    report.violations.push({
      type: "STYLE_RULE_BROKEN",
      severity: "warning",
      location: "resume.professional_summary",
      found_value: summaryOpenerAudit.matched_pattern,
      explanation: `Summary opens with a banned generic pattern. The first sentence must be psychologically anchored to the job mandate, not a reusable template.`,
    });
    report.stats.warnings++;
  }

  return {
    report,
    ownershipWarnings,
    claimAudit,
    summaryOpenerAudit,
    blocked: blockReasons.length > 0,
    block_reasons: blockReasons,
  };
}
