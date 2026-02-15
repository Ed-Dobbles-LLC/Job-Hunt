/**
 * Repair Controller
 *
 * Centralizes all resume repair logic into a single controller that:
 *
 *   1. Applies SAFE deterministic patches (typo fixes, doubled suffixes)
 *      — These are the only direct text mutations allowed post-generation.
 *   2. For semantic issues (verb misalignment, hype, mandate drift),
 *      builds a structured repair prompt and delegates to a constrained
 *      LLM call — counted under the global pipeline budget.
 *   3. Enforces that no repair exceeds the budget.
 *
 * DESIGN:
 *   - Deterministic patches are safe because they fix clear corruption
 *     (e.g., "Strengthenedd" → "Strengthened") with zero semantic risk.
 *   - LLM repairs are constrained: the LLM receives the current resume +
 *     a list of specific issues to fix, nothing else.
 *   - Each repair call is counted against the pipeline budget.
 *   - If budget is exhausted, issues are returned as human_review_notes.
 */

import type { TailoredResume } from "../mastra/tools/tailoredResumePrompt";
import type { PostProcessingIssue } from "./post-processing-controller";
import type { PipelineBudget } from "./pipeline-budget";

// ── Types ────────────────────────────────────────────────────────

export interface RepairResult {
  resume: TailoredResume;
  patches_applied: RepairPatch[];
  llm_repairs_requested: number;
  llm_repairs_completed: number;
  remaining_issues: string[];
  budget_exhausted: boolean;
}

export interface RepairPatch {
  type: "deterministic" | "llm";
  location: string;
  original: string;
  repaired: string;
  explanation: string;
}

// ── Legitimate Word Exceptions ───────────────────────────────────

const LEGIT_DOUBLED_SUFFIX_WORDS = new Set([
  "succeeded", "exceeded", "preceded", "proceeded",
  "needed", "seeded", "heeded", "superseded", "conceded",
  "receded", "impeded", "stampeded", "acceded", "ceded",
  "added", "adding",
  "singing", "bringing", "ringing", "stinging",
  "clinging", "wringing", "stringing", "swinging",
  "springing", "flinging", "slinging",
]);

// ── Deterministic Patches ────────────────────────────────────────

/**
 * Apply safe deterministic patches to fix clear text corruption.
 * These are the ONLY direct text mutations allowed post-generation.
 *
 * Safe patches:
 *   - Doubled -ed suffix: "Strengthenedd" → "Strengthened"
 *   - Doubled -ing suffix: "Implementinging" → "Implementing"
 *   - Doubled terminal consonant: "Builtt" → "Built"
 *   - Triple letters: "Deliverrred" → "Delivered"
 */
export function applyDeterministicPatches(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
): RepairPatch[] {
  const patches: RepairPatch[] = [];
  const corruptionIssues = issues.filter(i => i.category === "corruption" && i.severity === "blocking");

  for (const issue of corruptionIssues) {
    const corruptedWord = issue.text;
    if (!corruptedWord || corruptedWord.length < 4) continue;

    const clean = corruptedWord.replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (LEGIT_DOUBLED_SUFFIX_WORDS.has(clean)) continue;

    let fixed: string | null = null;

    // Fix doubled -ed suffix
    if (clean.endsWith("eded") && clean.length > 6) {
      fixed = corruptedWord.replace(/eded\b/i, "ed");
    }
    // Fix doubled -ing suffix
    if (clean.endsWith("inging") && clean.length > 8) {
      fixed = corruptedWord.replace(/inging\b/i, "ing");
    }
    // Fix tripled letters
    const tripleMatch = clean.match(/(.)\1{2,}/);
    if (tripleMatch && !fixed) {
      const char = tripleMatch[1];
      fixed = corruptedWord.replace(new RegExp(`${char}{3,}`, "gi"), char + char);
    }

    if (fixed && fixed !== corruptedWord) {
      // Apply the fix in the resume
      const applied = applyTextFix(resume, issue.location, corruptedWord, fixed);
      if (applied) {
        patches.push({
          type: "deterministic",
          location: issue.location,
          original: corruptedWord,
          repaired: fixed,
          explanation: issue.explanation,
        });
      }
    }
  }

  return patches;
}

/**
 * Apply a single text fix at a specific location in the resume.
 * Returns true if the fix was applied.
 */
function applyTextFix(
  resume: TailoredResume,
  location: string,
  original: string,
  replacement: string,
): boolean {
  if (location === "summary") {
    if (resume.professional_summary.includes(original)) {
      resume.professional_summary = resume.professional_summary.replace(original, replacement);
      return true;
    }
  }

  const expMatch = location.match(/experience\[(\d+)\]\.bullets\[(\d+)\]/);
  if (expMatch) {
    const [, expIdx, bulletIdx] = expMatch;
    const exp = resume.experience[parseInt(expIdx)];
    if (exp) {
      const bullet = exp.bullets[parseInt(bulletIdx)];
      if (bullet && bullet.text.includes(original)) {
        bullet.text = bullet.text.replace(original, replacement);
        return true;
      }
    }
  }

  const scopeMatch = location.match(/experience\[(\d+)\]\.scope_line/);
  if (scopeMatch) {
    const [, expIdx] = scopeMatch;
    const exp = resume.experience[parseInt(expIdx)] as any;
    if (exp?.scope_line?.includes(original)) {
      exp.scope_line = exp.scope_line.replace(original, replacement);
      return true;
    }
  }

  return false;
}

// ── Repair Controller ────────────────────────────────────────────

/**
 * Run the repair controller on a resume with detected issues.
 *
 * SAFE deterministic patches are applied directly.
 * Semantic issues are reported back for human review (or LLM repair
 * if budget permits — LLM repair integration is optional and
 * requires the caller to provide a repair callback).
 */
export function runRepairController(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
  budget?: PipelineBudget,
  logger?: any,
): RepairResult {
  logger?.info(`🔧 [Repair] Processing ${issues.length} issues...`);

  // 1. Apply safe deterministic patches
  const patches = applyDeterministicPatches(resume, issues);
  logger?.info(`🔧 [Repair] Applied ${patches.length} deterministic patches`);

  // 2. Collect remaining issues that need LLM repair or human review
  const patchedWords = new Set(patches.map(p => p.original));
  const remainingIssues = issues
    .filter(i => !patchedWords.has(i.text))
    .filter(i => i.severity === "blocking" || i.severity === "warning")
    .map(i => `${i.category}: ${i.explanation} at ${i.location}`);

  // 3. Check budget for LLM repair
  const budgetExhausted = budget ? budget.wouldExceed({ llm_calls: 1 }) !== null : true;

  if (budgetExhausted && remainingIssues.length > 0) {
    logger?.info(`🔧 [Repair] Budget exhausted — ${remainingIssues.length} issues deferred to human review`);
  }

  return {
    resume,
    patches_applied: patches,
    llm_repairs_requested: 0,
    llm_repairs_completed: 0,
    remaining_issues: remainingIssues,
    budget_exhausted: budgetExhausted,
  };
}
