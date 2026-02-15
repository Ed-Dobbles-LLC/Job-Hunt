/**
 * Resume Tailoring Engine — Pipeline Router
 *
 * Routes to v1 (legacy) or v2 (consolidated) pipeline based on
 * the PIPELINE_ARCH environment variable:
 *
 *   PIPELINE_ARCH=v1  → Legacy pipeline (default)
 *   PIPELINE_ARCH=v2  → v2 pipeline with:
 *                        - Budget enforcement (LLM caps, cost ceiling, repair limits)
 *                        - Consolidated Post-Processing Controller
 *                        - Detection-only QA passes (no text mutation)
 *                        - Stage contracts
 *                        - Mandate-scoped differentiation
 *                        - No Stage 8 repair loops
 *
 * Both implementations export PipelineInput and return PipelineResult.
 * The v2 PipelineInput extends v1 with an optional `budget` field.
 */

import type { PipelineResult } from "./types";
import type { BudgetConfig } from "./pipeline-budget";

// Re-export the v1 PipelineInput (superset compatible)
export { type PipelineInput as PipelineInputV1 } from "./pipeline-v1";

// ── Pipeline Input (unified) ─────────────────────────────────────

export interface PipelineInput {
  job_id: number;
  company?: string;
  title?: string;
  requirements?: Record<string, any>;
  company_context?: string;
  max_attempts?: number;
  run_id?: string;
  embedding_config?: { model?: string; dimensions?: number };
  /** v2 only: Budget overrides */
  budget?: Partial<BudgetConfig>;
  /** Dry-run mode: validate stage ordering and contracts without LLM calls */
  dry_run?: boolean;
  logger?: any;
}

// ── Feature Flag ─────────────────────────────────────────────────

export type PipelineArch = "v1" | "v2";

export function getPipelineArch(): PipelineArch {
  const arch = process.env.PIPELINE_ARCH?.toLowerCase();
  if (arch === "v2") return "v2";
  return "v1"; // default
}

// ── Main Entry Point ─────────────────────────────────────────────

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const arch = getPipelineArch();
  const logger = input.logger;

  if (input.dry_run) {
    logger?.info(`🧪 [Pipeline] DRY RUN mode — validating stage ordering and contracts`);
    const { runPipelineDryRun } = await import("./pipeline-dry-run");
    return runPipelineDryRun(input);
  }

  if (arch === "v2") {
    logger?.info(`🚀 [Pipeline] Using v2 (consolidated) architecture`);
    const { runPipelineV2 } = await import("./pipeline-v2");
    return runPipelineV2(input);
  }

  logger?.info(`🚀 [Pipeline] Using v1 (legacy) architecture`);
  const { runPipelineV1 } = await import("./pipeline-v1");
  return runPipelineV1(input);
}
