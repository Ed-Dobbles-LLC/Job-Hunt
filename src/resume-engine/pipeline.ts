/**
 * Resume Tailoring Engine — Pipeline Orchestrator
 *
 * Runs the 8-stage pipeline in sequence with retry logic:
 *
 * Stage 1: Claims Ledger Extraction (DETERMINISTIC)
 * Stage 2: Mandate Classification (DETERMINISTIC + optional LLM)
 * Stage 3: Bullet Scoring & Reordering (DETERMINISTIC + optional embedding)
 * Stage 4: Constrained Rewrite (LLM)
 * Stage 5: Differentiation Gate (DETERMINISTIC)
 * Stage 6: Layout Governor (DETERMINISTIC)
 * Stage 7: Truth Audit (DETERMINISTIC)
 * Stage 8: Recruiter Review (LLM — audit/QA, not rewrite)
 *
 * Retry budget: Stage 4→5→6→7 loop max 3 attempts.
 * After stage 7 passes, stage 8 runs. If stage 8 FAILs:
 *   - Repair loop (max 2): constrained repair → stage 6 → stage 7 → stage 8
 *   - If still FAIL after 2 repairs: human_review_required = true
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
import { runRecruiterReview, buildRepairContext } from "./stage8-recruiter-review/reviewer";
import { renderPlaintext } from "./output/plaintext-renderer";
import { buildClarificationQuestions } from "./output/clarification-builder";
import { runQAGate, type QAGateResult } from "./qa-gate";

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
  embedding_config?: EmbeddingConfig;
  logger?: any;
}

// ── Main Pipeline ────────────────────────────────────────────────

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const logger = input.logger;
  const maxAttempts = input.max_attempts || DEFAULT_MAX_ATTEMPTS;
  const stageResults: Record<string, StageResult<any>> = {};

  logger?.info(`\n${"═".repeat(60)}`);
  logger?.info(`🚀 [Pipeline] Starting 8-stage resume tailoring pipeline`);
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
          logger,
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
            logger,
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

        // Check for BLOCKED from page estimator
        if (stage6.data.blocked) {
          logger?.warn(`🚫 [Pipeline] BLOCKED by page estimator — resume exceeds 2 pages after all compression`);
          logger?.warn(`📐 [Pipeline] Page estimate: ${stage6.data.page_estimate.estimated_pages} pages, ${stage6.data.page_estimate.estimated_lines} lines`);
          logger?.warn(`📐 [Pipeline] Compression actions taken: ${stage6.data.page_budget_actions.join("; ")}`);
        }

        // Log page band compliance
        if (stage6.data.page_band) {
          const band = stage6.data.page_band;
          logger?.info(`📐 [Pipeline] Page band: ${band.actual} pages (target: ${band.min}–${band.max}) ${band.in_band ? "IN BAND" : "OUT OF BAND"}`);
        }
        if (!stage6.data.min_roles_met) {
          logger?.warn(`⚠️ [Pipeline] Minimum roles not met: ${currentResume!.experience.length} roles (min 3 for executive depth)`);
        }
        if (stage6.data.expansion_result?.expanded) {
          logger?.info(`📐 [Pipeline] Expansion mode signals: ${stage6.data.expansion_result.actions.join("; ")}`);
        }

        // Log tone violations as diagnostics
        if (stage6.data.tone_violations.length > 0) {
          logger?.info(`⚠️ [Pipeline] ${stage6.data.tone_violations.length} bullet tone violation(s): ${stage6.data.tone_violations.map((v: any) => v.issue).join(", ")}`);
        }

        // Log verb strength results
        if (stage6.data.verb_strength) {
          const vs = stage6.data.verb_strength;
          logger?.info(`🔤 [Pipeline] Verb strength: ${vs.upgrades_applied} mandate upgrades, ${vs.diversity_fixes} diversity fixes, ${vs.generic_verbs_remaining} generic verbs remaining, ${vs.mandate_aligned_pct}% mandate-aligned`);
        }

        // Log hype word suppression results
        if (stage6.data.hype_word_suppression?.total_found > 0) {
          const hw = stage6.data.hype_word_suppression;
          logger?.info(`🚫 [Pipeline] Hype word suppression: ${hw.total_found} word(s) replaced: ${hw.replacements.map((r: any) => `"${r.word}"→"${r.replacement}"`).join(", ")}`);
        }

        // Log hard-block and metric verification from stage 7 (preview)
        if (stage6.data.hype_word_suppression?.total_found === 0) {
          logger?.info(`✅ [Pipeline] No hype words detected`);
        }
      }

      // ── STAGE 7: Truth Audit ───────────────────────────────────────

      const stage7 = await runStage(`Stage 7: Truth Audit (attempt ${attempt})`, () => {
        return runTruthAudit(currentResume!, currentCoverLetter!, allowlist, inventory);
      }, logger);

      stageResults[`stage7_attempt${attempt}`] = stage7;

      if (stage7.success) {
        currentReport = stage7.data.report;
        ownershipWarnings = stage7.data.ownershipWarnings;

        // Log claim audit results
        if (stage7.data.claimAudit.bullets_without_claims > 0) {
          logger?.info(`📋 [Pipeline] Claim audit: ${stage7.data.claimAudit.bullets_with_claims}/${stage7.data.claimAudit.total_bullets} bullets linked to Claims Ledger`);
        }

        // Log summary opener audit
        if (stage7.data.summaryOpenerAudit.has_banned_opener) {
          logger?.warn(`⚠️ [Pipeline] Summary uses banned generic opener: "${stage7.data.summaryOpenerAudit.matched_pattern}"`);
        }

        // Log hard-block claim results
        if (stage7.data.hardBlockResult?.violations.length > 0) {
          logger?.warn(`🚫 [Pipeline] Hard-block claims without ledger support: ${stage7.data.hardBlockResult.violations.map((v: any) => v.pattern_label).join(", ")}`);
        }

        // Log metric verification results
        const unsupportedMetrics = stage7.data.metricVerifications?.filter((m: any) => !m.has_support) || [];
        if (unsupportedMetrics.length > 0) {
          logger?.warn(`🚫 [Pipeline] Fabricated metrics: ${unsupportedMetrics.map((m: any) => m.metric).join(", ")}`);
        }

        // Log blocked state from truth audit
        if (stage7.data.blocked) {
          logger?.warn(`🚫 [Pipeline] BLOCKED by truth audit: ${stage7.data.block_reasons.join("; ")}`);
        }
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

  // ── Finalize best attempt from stages 4-7 ───────────────────────

  let finalResume = currentReport?.pass ? currentResume! : bestResume || currentResume!;
  let finalCoverLetter = currentReport?.pass ? currentCoverLetter! : bestCoverLetter || currentCoverLetter!;
  let finalReport = currentReport?.pass ? currentReport : bestReport || currentReport!;
  let passed = finalReport?.pass ?? false;

  // ── QA Gate (final quality check before rendering) ──────────────

  let qaResult: QAGateResult | null = null;
  try {
    qaResult = runQAGate(finalResume, finalCoverLetter);
    if (qaResult.blocking_issues.length > 0) {
      logger?.warn(`🚫 [Pipeline] QA Gate blocking issues: ${qaResult.blocking_issues.join("; ")}`);
    }
    if (qaResult.warnings.length > 0) {
      logger?.info(`⚠️ [Pipeline] QA Gate warnings: ${qaResult.warnings.join("; ")}`);
    }
    logger?.info(`🔎 [Pipeline] QA Gate: ${qaResult.passed ? "PASS ✅" : "FAIL ❌"} (${qaResult.duration_ms}ms)`);
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline] QA Gate failed: ${err.message}`);
  }

  // ── Plaintext ATS render ───────────────────────────────────────

  let plaintextResume: string | undefined;
  try {
    const candidateName = inventory?.profile?.name;
    plaintextResume = renderPlaintext(finalResume, candidateName);
  } catch (err: any) {
    logger?.warn(`⚠️ [Pipeline] Plaintext render failed: ${err.message}`);
  }

  // ── STAGE 8: Recruiter Review ─────────────────────────────────

  const MAX_REPAIR_LOOPS = 2;
  let recruiterReview: RecruiterReviewReport | undefined;
  let recruiterReviewPassed = false;

  // Fetch prior summaries for differentiation check
  let priorSummaries: string[] = [];
  try {
    const histResult = await query(
      `SELECT summary_text FROM resume_history
       WHERE job_id != $1
       ORDER BY created_at DESC LIMIT 3`,
      [input.job_id],
    );
    priorSummaries = histResult.rows
      .map((r: any) => r.summary_text)
      .filter(Boolean);
  } catch { /* non-fatal — differentiation check will skip */ }

  if (plaintextResume && passed) {
    try {
      // Get layout report from the last successful stage 6
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

      stageResults["stage8"] = stage8;

      if (stage8.success) {
        recruiterReview = stage8.data.report;
        recruiterReviewPassed = recruiterReview.status === "PASS";

        logger?.info(`🎓 [Pipeline] Recruiter Review: ${recruiterReview.status} (truthfulness=${recruiterReview.scores.truthfulness}, readability=${recruiterReview.scores.readability}, mandate=${recruiterReview.scores.mandate_alignment})`);
        logger?.info(`🎓 [Pipeline] Issues: ${recruiterReview.critical_issues.length} critical, ${recruiterReview.major_issues.length} major, ${recruiterReview.minor_issues.length} minor`);

        // ── Repair Loop (max 2 iterations) ──────────────────────────

        if (!recruiterReviewPassed && recruiterReview.safe_rewrite_allowed) {
          for (let repairLoop = 1; repairLoop <= MAX_REPAIR_LOOPS; repairLoop++) {
            logger?.info(`\n${"─".repeat(50)}`);
            logger?.info(`🔧 [Pipeline] === REPAIR LOOP ${repairLoop}/${MAX_REPAIR_LOOPS} ===`);
            logger?.info(`${"─".repeat(50)}`);

            try {
              // Build repair context from recruiter review
              const { repairInstructions, fixCount } = buildRepairContext(recruiterReview!);
              logger?.info(`🔧 [Pipeline] Repair instructions: ${fixCount} fixes to apply`);

              // Run constrained repair rewrite (stage 4 with correction context)
              const repairStage4 = await runStage(`Stage 4: Repair Rewrite (repair ${repairLoop})`, async () => {
                return constrainedRewrite({
                  inventory,
                  allowlist,
                  requirements,
                  title,
                  company,
                  mandate,
                  bulletPlan,
                  companyContext: input.company_context,
                  correctionContext: {
                    previousResume: finalResume,
                    previousCoverLetter: finalCoverLetter,
                    report: finalReport!,
                    attemptNumber: attemptHistory.length + repairLoop,
                  },
                  divergencePrompt: repairInstructions,
                  logger,
                });
              }, logger);

              if (!repairStage4.success) {
                logger?.warn(`⚠️ [Pipeline] Repair rewrite failed — skipping repair loop ${repairLoop}`);
                break;
              }

              stageResults[`stage4_repair${repairLoop}`] = repairStage4;
              finalResume = repairStage4.data.resume;
              finalCoverLetter = repairStage4.data.coverLetter;

              // Re-run stage 6: Layout Governor
              const repairStage6 = await runStage(`Stage 6: Layout Governor (repair ${repairLoop})`, () => {
                return governLayout(finalResume, mandate);
              }, logger);

              stageResults[`stage6_repair${repairLoop}`] = repairStage6;
              if (repairStage6.success) {
                finalResume = repairStage6.data.resume;
              }

              // Re-run stage 7: Truth Audit
              const repairStage7 = await runStage(`Stage 7: Truth Audit (repair ${repairLoop})`, () => {
                return runTruthAudit(finalResume, finalCoverLetter, allowlist, inventory);
              }, logger);

              stageResults[`stage7_repair${repairLoop}`] = repairStage7;
              if (repairStage7.success) {
                finalReport = repairStage7.data.report;
                passed = finalReport?.pass ?? false;
                ownershipWarnings = repairStage7.data.ownershipWarnings;
              }

              // Re-render plaintext for the new review
              try {
                const candidateName = inventory?.profile?.name;
                plaintextResume = renderPlaintext(finalResume, candidateName);
              } catch { /* non-fatal */ }

              // Re-run stage 8: Recruiter Review
              const repairStage8 = await runStage(`Stage 8: Recruiter Review (repair ${repairLoop})`, async () => {
                return runRecruiterReview({
                  claimsLedger: ledger,
                  mandateProfile: mandate,
                  truthAuditReport: finalReport!,
                  layoutReport: repairStage6.success ? repairStage6.data : {},
                  jdText,
                  plaintextResume: plaintextResume!,
                  resume: finalResume,
                  coverLetter: finalCoverLetter,
                  priorSummaries,
                  logger,
                });
              }, logger);

              stageResults[`stage8_repair${repairLoop}`] = repairStage8;

              if (repairStage8.success) {
                recruiterReview = repairStage8.data.report;
                recruiterReviewPassed = recruiterReview.status === "PASS";

                logger?.info(`🎓 [Pipeline] Repair ${repairLoop} Recruiter Review: ${recruiterReview.status} (truthfulness=${recruiterReview.scores.truthfulness}, readability=${recruiterReview.scores.readability})`);

                if (recruiterReviewPassed) {
                  logger?.info(`🎉 [Pipeline] Recruiter Review PASSED after repair loop ${repairLoop}!`);
                  break;
                }

                // If not safe to rewrite further, stop
                if (!recruiterReview.safe_rewrite_allowed) {
                  logger?.warn(`⚠️ [Pipeline] Recruiter review says safe_rewrite_allowed=false — stopping repairs`);
                  break;
                }
              } else {
                logger?.warn(`⚠️ [Pipeline] Repair stage 8 failed — stopping repairs`);
                break;
              }
            } catch (err: any) {
              logger?.error(`💥 [Pipeline] Repair loop ${repairLoop} error: ${err.message}`);
              break;
            }
          }
        } else if (!recruiterReviewPassed) {
          logger?.warn(`⚠️ [Pipeline] Recruiter review FAIL but safe_rewrite_allowed=false — requires human review`);
        }
      }
    } catch (err: any) {
      logger?.warn(`⚠️ [Pipeline] Stage 8 Recruiter Review failed: ${err.message}`);
    }
  } else if (!passed) {
    logger?.info(`⏭️ [Pipeline] Skipping Stage 8 — truth audit did not pass`);
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
        recruiter_review_pass: recruiterReviewPassed,
        attempts_used: attemptHistory.length,
        max_attempts: maxAttempts,
        best_attempt: bestAttemptIndex,
        pipeline_version: "8-stage-v1",
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

  // Check for BLOCKED from layout governor (last attempt)
  const lastStage6Key = `stage6_attempt${attemptHistory.length}`;
  const lastStage6 = stageResults[lastStage6Key];
  if (lastStage6?.success && lastStage6.data?.blocked) {
    humanReviewNotes.push(
      `[BLOCKED] Resume exceeds 2-page budget after all compression. Page estimate: ${lastStage6.data.page_estimate?.estimated_pages} pages.`,
      `Compression actions attempted: ${(lastStage6.data.page_budget_actions || []).join("; ")}`,
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

  // Check for QA Gate issues
  if (qaResult && !qaResult.passed) {
    humanReviewNotes.push(
      `[QA GATE] Pre-PDF quality check failed: ${qaResult.blocking_issues.join("; ")}`,
    );
  }
  if (qaResult?.warnings.length) {
    for (const w of qaResult.warnings) {
      humanReviewNotes.push(`[QA WARNING] ${w}`);
    }
  }

  // Check for Stage 8 Recruiter Review issues
  if (recruiterReview && !recruiterReviewPassed) {
    humanReviewNotes.push(
      `[RECRUITER REVIEW] Stage 8 FAIL — ${recruiterReview.critical_issues.length} critical, ${recruiterReview.major_issues.length} major issues remain.`,
    );
    for (const issue of recruiterReview.critical_issues) {
      humanReviewNotes.push(`[REVIEW CRITICAL] ${issue.type} at ${issue.location}: ${issue.fix}`);
    }
    for (const issue of recruiterReview.major_issues) {
      humanReviewNotes.push(`[REVIEW MAJOR] ${issue.type} at ${issue.location}: ${issue.fix}`);
    }
  }

  // Determine final human_review_required
  const humanReviewRequired = !passed ||
    (recruiterReview !== undefined && !recruiterReviewPassed);

  // ── Summary ────────────────────────────────────────────────────

  logger?.info(`\n${"═".repeat(60)}`);
  logger?.info(`📊 [Pipeline] === FINAL SUMMARY ===`);
  logger?.info(`📊 [Pipeline] Job: ${company} — ${title}`);
  logger?.info(`📊 [Pipeline] Truth Audit Pass: ${passed}`);
  logger?.info(`📊 [Pipeline] Recruiter Review: ${recruiterReview ? recruiterReview.status : "SKIPPED"}`);
  logger?.info(`📊 [Pipeline] Attempts: ${attemptHistory.length}/${maxAttempts}`);
  logger?.info(`📊 [Pipeline] Clarification questions: ${clarificationQuestions.length}`);
  logger?.info(`📊 [Pipeline] Ownership warnings: ${ownershipWarnings.length}`);
  logger?.info(`📊 [Pipeline] Plaintext rendered: ${!!plaintextResume}`);
  logger?.info(`📊 [Pipeline] QA Gate: ${qaResult?.passed ? "PASS" : qaResult ? "FAIL" : "SKIPPED"}`);
  logger?.info(`📊 [Pipeline] Human review required: ${humanReviewRequired}`);
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
    attempt_history: attemptHistory,
    human_review_required: humanReviewRequired,
    human_review_notes: humanReviewNotes,
    stage_results: stageResults,
  };
}
