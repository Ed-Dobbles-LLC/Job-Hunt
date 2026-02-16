/**
 * Candidate Identity — Hard identity binding for the resume generation pipeline.
 *
 * INVARIANT: Every pipeline run must be bound to a single, verified candidate.
 * If the baseline resume or inventory cannot be resolved, the pipeline MUST
 * fail fast with a clear error. It must NEVER substitute another candidate's
 * inventory or fall back to test fixtures in production.
 *
 * This module provides:
 * - CandidateIdentity type (flows through all stages)
 * - Identity resolution from inventory (deterministic)
 * - SHA-256 hashing for baseline and inventory binding
 * - Output validation guards (name match, employer subset, CL signature)
 * - Typed errors for missing baseline and identity mismatches
 */

import * as crypto from "crypto";

// ── Error Types ─────────────────────────────────────────────────

/**
 * Thrown when the baseline resume or inventory file cannot be found.
 * The pipeline MUST NOT proceed — no fallback is permitted.
 */
export class MissingBaselineError extends Error {
  public readonly candidate_id: string;
  public readonly attempted_paths: string[];

  constructor(candidate_id: string, attempted_paths: string[], detail?: string) {
    const msg = [
      `HARD FAIL: Baseline missing for candidate_id="${candidate_id}".`,
      `Attempted paths: ${attempted_paths.join(", ")}`,
      `Refusing to fall back to fixtures or defaults.`,
      detail ? `Detail: ${detail}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    super(msg);
    this.name = "MissingBaselineError";
    this.candidate_id = candidate_id;
    this.attempted_paths = attempted_paths;
  }
}

/**
 * Thrown when a candidate identity check fails at any stage.
 * This means the loaded data does not match the expected candidate.
 */
export class CandidateIdentityMismatchError extends Error {
  public readonly expected: Partial<CandidateIdentity>;
  public readonly actual: Partial<CandidateIdentity>;
  public readonly check: string;

  constructor(
    check: string,
    expected: Partial<CandidateIdentity>,
    actual: Partial<CandidateIdentity>,
  ) {
    const msg = [
      `HARD FAIL: Candidate identity mismatch at "${check}".`,
      `Expected candidate_name="${expected.candidate_name}", got="${actual.candidate_name}".`,
      expected.inventory_hash
        ? `Expected inventory_hash="${expected.inventory_hash.substring(0, 12)}…", got="${(actual.inventory_hash || "none").substring(0, 12)}…".`
        : "",
      `Refusing to generate output for the wrong candidate.`,
    ]
      .filter(Boolean)
      .join(" ");
    super(msg);
    this.name = "CandidateIdentityMismatchError";
    this.expected = expected;
    this.actual = actual;
    this.check = check;
  }
}

// ── Core Types ──────────────────────────────────────────────────

export interface CandidateIdentity {
  /** Unique candidate identifier (from profile session, DB key, or derived from name) */
  candidate_id: string;
  /** The candidate's full name as it appears in the inventory profile */
  candidate_name: string;
  /** SHA-256 hash of the serialized inventory JSON (content-addressable) */
  inventory_hash: string;
  /** Where the inventory was loaded from: "db" | "filesystem" */
  inventory_source: "db" | "filesystem";
  /** Filesystem path to the inventory, if loaded from disk */
  inventory_path?: string;
  /** ISO 8601 timestamp when identity was resolved */
  resolved_at: string;
  /** Pipeline run ID for traceability */
  run_id?: string;
}

// ── Hash Computation ────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 hash of the inventory.
 * Uses sorted-key JSON serialization to avoid ordering issues.
 */
export function computeInventoryHash(inventory: Record<string, any>): string {
  // Recursive key-sorting replacer ensures deterministic serialization
  // regardless of key insertion order at any nesting depth.
  const serialized = JSON.stringify(inventory, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, any> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
  return crypto.createHash("sha256").update(serialized, "utf-8").digest("hex");
}

// ── Identity Resolution ─────────────────────────────────────────

/**
 * Derive a candidate_id from the inventory profile.
 * Uses a deterministic slug from the candidate's name.
 * If the inventory has an explicit id field, use that instead.
 */
export function deriveCandidateId(inventory: Record<string, any>): string {
  const profile = inventory?.profile;
  if (!profile) {
    throw new MissingBaselineError("unknown", [], "Inventory has no profile section");
  }

  // Use explicit candidate_id if present
  if (profile.candidate_id) return profile.candidate_id;

  // Derive from name
  const name = profile.name;
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new MissingBaselineError("unknown", [], "Inventory profile has no name");
  }

  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Resolve CandidateIdentity from a loaded inventory.
 * This is the ONLY sanctioned way to create a CandidateIdentity.
 */
export function resolveCandidateIdentity(
  inventory: Record<string, any>,
  source: "db" | "filesystem",
  inventoryPath?: string,
  runId?: string,
): CandidateIdentity {
  const candidateId = deriveCandidateId(inventory);
  const candidateName = inventory.profile.name;
  const inventoryHash = computeInventoryHash(inventory);

  return {
    candidate_id: candidateId,
    candidate_name: candidateName,
    inventory_hash: inventoryHash,
    inventory_source: source,
    inventory_path: inventoryPath,
    resolved_at: new Date().toISOString(),
    run_id: runId,
  };
}

// ── Output Validation Guards ────────────────────────────────────

/**
 * Normalize a name for comparison (case-insensitive, whitespace-normalized).
 */
function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Validate that the generated resume header matches the candidate.
 * Returns { valid, issues[] }.
 */
export function validateResumeIdentity(
  resume: any,
  identity: CandidateIdentity,
  ledgerEmployers: string[],
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check candidate name in resume header
  const resumeName = resume?.candidate_name || resume?.name || "";
  if (!resumeName) {
    issues.push("Resume has no candidate_name field");
  } else if (normalizeName(resumeName) !== normalizeName(identity.candidate_name)) {
    issues.push(
      `Resume name "${resumeName}" does not match candidate "${identity.candidate_name}"`,
    );
  }

  // Check employers are a subset of the claims ledger
  const ledgerSet = new Set(ledgerEmployers.map(e => e.toLowerCase().trim()));
  for (const exp of resume?.experience || []) {
    const employer = (exp.employer || "").toLowerCase().trim();
    if (employer && !ledgerSet.has(employer)) {
      issues.push(
        `Resume employer "${exp.employer}" not found in claims ledger`,
      );
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Validate that the cover letter signature matches the candidate.
 */
export function validateCoverLetterIdentity(
  coverLetter: any,
  identity: CandidateIdentity,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check sign_off or signature
  const signOff = coverLetter?.sign_off || coverLetter?.signature || "";
  if (signOff && !signOff.toLowerCase().includes(normalizeName(identity.candidate_name))) {
    issues.push(
      `Cover letter sign-off "${signOff}" does not contain candidate name "${identity.candidate_name}"`,
    );
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Assert that a ClaimsLedger's embedded identity matches the pipeline's CandidateIdentity.
 * Throws CandidateIdentityMismatchError on any mismatch.
 */
export function assertLedgerIdentity(
  ledgerIdentity: { candidate_id?: string; candidate_name?: string; inventory_hash?: string },
  pipelineIdentity: CandidateIdentity,
): void {
  if (ledgerIdentity.candidate_id && ledgerIdentity.candidate_id !== pipelineIdentity.candidate_id) {
    throw new CandidateIdentityMismatchError(
      "claims_ledger.candidate_id",
      pipelineIdentity,
      { candidate_id: ledgerIdentity.candidate_id, candidate_name: ledgerIdentity.candidate_name } as any,
    );
  }
  if (
    ledgerIdentity.candidate_name &&
    normalizeName(ledgerIdentity.candidate_name) !== normalizeName(pipelineIdentity.candidate_name)
  ) {
    throw new CandidateIdentityMismatchError(
      "claims_ledger.candidate_name",
      pipelineIdentity,
      { candidate_name: ledgerIdentity.candidate_name } as any,
    );
  }
  if (
    ledgerIdentity.inventory_hash &&
    ledgerIdentity.inventory_hash !== pipelineIdentity.inventory_hash
  ) {
    throw new CandidateIdentityMismatchError(
      "claims_ledger.inventory_hash",
      pipelineIdentity,
      { inventory_hash: ledgerIdentity.inventory_hash } as any,
    );
  }
}
