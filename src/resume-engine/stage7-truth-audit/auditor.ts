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
//
// Ownership Guard Rule: if a verb implies full authority (e.g., "drove
// board decision", "owned governance", "defined enterprise-wide strategy"),
// verify baseline support. If unsupported → rewrite as "led within",
// "partnered on", or "contributed to". Block if ownership is inflated.

interface InflationPair {
  weak: RegExp;
  strong: RegExp;
  label: string;
  severity: "warning" | "critical";
  rewrite_verb: string; // Suggested de-escalation verb
}

const INFLATION_PAIRS: InflationPair[] = [
  // ── Core contributor→owner escalation (CRITICAL — most common fabrication) ──
  {
    weak: /\b(?:contributed|helped|assisted|supported|participated|involved)\b/i,
    strong: /\b(?:built|created|architected|spearheaded|led|launched|established|drove|owned)\b/i,
    label: "contributor -> owner",
    severity: "critical",
    rewrite_verb: "contributed to",
  },
  // ── Team member→sole contributor (CRITICAL) ──
  {
    weak: /\b(?:member|part of|team|collaborative)\b/i,
    strong: /\b(?:single-handedly|solely|independently|single.?handedly)\b/i,
    label: "team member -> sole contributor",
    severity: "critical",
    rewrite_verb: "partnered on",
  },
  // ── Helper→transformer (CRITICAL) ──
  {
    weak: /\b(?:helped|supported|assisted)\b/i,
    strong: /\b(?:transformed|revolutionized|pioneered|overhauled)\b/i,
    label: "helper -> transformer",
    severity: "critical",
    rewrite_verb: "led within",
  },
  // ── Participant→strategist (CRITICAL — inflates scope to strategic level) ──
  {
    weak: /\b(?:participated|involved|engaged|attended)\b/i,
    strong: /\b(?:defined|designed|formulated|shaped)\s+(?:the\s+)?(?:strategy|roadmap|vision)\b/i,
    label: "participant -> strategist",
    severity: "critical",
    rewrite_verb: "contributed to",
  },
  // ── Advisor→decision-maker (CRITICAL — implies authority the candidate lacked) ──
  {
    weak: /\b(?:advised|recommended|suggested|proposed|briefed)\b/i,
    strong: /\b(?:decided|mandated|approved|authorized|directed the board)\b/i,
    label: "advisor -> decision-maker",
    severity: "critical",
    rewrite_verb: "advised on",
  },
  // ── Implementer→architect (WARNING — scope inflation) ──
  {
    weak: /\b(?:implemented|deployed|configured|set up|installed|maintained)\b/i,
    strong: /\b(?:architected|designed|conceived|envisioned|invented)\b/i,
    label: "implementer -> architect",
    severity: "warning",
    rewrite_verb: "implemented",
  },
  // ── Managed→founded (CRITICAL — implies company/org creation) ──
  {
    weak: /\b(?:managed|oversaw|supervised|coordinated)\b/i,
    strong: /\b(?:founded|created from scratch|built from zero|established from nothing)\b/i,
    label: "manager -> founder",
    severity: "critical",
    rewrite_verb: "managed",
  },
  // ── Co-led→sole-led (WARNING — removes collaboration credit) ──
  {
    weak: /\b(?:co-led|collaborated|jointly|partnered|shared|together)\b/i,
    strong: /\b(?:solely led|single-handedly led|exclusively led|independently led)\b/i,
    label: "co-led -> sole-led",
    severity: "critical",
    rewrite_verb: "co-led",
  },
];

// ── Enterprise-Scope Verb Detection ─────────────────────────────
//
// These patterns detect verbs that imply enterprise-wide authority.
// They are checked REGARDLESS of source text — if the inventory does
// not contain evidence of enterprise-scope work, these are flagged.

const ENTERPRISE_SCOPE_VERBS: { pattern: RegExp; label: string; rewrite: string }[] = [
  { pattern: /\bdrove\s+(?:the\s+)?board\s+decision/i, label: "drove board decision", rewrite: "presented to the board" },
  { pattern: /\bowned\s+(?:the\s+)?governance/i, label: "owned governance", rewrite: "led governance within" },
  { pattern: /\bdefined\s+enterprise-wide\s+strategy/i, label: "defined enterprise-wide strategy", rewrite: "contributed to enterprise strategy" },
  { pattern: /\bset\s+(?:the\s+)?company-wide\s+(?:strategy|direction|vision)/i, label: "set company-wide direction", rewrite: "influenced company direction" },
  { pattern: /\btransformed\s+(?:the\s+)?(?:entire\s+)?organization/i, label: "transformed the organization", rewrite: "led transformation within" },
  { pattern: /\bsingle-handedly\s+(?:built|created|established)/i, label: "single-handedly built", rewrite: "led the development of" },
  { pattern: /\brecovered\s+\$\d+[MBT]/i, label: "recovered $X (large scope)", rewrite: "identified recovery opportunities totaling" },
  { pattern: /\bsaved\s+(?:the\s+)?company\s+\$\d+/i, label: "saved the company $X", rewrite: "contributed to savings of" },
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
 * Ownership Guard Rule:
 * 1. Pattern-based detection: weak (inventory) → strong (draft) escalation
 * 2. Enterprise-scope detection: verbs implying full authority without evidence
 * 3. Auto-rewrite: critical violations are rewritten to de-escalated language
 *
 * Returns an array of warnings, each describing the inflation found.
 * If autoRewrite is true (default), mutates bullet text in-place.
 */
export function detectOwnershipInflation(
  resume: TailoredResume,
  inventory: Record<string, any>,
  autoRewrite: boolean = true,
): OwnershipInflationWarning[] {
  const warnings: OwnershipInflationWarning[] = [];
  const inventoryBullets = extractInventoryBullets(inventory);

  // ── Phase 1: Pattern-based inflation detection ──
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
          const weakMatch = originalText.match(pair.weak);
          const strongMatch = draftText.match(pair.strong);

          const severity = pair.severity;

          // Auto-rewrite: replace the inflated verb with the de-escalated one
          if (autoRewrite && severity === "critical" && strongMatch?.[0]) {
            const rewritten = bullet.text.replace(strongMatch[0], pair.rewrite_verb);
            bullet.text = rewritten[0].toUpperCase() + rewritten.slice(1);
          }

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
                ? `OWNERSHIP GUARD: Rewritten to "${pair.rewrite_verb}". Original claim misrepresents scope.`
                : `Consider using "${pair.rewrite_verb}" to match the inventory's ownership level.`),
          });
        }
      }
    }
  }

  // ── Phase 2: Enterprise-scope verb detection ──
  // These verbs imply org-wide authority. Flag unless inventory explicitly supports them.
  const allInventoryText = inventoryBullets.map(b => b.text).join(" ").toLowerCase();

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];
    for (let j = 0; j < exp.bullets.length; j++) {
      const bullet = exp.bullets[j];
      const draftText = bullet.text;

      for (const ev of ENTERPRISE_SCOPE_VERBS) {
        const match = draftText.match(ev.pattern);
        if (!match) continue;

        // Check if the inventory actually supports this scope claim
        const inventorySupports = ev.pattern.test(allInventoryText);
        if (inventorySupports) continue; // Inventory backs it up — no inflation

        // Auto-rewrite: de-escalate the enterprise-scope verb
        if (autoRewrite) {
          const rewritten = draftText.replace(match[0], ev.rewrite);
          bullet.text = rewritten[0].toUpperCase() + rewritten.slice(1);
        }

        warnings.push({
          location: `resume.experience[${i}].bullets[${j}]`,
          original_text: "(no inventory support for enterprise-scope claim)",
          draft_text: draftText,
          pattern: `enterprise-scope: ${ev.label}`,
          severity: "critical",
          explanation:
            `Draft claims "${match[0]}" but inventory has no evidence of enterprise-scope authority. ` +
            `OWNERSHIP GUARD: Rewritten to "${ev.rewrite}". ` +
            `Verbs implying board-level or company-wide authority require explicit inventory support.`,
        });
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
  // Generic role-first patterns
  /^data\s+(?:and\s+)?analytics?\s+(?:leader|executive)\s+who/i,
  /^executive\s+with\s+a\s+track\s+record/i,
  /^analytics?\s+executive\s+transform/i,
  /^seasoned\s+(?:\w+\s+)?(?:leader|executive|professional)/i,
  /^accomplished\s+(?:\w+\s+)?(?:leader|executive|professional)/i,
  /^results[- ]driven\s+/i,
  /^\w+\s+leader\s+who\s+has\b/i,
  /^\w+\s+executive\s+who\s+has\b/i,
  /^\w+\s+(?:leader|executive)\s+with\s+(?:\d+|over|more than)/i,
  // Descriptive/passive openers (not thesis-driven)
  /^career\s+marked\s+by\b/i,
  /^career\s+defined\s+by\b/i,
  /^track\s+record\s+of\b/i,
  /^known\s+for\b/i,
  /^the\s+board'?s?\s+decision\s+was\s+driven\s+by\b/i,
  /^with\s+(?:over|more than|\d+)\s+years?\b/i,
  /^proven\s+ability\s+to\b/i,
  /^extensive\s+experience\s+in\b/i,
  /^passionate\s+about\b/i,
  /^dedicated\s+(?:\w+\s+)?(?:leader|executive|professional)/i,
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

  // Block if critical ownership inflation (all patterns with severity "critical")
  // Note: auto-rewrite has already been applied, but we still flag the violations
  // for the quality report and to signal that the output was corrected
  const criticalInflation = ownershipWarnings.filter(w => w.severity === "critical");
  if (criticalInflation.length > 0) {
    const patterns = [...new Set(criticalInflation.map(w => w.pattern))].join(", ");
    blockReasons.push(
      `${criticalInflation.length} critical ownership inflation(s) detected and auto-rewritten (${patterns})`,
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
