/**
 * Resume Tailoring Engine — Pipeline Orchestrator
 *
 * Runs the 7-stage pipeline in sequence with retry logic:
 *
 * Stage 1: Claims Ledger Extraction (DETERMINISTIC)
 * Stage 2: Mandate Classification (DETERMINISTIC + optional LLM)
 * Stage 3: Bullet Scoring & Reordering (DETERMINISTIC + optional embedding)
 * Stage 4: Constrained Rewrite (LLM)
 * Stage 5: Differentiation Gate (DETERMINISTIC)
 * Stage 6: Layout Governor (DETERMINISTIC)
 * Stage 7: Truth Audit (DETERMINISTIC)
 *
 * Retry budget: Stage 4→5→6→7 loop max 3 attempts.
 * After 3 failures: return best attempt + violation report.
 */

import { query } from "../mastra/tools/db";
import { buildEntityAllowlist } from "../mastra/tools/entityAllowlist";
import { extractClaimsLedger } from "../mastra/tools/claimsLedger";
import { workspacePath } from "../mastra/tools/paths";
import * as fs from "fs";
import type { TailoredResume } from "../mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../mastra/tools/tailoredCoverLetterPrompt";
import type { VerifierReport } from "../mastra/tools/truthfulnessVerifier";
import type { JDRequirements } from "../mastra/tools/extractJDRequirementsTool";

// Stage imports
import { extractClaimsFromInventory } from "./stage1-claims-ledger/extractor";
import { classifyJobMandate } from "./stage2-mandate-classifier/classifier";
import { scoreBullets } from "./stage3-bullet-scoring/scorer";
import { constrainedRewrite } from "./stage4-constrained-rewrite/rewriter";
import { initDivergenceTracking, checkDifferentiation, storeDivergenceSnapshot } from "./stage5-differentiation/gate";
import { governLayout } from "./stage6-layout-governor/governor";
import { runTruthAudit, detectOwnershipInflation } from "./stage7-truth-audit/auditor";
import { renderPlaintext } from "./output/plaintext-renderer";
import { buildClarificationQuestions } from "./output/clarification-builder";

import type {
  PipelineResult,
  AttemptRecord,
  StageResult,
  ClarificationQuestion,
  OwnershipInflationWarning,
  EmbeddingConfig,
  ScoredBulletPlan,
} from "./types";

// ── Config ───────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 3;

// ── Inventory Loader ─────────────────────────────────────────────

async function loadInventory(): Promise<Record<string, any>> {
  try {
    const dbResult = await query("SELECT value FROM app_settings WHERE key = 'experience_inventory'");
    if (dbResult.rows.length > 0 && dbResult.rows[0].value) {
      return JSON.parse(dbResult.rows[0].value);
    }
  } catch { /* fall through */ }

  try {
    const inventoryPath = workspacePath("experience_inventory.json");
    return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  } catch (err: any) {
    throw new Error(`Cannot load experience_inventory.json: ${err.message}`);
  }
}

// ── Stage Runner ─────────────────────────────────────────────────

async function runStage<T>(
  name: string,
  fn: () => T | Promise<T>,
  logger?: any,
): Promise<StageResult<T>> {
  const start = Date.now();
  logger?.info(`▶ [Pipeline] ${name} starting...`);

  try {
    const data = await fn();
    const duration = Date.now() - start;
    logger?.info(`✅ [Pipeline] ${name} completed in ${duration}ms`);
    return { stage: name, success: true, data, duration_ms: duration };
  } catch (err: any) {
    const duration = Date.now() - start;
    logger?.error(`❌ [Pipeline] ${name} failed after ${duration}ms: ${err.message}`);
    return { stage: name, success: false, data: null as any, duration_ms: duration, errors: [err.message] };
  }
}

// ── Pipeline Input ───────────────────────────────────────────────

export interface PipelineInput {
  job_id: number;
  company?: string;
  title?: string;
  requirements?: Record<string, any>;
  company_context?: string;
  max_attempts?: number;
  embedding_config?: EmbeddingConfig;
  logger?: any;
}

// ── Main Pipeline ────────────────────────────────────────────────

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const logger = input.logger;
  const maxAttempts = input.max_attempts || DEFAULT_MAX_ATTEMPTS;
  const stageResults: Record<string, StageResult<any>> = {};

  logger?.info(`\n${"═".repeat(60)}`);
  logger?.info(`🚀 [Pipeline] Starting 7-stage resume tailoring pipeline`);
  logger?.info(`🚀 [Pipeline] Job ID: ${input.job_id}, Max attempts: ${maxAttempts}`);
  logger?.info(`${"═".repeat(60)}\n`);

  // ── Load job data ──────────────────────────────────────────────

  let company = input.company || "";
  let title = input.title || "";
  let requirements: JDRequirements;
  let jdText = "";

  if (input.requirements) {
    requirements = input.requirements as JDRequirements;
  } else {
    const result = await query(
      "SELECT company, title, jd_requirements, jd_raw_text FROM jobs WHERE job_id = $1",
      [input.job_id],
    );
    if (result.rows.length === 0) throw new Error(`Job ID ${input.job_id} not found`);
    if (!result.rows[0].jd_requirements) throw new Error(`Job ID ${input.job_id} has no extracted requirements`);
    company = company || result.rows[0].company || "";
    title = title || result.rows[0].title || "";
    requirements = result.rows[0].jd_requirements;
    jdText = result.rows[0].jd_raw_text || "";
  }

  if (!jdText) {
    try {
      const jdResult = await query("SELECT jd_raw_text FROM jobs WHERE job_id = $1", [input.job_id]);
      jdText = jdResult.rows[0]?.jd_raw_text || "";
    } catch { /* non-fatal */ }
  }

  // ── Load inventory ─────────────────────────────────────────────

  const inventory = await loadInventory();
  const allowlist = buildEntityAllowlist(inventory);

  // ── STAGE 1: Claims Ledger Extraction ──────────────────────────

  const stage1 = await runStage("Stage 1: Claims Ledger", () => {
    return extractClaimsFromInventory(inventory);
  }, logger);
  stageResults["stage1"] = stage1;
  if (!stage1.success) throw new Error("Stage 1 failed: " + stage1.errors?.join(", "));

  const ledger = stage1.data;
  logger?.info(`📋 [Pipeline] Claims ledger: ${ledger.total_claims} claims`);

  // ── STAGE 2: Mandate Classification ────────────────────────────

  const stage2 = await runStage("Stage 2: Mandate Classification", () => {
    return classifyJobMandate({ jdText, title, requirements: requirements as any });
  }, logger);
  stageResults["stage2"] = stage2;
  if (!stage2.success) throw new Error("Stage 2 failed: " + stage2.errors?.join(", "));

  const { mandate } = stage2.data;
  logger?.info(`🎯 [Pipeline] Mandate: primary=${mandate.primary_mandate}, seniority=${mandate.seniority_level}`);

  // ── STAGE 3: Bullet Scoring ────────────────────────────────────

  const stage3 = await runStage("Stage 3: Bullet Scoring", () => {
    return scoreBullets(
      inventory,
      mandate,
      ledger,
      requirements as any,
      input.embedding_config,
    );
  }, logger);
  stageResults["stage3"] = stage3;
  if (!stage3.success) throw new Error("Stage 3 failed: " + stage3.errors?.join(", "));

  const bulletPlan: ScoredBulletPlan = stage3.data;
  logger?.info(`🎯 [Pipeline] Scored ${bulletPlan.scored_bullets.length} bullets, ${bulletPlan.mandate_gaps.length} gaps`);

  // ── Initialize divergence tracking ─────────────────────────────

  await initDivergenceTracking();

  // ── STAGES 4→5→6→7 LOOP ───────────────────────────────────────

  let currentResume: TailoredResume | null = null;
  let currentCoverLetter: TailoredCoverLetter | null = null;
  let currentReport: VerifierReport | null = null;
  let ownershipWarnings: OwnershipInflationWarning[] = [];
  const attemptHistory: AttemptRecord[] = [];
  let bestAttemptIndex = 0;
  let bestCriticalCount = Infinity;
  let bestResume: TailoredResume | null = null;
  let bestCoverLetter: TailoredCoverLetter | null = null;
  let bestReport: VerifierReport | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger?.info(`\n${"─".repeat(50)}`);
    logger?.info(`🔄 [Pipeline] === ATTEMPT ${attempt}/${maxAttempts} ===`);
    logger?.info(`${"─".repeat(50)}`);

    try {
      // ── STAGE 4: Constrained Rewrite ─────────────────────────────

      const stage4 = await runStage(`Stage 4: Rewrite (attempt ${attempt})`, async () => {
        const correctionContext = (attempt > 1 && currentReport && currentResume && currentCoverLetter)
          ? { previousResume: currentResume, previousCoverLetter: currentCoverLetter, report: currentReport, attemptNumber: attempt }
          : undefined;

        return constrainedRewrite({
          inventory,
          allowlist,
          requirements,
          title,
          company,
          mandate,
          bulletPlan,
          companyContext: input.company_context,
          correctionContext,
        });
      }, logger);

      if (!stage4.success) {
        attemptHistory.push({
          attempt, pass: false, critical_violations: -1, warnings: -1,
          total_checks: 0, violation_types: ["ERROR"], timestamp: new Date().toISOString(),
        });
        if (attempt >= maxAttempts && !bestResume) throw new Error("Stage 4 failed: " + stage4.errors?.join(", "));
        continue;
      }

      stageResults[`stage4_attempt${attempt}`] = stage4;
      currentResume = stage4.data.resume;
      currentCoverLetter = stage4.data.coverLetter;

      // ── STAGE 5: Differentiation Gate ──────────────────────────────

      const stage5 = await runStage(`Stage 5: Differentiation (attempt ${attempt})`, async () => {
        return checkDifferentiation({ resume: currentResume!, jobId: input.job_id, mandate });
      }, logger);

      stageResults[`stage5_attempt${attempt}`] = stage5;

      if (stage5.success && stage5.data.needs_rewrite && attempt === 1) {
        // On first attempt, rewrite with divergence prompt
        logger?.warn(`⚠️ [Pipeline] Divergence check failed — rewriting with divergence prompt`);
        const rewrite = await runStage("Stage 4: Divergence Rewrite", async () => {
          return constrainedRewrite({
            inventory, allowlist, requirements, title, company, mandate, bulletPlan,
            companyContext: input.company_context,
            divergencePrompt: stage5.data.divergence_prompt,
          });
        }, logger);

        if (rewrite.success) {
          currentResume = rewrite.data.resume;
          currentCoverLetter = rewrite.data.coverLetter;
        }
      }

      // ── STAGE 6: Layout Governor ───────────────────────────────────

      const stage6 = await runStage(`Stage 6: Layout Governor (attempt ${attempt})`, () => {
        return governLayout(currentResume!, mandate);
      }, logger);

      stageResults[`stage6_attempt${attempt}`] = stage6;
      if (stage6.success) {
        currentResume = stage6.data.resume;
        logger?.info(`📐 [Pipeline] Layout: caps=${stage6.data.bullet_cap_result.capped}, chrono=${stage6.data.chronology_reordered}, filler=${stage6.data.filler_removals.length}`);
      }

      // ── STAGE 7: Truth Audit ───────────────────────────────────────

      const stage7 = await runStage(`Stage 7: Truth Audit (attempt ${attempt})`, () => {
        return runTruthAudit(currentResume!, currentCoverLetter!, allowlist, inventory);
      }, logger);

      stageResults[`stage7_attempt${attempt}`] = stage7;

      if (stage7.success) {
        currentReport = stage7.data.report;
        ownershipWarnings = stage7.data.ownershipWarnings;
      } else {
        // If truth audit itself crashed, still track the attempt
        currentReport = null;
      }

      // ── Record attempt ─────────────────────────────────────────────

      const criticalCount = currentReport?.stats.critical_violations ?? -1;
      const warningCount = currentReport?.stats.warnings ?? -1;

      attemptHistory.push({
        attempt,
        pass: currentReport?.pass ?? false,
        critical_violations: criticalCount,
        warnings: warningCount,
        total_checks: currentReport?.stats.total_checks ?? 0,
        violation_types: [...new Set((currentReport?.violations ?? []).map(v => v.type))],
        timestamp: new Date().toISOString(),
      });

      // Track best attempt
      if (criticalCount >= 0 && criticalCount < bestCriticalCount) {
        bestCriticalCount = criticalCount;
        bestAttemptIndex = attempt;
        bestResume = { ...currentResume! };
        bestCoverLetter = { ...currentCoverLetter! };
        bestReport = currentReport ? { ...currentReport } : null;
      }

      logger?.info(`🔍 [Pipeline] Attempt ${attempt}: ${currentReport?.pass ? "PASS ✅" : `FAIL ❌ (${criticalCount} critical)`}`);

      if (currentReport?.pass) {
        logger?.info(`🎉 [Pipeline] VERIFICATION PASSED on attempt ${attempt}!`);
        break;
      }

    } catch (err: any) {
      logger?.error(`💥 [Pipeline] Attempt ${attempt} error: ${err.message}`);
      attemptHistory.push({
        attempt, pass: false, critical_violations: -1, warnings: -1,
        total_checks: 0, violation_types: ["ERROR"], timestamp: new Date().toISOString(),
      });

      if (attempt >= maxAttempts && !bestResume) {
        throw new Error(`All ${maxAttempts} attempts failed. Last: ${err.message}`);
      }
    }
  }

  // ── Finalize ───────────────────────────────────────────────────

  const finalResume = currentReport?.pass ? currentResume! : bestResume || currentResume!;
  const finalCoverLetter = currentReport?.pass ? currentCoverLetter! : bestCoverLetter || currentCoverLetter!;
  const finalReport = currentReport?.pass ? currentReport : bestReport || currentReport!;
  const passed = finalReport?.pass ?? false;

  // ── Plaintext ATS render ───────────────────────────────────────

  let plaintextResume: string | undefined;
  try {
    const candidateName = inventory?.profile?.name;
    plaintextResume = renderPlaintext(finalResume, candidateName);
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline] Plaintext render failed: ${err.message}`);
  }

  // ── Build clarification questions ──────────────────────────────

  let clarificationQuestions: ClarificationQuestion[] = [];
  try {
    clarificationQuestions = buildClarificationQuestions(
      finalResume.gap_notes || [],
      bulletPlan.mandate_gaps,
      requirements as any,
    );
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline] Clarification questions failed: ${err.message}`);
  }

  // ── Store resume snapshot for future divergence checks ─────────

  try {
    await storeDivergenceSnapshot(finalResume, input.job_id, mandate.primary_mandate);
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline] Failed to store resume snapshot: ${err.message}`);
  }

  // ── Save metadata to DB ────────────────────────────────────────

  try {
    await query(
      `UPDATE scores SET breakdown_json = jsonb_set(
         COALESCE(breakdown_json, '{}'::jsonb),
         '{verified_packet}',
         $2::jsonb
       ) WHERE job_id = $1`,
      [input.job_id, JSON.stringify({
        generated_at: new Date().toISOString(),
        pass: passed,
        attempts_used: attemptHistory.length,
        max_attempts: maxAttempts,
        best_attempt: bestAttemptIndex,
        pipeline_version: "7-stage-v1",
        stages_run: Object.keys(stageResults),
      })],
    );
  } catch { /* non-fatal */ }

  // ── Build human review notes ───────────────────────────────────

  const humanReviewNotes: string[] = [];
  if (!passed) {
    humanReviewNotes.push(
      `Automated verification failed after ${attemptHistory.length} attempts.`,
      `Best attempt: #${bestAttemptIndex} with ${bestCriticalCount} critical violation(s).`,
    );
    const remaining = finalReport?.violations?.filter(v => v.severity === "critical") ?? [];
    for (const v of remaining) {
      humanReviewNotes.push(`[${v.type}] ${v.location}: ${v.explanation}`);
    }
  }

  if (ownershipWarnings.length > 0) {
    humanReviewNotes.push(`${ownershipWarnings.length} ownership inflation warning(s) detected.`);
    for (const w of ownershipWarnings) {
      humanReviewNotes.push(`[OWNERSHIP] ${w.location}: ${w.explanation}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────

  logger?.info(`\n${"═".repeat(60)}`);
  logger?.info(`📊 [Pipeline] === FINAL SUMMARY ===`);
  logger?.info(`📊 [Pipeline] Job: ${company} — ${title}`);
  logger?.info(`📊 [Pipeline] Pass: ${passed}`);
  logger?.info(`📊 [Pipeline] Attempts: ${attemptHistory.length}/${maxAttempts}`);
  logger?.info(`📊 [Pipeline] Clarification questions: ${clarificationQuestions.length}`);
  logger?.info(`📊 [Pipeline] Ownership warnings: ${ownershipWarnings.length}`);
  logger?.info(`📊 [Pipeline] Plaintext rendered: ${!!plaintextResume}`);
  logger?.info(`${"═".repeat(60)}\n`);

  return {
    success: true,
    job_id: input.job_id,
    pass: passed,
    attempts_used: attemptHistory.length,
    max_attempts: maxAttempts,
    resume: finalResume,
    cover_letter: finalCoverLetter,
    plaintext_resume: plaintextResume,
    clarification_questions: clarificationQuestions,
    ownership_warnings: ownershipWarnings,
    final_report: finalReport,
    attempt_history: attemptHistory,
    human_review_required: !passed,
    human_review_notes: humanReviewNotes,
    stage_results: stageResults,
  };
}
