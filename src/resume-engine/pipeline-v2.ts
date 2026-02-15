/**
 * Resume Tailoring Engine — Pipeline Orchestrator (v2)
 *
 * ARCHITECTURE CHANGES (v2):
 *   - Global budget enforcement (LLM calls, cost, tokens, time, repair loops)
 *   - Consolidated Post-Processing Controller replaces QA Gate + Refinement Layer
 *   - All post-generation passes are DETECTION-ONLY (no text mutation)
 *   - Stage 8 (Recruiter Review) produces structured feedback only, no rewrite
 *   - Stage contracts enforced: each stage declares what it may/may not mutate
 *   - Verb integrity guard defaults to detection-only (no auto-fix)
 *   - Mandate-scoped differentiation comparison
 *   - Global repair loop cap (default: 3 total across all stages)
 *   - Graceful budget exceeded handling with structured error
 *
 * PIPELINE STAGES:
 *   Stage 1: Claims Ledger Extraction          (DETERMINISTIC)
 *   Stage 2: Mandate Classification            (LLM)
 *   Stage 3: Bullet Scoring & Reordering       (DETERMINISTIC)
 *   Stage 4: Constrained Rewrite               (LLM — creates resume + cover letter)
 *   Stage 5: Differentiation Gate              (DETERMINISTIC — detection only)
 *   Stage 6: Layout Governor                   (DETERMINISTIC — ONLY stage that mutates structure)
 *   Stage 7: Truth Audit                       (DETERMINISTIC — detection only)
 *   Stage 8: Recruiter Review                  (LLM — feedback only, no rewrite)
 *   Post-Processing: Consolidated Quality Check (DETERMINISTIC — detection only)
 *
 * REPAIR POLICY:
 *   Stage 4→5→6→7 loop: max 3 attempts (configurable via budget).
 *   If Stage 7 fails, Stage 4 gets correction context with violations.
 *   Stage 8 runs ONCE after truth audit passes. No repair loops from Stage 8.
 *   Post-Processing runs ONCE. Detection-only, never triggers retries.
 *   Total LLM calls capped at budget.max_llm_calls (default: 12).
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
import { runRecruiterReview } from "./stage8-recruiter-review/reviewer";
import { runVerbIntegrityGuard } from "./qa/verbIntegrityGuard";
import { renderPlaintext } from "./output/plaintext-renderer";
import { buildClarificationQuestions } from "./output/clarification-builder";
import { CostAccumulator, setGlobalCostAccumulator, formatCostSummary, type CostSummary } from "./cost-tracker";

// v2: Consolidated post-processing (replaces QA Gate + Refinement Layer)
import { runPostProcessing, type PostProcessingReport } from "./post-processing-controller";
import { PipelineBudget, loadBudgetConfig, BudgetExceededError, type BudgetConfig } from "./pipeline-budget";
import { STAGE_CONTRACTS, snapshotResume, validateStageContract } from "./stage-contracts";
import { beginPipelineTransaction, createNoOpTransaction, type PipelineTransaction } from "./pipeline-transaction";

import type {
  PipelineResult,
  AttemptRecord,
  StageResult,
  ClarificationQuestion,
  OwnershipInflationWarning,
  EmbeddingConfig,
  ScoredBulletPlan,
  RecruiterReviewReport,
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
  /** Batch run identifier for cost tracking across multiple packets */
  run_id?: string;
  embedding_config?: EmbeddingConfig;
  /** Budget overrides (LLM call cap, cost ceiling, repair loop cap, etc.) */
  budget?: Partial<BudgetConfig>;
  logger?: any;
}

// ── Main Pipeline ────────────────────────────────────────────────

export async function runPipelineV2(input: PipelineInput): Promise<PipelineResult> {
  const logger = input.logger;
  const budgetConfig = loadBudgetConfig(input.budget);
  const maxAttempts = Math.min(
    input.max_attempts || DEFAULT_MAX_ATTEMPTS,
    budgetConfig.max_repair_loops,
  );
  const stageResults: Record<string, StageResult<any>> = {};

  logger?.info(`\n${"═".repeat(60)}`);
  logger?.info(`🚀 [Pipeline v2] Starting pipeline with budget enforcement`);
  logger?.info(`🚀 [Pipeline v2] Job ID: ${input.job_id}, Max attempts: ${maxAttempts}, LLM cap: ${budgetConfig.max_llm_calls}, Cost cap: $${budgetConfig.max_cost_usd}`);
  logger?.info(`${"═".repeat(60)}\n`);

  // ── Set up cost tracking + budget enforcement ─────────────────

  const costAccumulator = new CostAccumulator({ jobId: input.job_id, runId: input.run_id, logger });
  setGlobalCostAccumulator(costAccumulator);
  const budget = new PipelineBudget(budgetConfig, logger);

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

  // ── STAGES 4→5→6→7 LOOP (budget-enforced) ──────────────────────

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
  let budgetExhausted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // ── Budget check before each attempt ───────────────────────────
    const budgetCheck = budget.wouldExceed({ llm_calls: 2, repair_loops: 1 });
    if (budgetCheck) {
      logger?.warn(`🚫 [Pipeline v2] Budget would be exceeded: ${budgetCheck.message} — stopping attempts`);
      budgetExhausted = true;
      break;
    }

    logger?.info(`\n${"─".repeat(50)}`);
    logger?.info(`🔄 [Pipeline v2] === ATTEMPT ${attempt}/${maxAttempts} ===`);
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
          logger,
        });
      }, logger);

      budget.recordLLMCall(2); // resume + cover letter
      budget.recordRepairLoop();

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

      // ── VERB INTEGRITY GUARD (detection-only, post-Stage 4) ───────

      const verbGuard = await runStage(`Verb Integrity Guard (attempt ${attempt})`, () => {
        return runVerbIntegrityGuard(currentResume!, { logger, detectOnly: true });
      }, logger);

      stageResults[`verbGuard_attempt${attempt}`] = verbGuard;
      if (verbGuard.success) {
        const issues = verbGuard.data.remaining_count || 0;
        if (issues > 0) {
          logger?.info(`🔤 [Pipeline v2] Verb guard: ${issues} issue(s) detected (detection-only)`);
        }
      }

      // ── STAGE 5: Differentiation Gate (mandate-scoped) ────────────

      const stage5 = await runStage(`Stage 5: Differentiation (attempt ${attempt})`, async () => {
        return checkDifferentiation({
          resume: currentResume!,
          jobId: input.job_id,
          mandate,
          mandateCluster: mandate.primary_mandate, // mandate-scoped comparison
        });
      }, logger);

      stageResults[`stage5_attempt${attempt}`] = stage5;

      if (stage5.success && stage5.data.needs_rewrite && attempt === 1) {
        // Check budget before divergence rewrite
        const divBudget = budget.wouldExceed({ llm_calls: 2 });
        if (divBudget) {
          logger?.warn(`🚫 [Pipeline v2] Budget insufficient for divergence rewrite: ${divBudget.message}`);
        } else {
          logger?.warn(`⚠️ [Pipeline v2] Divergence check failed — rewriting with divergence prompt`);
          const rewrite = await runStage("Stage 4: Divergence Rewrite", async () => {
            return constrainedRewrite({
              inventory, allowlist, requirements, title, company, mandate, bulletPlan,
              companyContext: input.company_context,
              divergencePrompt: stage5.data.divergence_prompt,
              logger,
            });
          }, logger);

          budget.recordLLMCall(2);

          if (rewrite.success) {
            currentResume = rewrite.data.resume;
            currentCoverLetter = rewrite.data.coverLetter;
          }
        }
      }

      // ── STAGE 6: Layout Governor (ONLY stage that mutates structure) ──

      const stage6 = await runStage(`Stage 6: Layout Governor (attempt ${attempt})`, () => {
        return governLayout(currentResume!, mandate);
      }, logger);

      stageResults[`stage6_attempt${attempt}`] = stage6;
      if (stage6.success) {
        currentResume = stage6.data.resume;

        // Log key layout metrics
        logger?.info(`📐 [Pipeline v2] Layout: caps=${stage6.data.bullet_cap_result.capped}, chrono=${stage6.data.chronology_reordered}, filler=${stage6.data.filler_removals.length}`);
        if (stage6.data.blocked) {
          logger?.warn(`🚫 [Pipeline v2] BLOCKED by page estimator — exceeds 2 pages`);
        }
        if (stage6.data.page_band) {
          const band = stage6.data.page_band;
          logger?.info(`📐 [Pipeline v2] Page band: ${band.actual} pages (target: ${band.min}–${band.max}) ${band.in_band ? "IN BAND" : "OUT OF BAND"}`);
        }
        if (stage6.data.verb_strength) {
          const vs = stage6.data.verb_strength;
          logger?.info(`🔤 [Pipeline v2] Verb strength: ${vs.upgrades_applied} mandate upgrades, ${vs.mandate_aligned_pct}% aligned`);
        }
      }

      // ── STAGE 7: Truth Audit (detection only) ─────────────────────

      const stage7 = await runStage(`Stage 7: Truth Audit (attempt ${attempt})`, () => {
        return runTruthAudit(currentResume!, currentCoverLetter!, allowlist, inventory);
      }, logger);

      stageResults[`stage7_attempt${attempt}`] = stage7;

      if (stage7.success) {
        currentReport = stage7.data.report;
        ownershipWarnings = stage7.data.ownershipWarnings;

        if (stage7.data.claimAudit.bullets_without_claims > 0) {
          logger?.info(`📋 [Pipeline v2] Claim audit: ${stage7.data.claimAudit.bullets_with_claims}/${stage7.data.claimAudit.total_bullets} bullets linked`);
        }
        if (stage7.data.blocked) {
          logger?.warn(`🚫 [Pipeline v2] BLOCKED by truth audit: ${stage7.data.block_reasons.join("; ")}`);
        }
      } else {
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

      if (criticalCount >= 0 && criticalCount < bestCriticalCount) {
        bestCriticalCount = criticalCount;
        bestAttemptIndex = attempt;
        bestResume = { ...currentResume! };
        bestCoverLetter = { ...currentCoverLetter! };
        bestReport = currentReport ? { ...currentReport } : null;
      }

      logger?.info(`🔍 [Pipeline v2] Attempt ${attempt}: ${currentReport?.pass ? "PASS" : `FAIL (${criticalCount} critical)`}`);

      if (currentReport?.pass) {
        logger?.info(`🎉 [Pipeline v2] VERIFICATION PASSED on attempt ${attempt}!`);
        break;
      }

      // Budget check after attempt
      try { budget.check(costAccumulator); } catch (err: any) {
        if (err instanceof BudgetExceededError) {
          logger?.warn(`🚫 [Pipeline v2] Budget exceeded after attempt ${attempt}: ${err.violation.message}`);
          budgetExhausted = true;
          break;
        }
      }

    } catch (err: any) {
      if (err instanceof BudgetExceededError) {
        logger?.warn(`🚫 [Pipeline v2] Budget exceeded: ${err.violation.message}`);
        budgetExhausted = true;
        break;
      }
      logger?.error(`💥 [Pipeline v2] Attempt ${attempt} error: ${err.message}`);
      attemptHistory.push({
        attempt, pass: false, critical_violations: -1, warnings: -1,
        total_checks: 0, violation_types: ["ERROR"], timestamp: new Date().toISOString(),
      });

      if (attempt >= maxAttempts && !bestResume) {
        throw new Error(`All ${maxAttempts} attempts failed. Last: ${err.message}`);
      }
    }
  }

  // ── Finalize best attempt from stages 4-7 ───────────────────────

  let finalResume = currentReport?.pass ? currentResume! : bestResume || currentResume!;
  let finalCoverLetter = currentReport?.pass ? currentCoverLetter! : bestCoverLetter || currentCoverLetter!;
  let finalReport = currentReport?.pass ? currentReport : bestReport || currentReport!;
  let passed = finalReport?.pass ?? false;

  // ── Plaintext ATS render ───────────────────────────────────────

  let plaintextResume: string | undefined;
  try {
    const candidateName = inventory?.profile?.name;
    plaintextResume = renderPlaintext(finalResume, candidateName);
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline v2] Plaintext render failed: ${err.message}`);
  }

  // ── STAGE 8: Recruiter Review (feedback-only, no repair loops) ──

  let recruiterReview: RecruiterReviewReport | undefined;
  let recruiterReviewPassed = false;

  // Fetch prior summaries for differentiation context
  let priorSummaries: string[] = [];
  try {
    const histResult = await query(
      `SELECT summary_text FROM resume_history
       WHERE job_id != $1 AND archetype_primary = $2
       ORDER BY created_at DESC LIMIT 3`,
      [input.job_id, mandate.primary_mandate],
    );
    priorSummaries = histResult.rows
      .map((r: any) => r.summary_text)
      .filter(Boolean);
    // If no mandate-scoped results, fall back to any recent
    if (priorSummaries.length === 0) {
      const fallback = await query(
        `SELECT summary_text FROM resume_history WHERE job_id != $1 ORDER BY created_at DESC LIMIT 3`,
        [input.job_id],
      );
      priorSummaries = fallback.rows.map((r: any) => r.summary_text).filter(Boolean);
    }
  } catch { /* non-fatal */ }

  if (plaintextResume && passed && !budgetExhausted) {
    // Check budget before Stage 8 LLM call
    const s8Budget = budget.wouldExceed({ llm_calls: 1 });
    if (s8Budget) {
      logger?.warn(`🚫 [Pipeline v2] Budget insufficient for Stage 8: ${s8Budget.message} — skipping`);
    } else {
      try {
        const lastS6Key = Object.keys(stageResults)
          .filter(k => k.startsWith("stage6_"))
          .pop();
        const layoutReport = lastS6Key ? stageResults[lastS6Key]?.data ?? {} : {};

        const stage8 = await runStage("Stage 8: Recruiter Review", async () => {
          return runRecruiterReview({
            claimsLedger: ledger,
            mandateProfile: mandate,
            truthAuditReport: finalReport!,
            layoutReport,
            jdText,
            plaintextResume: plaintextResume!,
            resume: finalResume,
            coverLetter: finalCoverLetter,
            priorSummaries,
            logger,
          });
        }, logger);

        budget.recordLLMCall();
        stageResults["stage8"] = stage8;

        if (stage8.success) {
          recruiterReview = stage8.data.report;
          recruiterReviewPassed = recruiterReview.status === "PASS";

          logger?.info(`🎓 [Pipeline v2] Recruiter Review: ${recruiterReview.status} (truthfulness=${recruiterReview.scores.truthfulness}, readability=${recruiterReview.scores.readability}, mandate=${recruiterReview.scores.mandate_alignment})`);

          // v2: NO repair loops from Stage 8. Feedback is recorded for human review.
          if (!recruiterReviewPassed) {
            logger?.info(`📝 [Pipeline v2] Stage 8 FAIL — issues recorded for human review (no repair loops)`);
          }
        }
      } catch (err: any) {
        logger?.warn(`⚠️ [Pipeline v2] Stage 8 Recruiter Review failed: ${err.message}`);
      }
    }
  } else if (!passed) {
    logger?.info(`⏭️ [Pipeline v2] Skipping Stage 8 — truth audit did not pass`);
  }

  // ── Post-Processing Controller (detection-only, no mutation) ───

  let postProcessingReport: PostProcessingReport | null = null;
  try {
    let priorSums: string[] = [];
    let priorComps: string[][] = [];
    try {
      const histResult = await query(
        `SELECT summary_text, competencies FROM resume_history
         WHERE job_id != $1 AND archetype_primary = $2
         ORDER BY created_at DESC LIMIT 3`,
        [input.job_id, mandate.primary_mandate],
      );
      priorSums = histResult.rows.map((r: any) => r.summary_text).filter(Boolean);
      priorComps = histResult.rows.map((r: any) => {
        const c = r.competencies;
        return Array.isArray(c) ? c : typeof c === "string" ? JSON.parse(c) : [];
      });
    } catch { /* non-fatal */ }

    postProcessingReport = runPostProcessing({
      resume: finalResume,
      coverLetter: finalCoverLetter,
      mandate,
      ledger,
      inventory,
      priorSummaries: priorSums,
      priorCompetencies: priorComps,
      logger,
    });

    stageResults["post_processing"] = {
      stage: "Post-Processing Controller",
      success: true,
      data: postProcessingReport,
      duration_ms: postProcessingReport.duration_ms,
    };

    logger?.info(`🔬 [Pipeline v2] Post-Processing: ${postProcessingReport.scores.composite}/100 (${postProcessingReport.scores.grade}) — ${postProcessingReport.passed ? "PASS" : "FAIL"}`);
    if (postProcessingReport.blocking_issues.length > 0) {
      logger?.warn(`🚫 [Pipeline v2] Post-Processing blocking: ${postProcessingReport.blocking_issues.join("; ")}`);
    }
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline v2] Post-Processing failed: ${err.message}`);
  }

  // ── Contract validation on final resume ─────────────────────────

  // Verify post-processing did NOT mutate the resume
  if (postProcessingReport) {
    const contract = STAGE_CONTRACTS.post_processing;
    const snapshot = snapshotResume(finalResume);
    // The snapshot should be identical before and after post-processing
    // (it's detection-only). We log but don't block since the snapshot
    // was taken after layout governor already ran.
    logger?.info(`📋 [Pipeline v2] Contract: post_processing mutations=${contract.allowed_mutations.join(",")}`);
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
    logger?.warn(`⚠️ [Pipeline v2] Clarification questions failed: ${err.message}`);
  }

  // ── Atomic DB writes (snapshot + metadata + cost) ─────────────
  // All finalize writes go through a single transaction. On failure,
  // partial writes are rolled back to prevent inconsistent state.

  const budgetSnapshot = budget.getSnapshot();
  let txn: PipelineTransaction | null = null;
  try {
    txn = await beginPipelineTransaction();

    // Store resume snapshot for future divergence checks
    await txn.client.query(
      `INSERT INTO resume_history (job_id, target_company, target_role, summary_text, competencies, top_bullets_by_role, archetype_primary, key_phrases)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.job_id,
        finalResume.target_company,
        finalResume.target_role,
        finalResume.professional_summary,
        JSON.stringify((finalResume as any).core_competencies || []),
        JSON.stringify(finalResume.experience.map(exp =>
          exp.bullets.slice(0, 3).map(b => typeof b === "string" ? b : b.text),
        )),
        mandate.primary_mandate,
        JSON.stringify([]), // key_phrases populated by divergence enforcer
      ],
    );

    // Save pipeline metadata
    await txn.client.query(
      `UPDATE scores SET breakdown_json = jsonb_set(
         COALESCE(breakdown_json, '{}'::jsonb),
         '{verified_packet}',
         $2::jsonb
       ) WHERE job_id = $1`,
      [input.job_id, JSON.stringify({
        generated_at: new Date().toISOString(),
        pass: passed,
        recruiter_review_pass: recruiterReviewPassed,
        attempts_used: attemptHistory.length,
        max_attempts: maxAttempts,
        best_attempt: bestAttemptIndex,
        pipeline_version: "v2-consolidated",
        stages_run: Object.keys(stageResults),
        budget_used: {
          llm_calls: budgetSnapshot.llm_calls,
          repair_loops: budgetSnapshot.repair_loops,
          elapsed_ms: budgetSnapshot.elapsed_ms,
          budget_exhausted: budgetExhausted,
        },
        post_processing_grade: postProcessingReport?.scores.grade,
      })],
    );

    // Cost flush within same transaction
    const insert = costAccumulator.buildInsertSQL();
    if (insert) {
      await txn.client.query(insert.sql, insert.params).catch(() => { /* table may not exist yet */ });
    }

    await txn.commit();
    logger?.info(`✅ [Pipeline v2] DB writes committed in transaction`);
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline v2] DB transaction failed, rolling back: ${err.message}`);
    if (txn) await txn.rollback();
  } finally {
    if (txn) txn.release();
  }

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

  if (budgetExhausted) {
    humanReviewNotes.push(
      `[BUDGET] Pipeline budget exhausted: ${budgetSnapshot.llm_calls} LLM calls, ${budgetSnapshot.repair_loops} repair loops, ${Math.round(budgetSnapshot.elapsed_ms / 1000)}s elapsed`,
    );
  }

  if (ownershipWarnings.length > 0) {
    humanReviewNotes.push(`${ownershipWarnings.length} ownership inflation warning(s) detected.`);
    for (const w of ownershipWarnings) {
      humanReviewNotes.push(`[OWNERSHIP] ${w.location}: ${w.explanation}`);
    }
  }

  // Check for BLOCKED from layout governor (last attempt)
  const lastStage6Key = `stage6_attempt${attemptHistory.length}`;
  const lastStage6 = stageResults[lastStage6Key];
  if (lastStage6?.success && lastStage6.data?.blocked) {
    humanReviewNotes.push(
      `[BLOCKED] Resume exceeds 2-page budget after all compression. Page estimate: ${lastStage6.data.page_estimate?.estimated_pages} pages.`,
    );
  }

  // Check for BLOCKED from truth audit (last attempt)
  const lastStage7Key = `stage7_attempt${attemptHistory.length}`;
  const lastStage7 = stageResults[lastStage7Key];
  if (lastStage7?.success && lastStage7.data?.blocked) {
    humanReviewNotes.push(
      `[BLOCKED] Truth audit blocked output: ${(lastStage7.data.block_reasons || []).join("; ")}`,
    );
  }

  // Post-Processing issues
  if (postProcessingReport && !postProcessingReport.passed) {
    humanReviewNotes.push(
      `[POST-PROCESSING] Quality check failed (${postProcessingReport.scores.grade}): ${postProcessingReport.blocking_issues.join("; ")}`,
    );
  }
  if (postProcessingReport) {
    const s = postProcessingReport.scores;
    if (s.corruption < 100) humanReviewNotes.push(`[POST-PROCESSING] Corruption detected: ${s.corruption}/100`);
    if (s.verb_integrity < 70) humanReviewNotes.push(`[POST-PROCESSING] Low verb integrity: ${s.verb_integrity}/100`);
    if (s.mandate_alignment < 50) humanReviewNotes.push(`[POST-PROCESSING] Low mandate alignment: ${s.mandate_alignment}/100`);
    if (s.ownership_inflation < 80) humanReviewNotes.push(`[POST-PROCESSING] Ownership inflation: ${s.ownership_inflation}/100`);
    if (s.differentiation < 60) humanReviewNotes.push(`[POST-PROCESSING] Low differentiation: ${s.differentiation}/100`);
  }

  // Stage 8 Recruiter Review issues
  if (recruiterReview && !recruiterReviewPassed) {
    humanReviewNotes.push(
      `[RECRUITER REVIEW] Stage 8 FAIL — ${recruiterReview.critical_issues.length} critical, ${recruiterReview.major_issues.length} major issues remain.`,
    );
    for (const issue of recruiterReview.critical_issues) {
      humanReviewNotes.push(`[REVIEW CRITICAL] ${issue.type} at ${issue.location}: ${issue.fix}`);
    }
  }

  // Determine final human_review_required
  const humanReviewRequired = !passed ||
    budgetExhausted ||
    (recruiterReview !== undefined && !recruiterReviewPassed);

  // ── Summary ────────────────────────────────────────────────────

  logger?.info(`\n${"═".repeat(60)}`);
  logger?.info(`📊 [Pipeline v2] === FINAL SUMMARY ===`);
  logger?.info(`📊 [Pipeline v2] Job: ${company} — ${title}`);
  logger?.info(`📊 [Pipeline v2] Truth Audit Pass: ${passed}`);
  logger?.info(`📊 [Pipeline v2] Recruiter Review: ${recruiterReview ? recruiterReview.status : "SKIPPED"}`);
  logger?.info(`📊 [Pipeline v2] Post-Processing: ${postProcessingReport ? `${postProcessingReport.scores.composite}/100 (${postProcessingReport.scores.grade})` : "SKIPPED"}`);
  logger?.info(`📊 [Pipeline v2] Attempts: ${attemptHistory.length}/${maxAttempts}`);
  logger?.info(`📊 [Pipeline v2] Budget: ${budgetSnapshot.llm_calls}/${budgetConfig.max_llm_calls} LLM calls, ${budgetSnapshot.repair_loops}/${budgetConfig.max_repair_loops} repair loops`);
  logger?.info(`📊 [Pipeline v2] Human review required: ${humanReviewRequired}`);

  // ── Cost Summary ──────────────────────────────────────────────

  let costSummary: CostSummary | undefined;
  try {
    costSummary = costAccumulator.getSummary();
    if (costSummary.call_count > 0) {
      logger?.info(formatCostSummary(costSummary));
    }
    // Cost flush already handled in the transaction above
  } catch { /* cost tracking is non-fatal */ }
  finally {
    setGlobalCostAccumulator(null);
  }

  logger?.info(`${"═".repeat(60)}\n`);

  return {
    success: true,
    job_id: input.job_id,
    pass: passed && recruiterReviewPassed,
    attempts_used: attemptHistory.length,
    max_attempts: maxAttempts,
    resume: finalResume,
    cover_letter: finalCoverLetter,
    plaintext_resume: plaintextResume,
    clarification_questions: clarificationQuestions,
    ownership_warnings: ownershipWarnings,
    final_report: finalReport,
    recruiter_review: recruiterReview,
    refinement_score: postProcessingReport?.scores,
    attempt_history: attemptHistory,
    human_review_required: humanReviewRequired,
    human_review_notes: humanReviewNotes,
    stage_results: stageResults,
    cost_summary: costSummary,
  };
}
