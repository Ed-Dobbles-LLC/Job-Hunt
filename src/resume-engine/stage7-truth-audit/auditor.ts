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

// ── Combined Truth Audit ─────────────────────────────────────────

export interface TruthAuditResult {
  report: VerifierReport;
  ownershipWarnings: OwnershipInflationWarning[];
}

/**
 * Runs the full truth audit: the existing truthfulness verification
 * (entities, metrics, dates, placeholders, style rules, ATS risks,
 * claims ledger checks) PLUS the new ownership inflation detection.
 *
 * This is the primary entry point for Stage 7 of the resume tailoring
 * pipeline.
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

  return { report, ownershipWarnings };
}
