/**
 * Stage Contract Matrix
 *
 * Defines the contract for every pipeline stage: what it receives,
 * what it may mutate, what it must NOT touch, its failure mode,
 * retry policy, and maximum attempts.
 *
 * The pipeline orchestrator enforces these contracts at runtime via
 * the `validateStageContract()` function, which snapshots structural
 * fields before a stage runs and asserts they are unchanged after.
 *
 * DESIGN PRINCIPLES:
 *   1. No stage may modify fields outside its "allowed_mutations" list.
 *   2. No two stages may mutate the same structural element.
 *   3. Detection-only stages (QA Gate, Refinement Layer) NEVER mutate.
 *   4. LLM stages that fail are retried up to their contract limit,
 *      not the pipeline's global limit.
 *   5. Global budget caps (LLM calls, cost, tokens) are checked
 *      between stages, not inside them.
 */

import type { TailoredResume } from "../mastra/tools/tailoredResumePrompt";

// ── Stage Identifiers ────────────────────────────────────────────

export type StageId =
  | "stage1_claims_ledger"
  | "stage2_mandate_classifier"
  | "stage3_bullet_scoring"
  | "stage4_constrained_rewrite"
  | "stage5_differentiation"
  | "stage6_layout_governor"
  | "stage7_truth_audit"
  | "stage8_recruiter_review"
  | "post_processing";

// ── Mutation Scope ───────────────────────────────────────────────

/**
 * Granular mutation targets that stages can declare.
 * Each target maps to a specific structural area of the resume.
 */
export type MutationTarget =
  | "resume.full"                  // Full resume creation (Stage 4 only)
  | "resume.experience.bullets"    // Bullet text, order, count
  | "resume.experience.order"      // Role ordering
  | "resume.professional_summary"  // Summary text
  | "resume.core_competencies"     // Competency list
  | "resume.experience.scope_line" // Scope line text
  | "cover_letter.full"           // Full cover letter (Stage 4 only)
  | "claims_ledger"               // Claims ledger (Stage 1 only)
  | "mandate_profile"             // Mandate profile (Stage 2 only)
  | "bullet_plan"                 // Scored bullet plan (Stage 3 only)
  | "none";                       // No mutations allowed

// ── Failure Modes ────────────────────────────────────────────────

export type FailureMode =
  | "abort"           // Pipeline cannot continue
  | "retry"           // Retry the stage (up to max_attempts)
  | "degrade"         // Continue with degraded output, set human_review_required
  | "skip"            // Skip this stage, continue pipeline
  | "best_effort";    // Return best attempt so far

// ── Stage Contract Definition ────────────────────────────────────

export interface StageContract {
  id: StageId;
  name: string;
  type: "deterministic" | "llm" | "hybrid";

  /** What this stage receives as input */
  inputs: string[];

  /** What this stage is allowed to mutate */
  allowed_mutations: MutationTarget[];

  /** What this stage must NEVER modify */
  forbidden_mutations: MutationTarget[];

  /** What happens when this stage fails */
  failure_mode: FailureMode;

  /** Maximum attempts for this stage (per pipeline run) */
  max_attempts: number;

  /** Whether this stage makes LLM calls */
  uses_llm: boolean;

  /** Maximum LLM calls this stage may make per attempt */
  max_llm_calls_per_attempt: number;

  /** Human-readable description of responsibility */
  responsibility: string;
}

// ── Stage Contract Registry ──────────────────────────────────────

export const STAGE_CONTRACTS: Record<StageId, StageContract> = {
  stage1_claims_ledger: {
    id: "stage1_claims_ledger",
    name: "Claims Ledger Extraction",
    type: "deterministic",
    inputs: ["experience_inventory"],
    allowed_mutations: ["claims_ledger"],
    forbidden_mutations: ["resume.full", "cover_letter.full", "mandate_profile", "bullet_plan"],
    failure_mode: "abort",
    max_attempts: 1,
    uses_llm: false,
    max_llm_calls_per_attempt: 0,
    responsibility: "Parse inventory into structured Claims with unique IDs. Read-only on inventory.",
  },

  stage2_mandate_classifier: {
    id: "stage2_mandate_classifier",
    name: "Mandate Classification",
    type: "hybrid",
    inputs: ["jd_text", "title", "requirements"],
    allowed_mutations: ["mandate_profile"],
    forbidden_mutations: ["resume.full", "cover_letter.full", "claims_ledger", "bullet_plan"],
    failure_mode: "abort",
    max_attempts: 2,
    uses_llm: true,
    max_llm_calls_per_attempt: 1,
    responsibility: "Classify JD into mandate profile with archetypes, seniority, and tone guidance.",
  },

  stage3_bullet_scoring: {
    id: "stage3_bullet_scoring",
    name: "Bullet Scoring & Reordering",
    type: "deterministic",
    inputs: ["inventory", "mandate", "ledger", "requirements"],
    allowed_mutations: ["bullet_plan"],
    forbidden_mutations: ["resume.full", "cover_letter.full", "claims_ledger", "mandate_profile"],
    failure_mode: "abort",
    max_attempts: 1,
    uses_llm: false,
    max_llm_calls_per_attempt: 0,
    responsibility: "Score and rank bullets by mandate alignment, impact, and recency. Produce ranked plan.",
  },

  stage4_constrained_rewrite: {
    id: "stage4_constrained_rewrite",
    name: "Constrained Rewrite",
    type: "llm",
    inputs: ["inventory", "allowlist", "requirements", "mandate", "bullet_plan", "correction_context"],
    allowed_mutations: ["resume.full", "cover_letter.full"],
    forbidden_mutations: ["claims_ledger", "mandate_profile", "bullet_plan"],
    failure_mode: "retry",
    max_attempts: 3,
    uses_llm: true,
    max_llm_calls_per_attempt: 4, // resume + cover letter + up to 2 corrections
    responsibility: "Generate structured resume + cover letter via LLM. Must cite claim_ids for every bullet.",
  },

  stage5_differentiation: {
    id: "stage5_differentiation",
    name: "Differentiation Gate",
    type: "deterministic",
    inputs: ["resume", "job_id", "mandate"],
    allowed_mutations: ["none"],
    forbidden_mutations: ["resume.full", "cover_letter.full", "claims_ledger", "mandate_profile"],
    failure_mode: "degrade",
    max_attempts: 1,
    uses_llm: false,
    max_llm_calls_per_attempt: 0,
    responsibility: "Compare against prior resumes. Return divergence score. NEVER mutate resume.",
  },

  stage6_layout_governor: {
    id: "stage6_layout_governor",
    name: "Layout Governor",
    type: "deterministic",
    inputs: ["resume", "mandate"],
    allowed_mutations: [
      "resume.experience.bullets",
      "resume.experience.order",
      "resume.professional_summary",
      "resume.core_competencies",
      "resume.experience.scope_line",
    ],
    forbidden_mutations: ["cover_letter.full", "claims_ledger", "mandate_profile", "bullet_plan"],
    failure_mode: "degrade",
    max_attempts: 1,
    uses_llm: false,
    max_llm_calls_per_attempt: 0,
    responsibility: "Enforce layout rules: bullet caps, word limits, page budget, chronological order. The ONLY stage that modifies resume structure post-generation.",
  },

  stage7_truth_audit: {
    id: "stage7_truth_audit",
    name: "Truth Audit",
    type: "deterministic",
    inputs: ["resume", "cover_letter", "allowlist", "inventory"],
    allowed_mutations: ["none"],
    forbidden_mutations: ["resume.full", "cover_letter.full", "claims_ledger", "mandate_profile"],
    failure_mode: "retry",
    max_attempts: 1,
    uses_llm: false,
    max_llm_calls_per_attempt: 0,
    responsibility: "Verify all claims against ledger + allowlist. Detect ownership inflation. NEVER mutate content.",
  },

  stage8_recruiter_review: {
    id: "stage8_recruiter_review",
    name: "Recruiter Review",
    type: "llm",
    inputs: ["claims_ledger", "mandate", "truth_audit_report", "layout_report", "jd_text", "resume", "cover_letter"],
    allowed_mutations: ["none"],
    forbidden_mutations: ["resume.full", "cover_letter.full", "claims_ledger", "mandate_profile"],
    failure_mode: "degrade",
    max_attempts: 1,
    uses_llm: true,
    max_llm_calls_per_attempt: 1,
    responsibility: "Produce structured feedback ONLY. NEVER rewrite content. Return PASS/FAIL with issues.",
  },

  post_processing: {
    id: "post_processing",
    name: "Post-Processing Controller",
    type: "deterministic",
    inputs: ["resume", "cover_letter", "mandate", "ledger", "inventory"],
    allowed_mutations: ["none"],
    forbidden_mutations: ["resume.full", "cover_letter.full", "claims_ledger", "mandate_profile"],
    failure_mode: "skip",
    max_attempts: 1,
    uses_llm: false,
    max_llm_calls_per_attempt: 0,
    responsibility: "Detection-only quality assessment. Scores and flags issues. NEVER mutates content.",
  },
};

// ── Contract Validation ──────────────────────────────────────────

/**
 * Snapshot of resume structural fields for contract validation.
 * Used to detect unauthorized mutations.
 */
export interface ResumeSnapshot {
  summary_hash: string;
  experience_count: number;
  bullet_texts: string[];
  competency_count: number;
  scope_lines: string[];
}

/**
 * Take a structural snapshot of a resume for contract validation.
 */
export function snapshotResume(resume: TailoredResume): ResumeSnapshot {
  const bulletTexts: string[] = [];
  const scopeLines: string[] = [];

  for (const exp of resume.experience) {
    for (const b of exp.bullets) {
      bulletTexts.push(b.text);
    }
    if ((exp as any).scope_line) {
      scopeLines.push((exp as any).scope_line);
    }
  }

  return {
    summary_hash: simpleHash(resume.professional_summary),
    experience_count: resume.experience.length,
    bullet_texts: bulletTexts,
    competency_count: ((resume as any).core_competencies || []).length,
    scope_lines: scopeLines,
  };
}

/**
 * Validate that a stage respected its contract by comparing
 * before/after snapshots.
 *
 * Returns null if valid, or an error message describing the violation.
 */
export function validateStageContract(
  contract: StageContract,
  before: ResumeSnapshot,
  after: ResumeSnapshot,
): string | null {
  // If "none" is in allowed_mutations, nothing should have changed
  if (contract.allowed_mutations.includes("none")) {
    if (before.summary_hash !== after.summary_hash) {
      return `${contract.name} violated contract: modified professional_summary (forbidden)`;
    }
    if (before.experience_count !== after.experience_count) {
      return `${contract.name} violated contract: modified experience count (forbidden)`;
    }
    if (before.bullet_texts.join("|") !== after.bullet_texts.join("|")) {
      return `${contract.name} violated contract: modified bullet text (forbidden)`;
    }
    if (before.competency_count !== after.competency_count) {
      return `${contract.name} violated contract: modified competency count (forbidden)`;
    }
    if (before.scope_lines.join("|") !== after.scope_lines.join("|")) {
      return `${contract.name} violated contract: modified scope lines (forbidden)`;
    }
    return null;
  }

  // Check forbidden mutations
  for (const forbidden of contract.forbidden_mutations) {
    switch (forbidden) {
      case "resume.professional_summary":
        if (before.summary_hash !== after.summary_hash) {
          return `${contract.name} violated contract: modified professional_summary (forbidden)`;
        }
        break;
      case "resume.experience.bullets":
        if (before.bullet_texts.join("|") !== after.bullet_texts.join("|")) {
          return `${contract.name} violated contract: modified bullet text (forbidden)`;
        }
        break;
      case "resume.core_competencies":
        if (before.competency_count !== after.competency_count) {
          return `${contract.name} violated contract: modified competency count (forbidden)`;
        }
        break;
      // "resume.full" and "cover_letter.full" are creation-only (Stage 4)
      // No need to validate; they don't exist before Stage 4 runs
    }
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────

function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
