/**
 * Stage 5: Differentiation Gate
 *
 * Compares a newly generated resume against prior resumes stored in
 * the resume_history table. If similarity is too high, returns a
 * divergence prompt that forces Stage 4 to rewrite.
 *
 * Type: DETERMINISTIC (no LLM calls)
 */

import {
  ensureResumeHistoryTable,
  checkDivergenceAgainstHistory,
  storeResumeSnapshot,
  type DivergenceResult,
} from "../../mastra/tools/resumeDivergenceEnforcer";
import type { TailoredResume } from "../../mastra/tools/tailoredResumePrompt";
import type { MandateProfile } from "../stage2-mandate-classifier/classifier";

export interface DifferentiationInput {
  resume: TailoredResume;
  jobId: number;
  mandate: MandateProfile;
  /** When provided, prioritizes comparison against same-mandate resumes (with fallback to all recent) */
  mandateCluster?: string;
}

export interface DifferentiationResult {
  needs_rewrite: boolean;
  divergence: DivergenceResult;
  divergence_prompt: string;
  duration_ms: number;
}

/**
 * Initialize the divergence tracking table. Call once at pipeline start.
 */
export async function initDivergenceTracking(): Promise<void> {
  await ensureResumeHistoryTable();
}

/**
 * Check if a resume is sufficiently different from recent prior resumes.
 * If not, returns a divergence prompt to inject into the rewrite stage.
 */
export async function checkDifferentiation(input: DifferentiationInput): Promise<DifferentiationResult> {
  const start = Date.now();

  const divergence = await checkDivergenceAgainstHistory(
    input.resume,
    input.jobId,
    input.mandate,
  );

  return {
    needs_rewrite: divergence.needs_rewrite,
    divergence,
    divergence_prompt: divergence.divergence_prompt,
    duration_ms: Date.now() - start,
  };
}

/**
 * Store a resume snapshot for future divergence checks.
 * Called after a resume passes all verification stages.
 */
export async function storeDivergenceSnapshot(
  resume: TailoredResume,
  jobId: number,
  primaryMandate: string,
  candidateId?: string,
): Promise<void> {
  await storeResumeSnapshot(resume, jobId, primaryMandate, candidateId);
}
