import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import { buildEntityAllowlist, type EntityAllowlist } from "./entityAllowlist";
import {
  TailoredResumeSchema,
  buildResumeSystemPrompt,
  buildResumeUserPrompt,
  type TailoredResume,
} from "./tailoredResumePrompt";
import {
  TailoredCoverLetterSchema,
  buildCoverLetterSystemPrompt,
  buildCoverLetterUserPrompt,
  type TailoredCoverLetter,
} from "./tailoredCoverLetterPrompt";
import {
  runTruthfulnessVerification,
  type VerifierReport,
  type Violation,
  type LineItemFix,
} from "./truthfulnessVerifier";
import type { JDRequirements } from "./extractJDRequirementsTool";

const DEFAULT_MAX_ATTEMPTS = 3;

async function loadInventory(): Promise<Record<string, any>> {
  // Check DB first (survives Railway redeploys)
  try {
    const dbResult = await query("SELECT value FROM app_settings WHERE key = 'experience_inventory'");
    if (dbResult.rows.length > 0 && dbResult.rows[0].value) {
      return JSON.parse(dbResult.rows[0].value);
    }
  } catch { /* fall through to filesystem */ }

  // Fallback to filesystem
  try {
    const inventoryPath = workspacePath("experience_inventory.json");
    return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  } catch (err: any) {
    throw new Error(`Cannot load experience_inventory.json: ${err.message}. Run the Profile Builder first.`);
  }
}

/** Lazy OpenAI client — reads API key at call time, not import time */
let _openai: ReturnType<typeof createOpenAI> | null = null;
function getOpenAI() {
  if (!_openai) {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY or AI_INTEGRATIONS_OPENAI_API_KEY.");
    }
    _openai = createOpenAI({ apiKey });
  }
  return _openai;
}

/** Wrap generateObject with timeout and actionable error messages */
async function safeGenerateObject<T extends z.ZodTypeAny>(opts: {
  schema: T;
  system: string;
  prompt: string;
  temperature: number;
  label: string;
  logger?: any;
  timeoutMs?: number;
}): Promise<z.infer<T>> {
  const { schema, system, prompt, temperature, label, logger, timeoutMs = 120_000 } = opts;
  const startMs = Date.now();
  logger?.info(`🤖 [${label}] Calling gpt-4o (timeout=${timeoutMs}ms, prompt=${prompt.length} chars)`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const { object } = await generateObject({
      model: getOpenAI()("gpt-4o"),
      schema,
      system,
      prompt,
      temperature,
      abortSignal: controller.signal,
    });

    clearTimeout(timer);
    logger?.info(`✅ [${label}] LLM responded in ${Date.now() - startMs}ms`);
    return object;
  } catch (err: any) {
    const elapsedMs = Date.now() - startMs;
    const msg = err.message || String(err);
    if (err.name === "AbortError" || msg.includes("abort")) {
      throw new Error(`[${label}] LLM timed out after ${elapsedMs}ms. Prompt may be too large (${prompt.length} chars).`);
    }
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("API key")) {
      throw new Error(`[${label}] OpenAI API key is invalid. Check OPENAI_API_KEY env var.`);
    }
    throw new Error(`[${label}] LLM call failed after ${elapsedMs}ms: ${msg.substring(0, 500)}`);
  }
}

/** Write debug artifacts when DEBUG_GENERATION env var is set */
function writeDebugArtifact(label: string, data: any, jobId: number) {
  if (!process.env.DEBUG_GENERATION) return;
  try {
    const debugDir = workspacePath(`output/debug/${jobId}`);
    fs.mkdirSync(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = `${debugDir}/${ts}_${label}.json`;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch { /* debug logging should never break the pipeline */ }
}

export function buildCorrectionPrompt(
  docType: "resume" | "cover_letter",
  previousJson: string,
  violations: Violation[],
  fixes: LineItemFix[],
  attemptNumber: number,
): string {
  const criticals = violations.filter((v) => v.severity === "critical");
  const warnings = violations.filter((v) => v.severity === "warning");

  const violationDetails = criticals
    .map(
      (v, i) =>
        `${i + 1}. [${v.type}] at ${v.location}\n   Found: "${v.found_value}"\n   Problem: ${v.explanation}${v.expected ? `\n   Expected: "${v.expected}"` : ""}`,
    )
    .join("\n");

  const fixDetails = fixes
    .slice(0, 10)
    .map(
      (f, i) =>
        `${i + 1}. at ${f.location}\n   Current: "${f.current_text.substring(0, 120)}"\n   Suggested: "${f.suggested_text.substring(0, 120)}"\n   Reason: ${f.reason}`,
    )
    .join("\n");

  const warningDetails =
    warnings.length > 0
      ? `\n\n## WARNINGS (fix if possible, not blocking)\n${warnings.map((w, i) => `${i + 1}. [${w.type}] at ${w.location}: ${w.explanation}`).join("\n")}`
      : "";

  return `## CORRECTION REQUIRED — Attempt ${attemptNumber}

Your previous ${docType === "resume" ? "TailoredResume" : "TailoredCoverLetter"} JSON FAILED truthfulness verification with ${criticals.length} critical violation(s).

## YOUR PREVIOUS OUTPUT (contains errors)
${previousJson}

## CRITICAL VIOLATIONS YOU MUST FIX
${violationDetails}

## SUGGESTED FIXES
${fixDetails}
${warningDetails}

## CORRECTION INSTRUCTIONS
1. Start from your previous output above.
2. Fix EVERY critical violation listed. Each one MUST be resolved.
3. For NEW_ENTITY violations: Replace the hallucinated entity with one from the EntityAllowlist, or remove the claim entirely.
4. For UNSUPPORTED_METRIC violations: Replace the fabricated number with an allowlisted metric, or remove the metric and rewrite the sentence without a number.
5. For PLACEHOLDER violations: Remove all placeholder text, template variables, lorem ipsum, and code artifacts.
6. For INCONSISTENT_DATE violations: Use only dates from the EntityAllowlist.
7. For STYLE_RULE_BROKEN violations: Ensure every bullet has source_hash + evidence_quote pointing to real inventory IDs. Ensure confidence ≥ 0.7. Fix word count. Remove clichés.
8. For ATS_RISK violations: Remove tables/special chars, add ATS keywords from the JD.
9. Do NOT introduce any NEW violations while fixing existing ones.
10. Return ONLY the corrected JSON object.`;
}

export interface AttemptRecord {
  attempt: number;
  pass: boolean;
  critical_violations: number;
  warnings: number;
  total_checks: number;
  violation_types: string[];
  timestamp: string;
}

export interface GenerateVerifiedPacketResult {
  success: boolean;
  job_id: number;
  pass: boolean;
  attempts_used: number;
  max_attempts: number;
  resume: TailoredResume;
  cover_letter: TailoredCoverLetter;
  final_report: VerifierReport;
  attempt_history: AttemptRecord[];
  human_review_required: boolean;
  human_review_notes: string[];
}

const AttemptRecordSchema = z.object({
  attempt: z.number(),
  pass: z.boolean(),
  critical_violations: z.number(),
  warnings: z.number(),
  total_checks: z.number(),
  violation_types: z.array(z.string()),
  timestamp: z.string(),
});

export const generateVerifiedPacketTool = createTool({
  id: "generate-verified-packet",
  description:
    "Orchestrates the full Generate→Verify→Correct loop. Generates tailored resume and cover letter JSON, runs the 6-layer truthfulness verifier, and if verification fails, re-prompts the LLM with violation details to produce corrected output. Repeats up to N attempts (default 3). If all attempts fail, returns a human-review packet with the best attempt and all violation details.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to generate packet for"),
    company: z.string().optional().describe("Company name (loaded from DB if omitted)"),
    title: z.string().optional().describe("Job title (loaded from DB if omitted)"),
    requirements: z
      .record(z.any())
      .optional()
      .describe("JD requirements object. If omitted, loads from DB."),
    company_context: z
      .string()
      .optional()
      .describe("Company info for cover letter personalization"),
    max_attempts: z
      .number()
      .min(1)
      .max(5)
      .optional()
      .describe("Maximum generation+verification attempts (default 3, max 5)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    job_id: z.number(),
    pass: z.boolean(),
    attempts_used: z.number(),
    max_attempts: z.number(),
    resume: TailoredResumeSchema,
    cover_letter: TailoredCoverLetterSchema,
    final_report: z.any(),
    attempt_history: z.array(AttemptRecordSchema),
    human_review_required: z.boolean(),
    human_review_notes: z.array(z.string()),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const maxAttempts = context.max_attempts || DEFAULT_MAX_ATTEMPTS;

    logger?.info(`🔄 [generateVerifiedPacket] Starting Generate→Verify→Correct loop for job_id=${context.job_id}`);
    logger?.info(`🔄 [generateVerifiedPacket] Max attempts: ${maxAttempts}`);

    let company = context.company || "";
    let title = context.title || "";
    let requirements: JDRequirements;

    if (context.requirements) {
      requirements = context.requirements as JDRequirements;
      logger?.info(`🔄 [generateVerifiedPacket] Using provided requirements`);
    } else {
      logger?.info(`🔄 [generateVerifiedPacket] Loading job data from DB`);
      const result = await query(
        "SELECT company, title, jd_requirements FROM jobs WHERE job_id = $1",
        [context.job_id],
      );
      if (result.rows.length === 0) {
        throw new Error(`Job ID ${context.job_id} not found in database`);
      }
      if (!result.rows[0].jd_requirements) {
        throw new Error(
          `Job ID ${context.job_id} has no extracted requirements. Run extract-jd-requirements first.`,
        );
      }
      company = company || result.rows[0].company || "";
      title = title || result.rows[0].title || "";
      requirements = result.rows[0].jd_requirements;
    }

    logger?.info(`🔄 [generateVerifiedPacket] Target: ${company} — ${title}`);

    const inventory = await loadInventory();
    const allowlist = buildEntityAllowlist(inventory);
    logger?.info(`🔄 [generateVerifiedPacket] Inventory and allowlist loaded`);

    const resumeSystemPrompt = buildResumeSystemPrompt();
    const resumeUserPrompt = buildResumeUserPrompt(inventory, allowlist, requirements, title, company);
    const clSystemPrompt = buildCoverLetterSystemPrompt();
    const clUserPrompt = buildCoverLetterUserPrompt(inventory, allowlist, requirements, title, company, context.company_context);

    let currentResume: TailoredResume | null = null;
    let currentCoverLetter: TailoredCoverLetter | null = null;
    let currentReport: VerifierReport | null = null;
    const attemptHistory: AttemptRecord[] = [];
    let bestAttemptIndex = 0;
    let bestCriticalCount = Infinity;
    let bestResume: TailoredResume | null = null;
    let bestCoverLetter: TailoredCoverLetter | null = null;
    let bestReport: VerifierReport | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger?.info(`\n${"=".repeat(60)}`);
      logger?.info(`🔄 [generateVerifiedPacket] === ATTEMPT ${attempt}/${maxAttempts} ===`);
      logger?.info(`${"=".repeat(60)}`);

      try {
        if (attempt === 1) {
          logger?.info(`📄 [generateVerifiedPacket] Attempt ${attempt}: Generating initial resume...`);
          writeDebugArtifact(`attempt${attempt}_resume_prompt`, { system: resumeSystemPrompt, user: resumeUserPrompt }, context.job_id);

          currentResume = await safeGenerateObject({
            schema: TailoredResumeSchema,
            system: resumeSystemPrompt,
            prompt: resumeUserPrompt,
            temperature: 0.3,
            label: `resume-attempt${attempt}`,
            logger,
          });
          logger?.info(`✅ [generateVerifiedPacket] Attempt ${attempt}: Resume generated (${currentResume.experience.length} roles, ${currentResume.experience.reduce((s: number, e: any) => s + e.bullets.length, 0)} bullets)`);
          writeDebugArtifact(`attempt${attempt}_resume_output`, currentResume, context.job_id);

          logger?.info(`📝 [generateVerifiedPacket] Attempt ${attempt}: Generating initial cover letter...`);
          writeDebugArtifact(`attempt${attempt}_coverLetter_prompt`, { system: clSystemPrompt, user: clUserPrompt }, context.job_id);

          currentCoverLetter = await safeGenerateObject({
            schema: TailoredCoverLetterSchema,
            system: clSystemPrompt,
            prompt: clUserPrompt,
            temperature: 0.4,
            label: `coverLetter-attempt${attempt}`,
            logger,
          });
          logger?.info(`✅ [generateVerifiedPacket] Attempt ${attempt}: Cover letter generated (${currentCoverLetter.word_count} words, ${currentCoverLetter.value_claims.length} claims)`);
          writeDebugArtifact(`attempt${attempt}_coverLetter_output`, currentCoverLetter, context.job_id);
        } else {
          const previousViolations = currentReport!.violations;
          const previousFixes = currentReport!.line_item_fixes;

          const resumeViolations = previousViolations.filter((v) => v.location.startsWith("resume"));
          const resumeFixes = previousFixes.filter((f) => f.location.startsWith("resume"));
          const clViolations = previousViolations.filter((v) => v.location.startsWith("cover_letter"));
          const clFixes = previousFixes.filter((f) => f.location.startsWith("cover_letter"));

          if (resumeViolations.length > 0) {
            const correctionPrompt = buildCorrectionPrompt(
              "resume",
              JSON.stringify(currentResume, null, 2),
              resumeViolations,
              resumeFixes,
              attempt,
            );
            logger?.info(`📄 [generateVerifiedPacket] Attempt ${attempt}: Re-generating resume with ${resumeViolations.filter((v) => v.severity === "critical").length} critical violations to fix`);
            writeDebugArtifact(`attempt${attempt}_resume_correction`, { violations: resumeViolations, fixes: resumeFixes }, context.job_id);

            currentResume = await safeGenerateObject({
              schema: TailoredResumeSchema,
              system: resumeSystemPrompt,
              prompt: `${resumeUserPrompt}\n\n${correctionPrompt}`,
              temperature: 0.2,
              label: `resume-correction-attempt${attempt}`,
              logger,
            });
            logger?.info(`✅ [generateVerifiedPacket] Attempt ${attempt}: Corrected resume generated`);
            writeDebugArtifact(`attempt${attempt}_resume_corrected`, currentResume, context.job_id);
          } else {
            logger?.info(`✅ [generateVerifiedPacket] Attempt ${attempt}: Resume had no violations, keeping previous version`);
          }

          if (clViolations.length > 0) {
            const correctionPrompt = buildCorrectionPrompt(
              "cover_letter",
              JSON.stringify(currentCoverLetter, null, 2),
              clViolations,
              clFixes,
              attempt,
            );
            logger?.info(`📝 [generateVerifiedPacket] Attempt ${attempt}: Re-generating cover letter with ${clViolations.filter((v) => v.severity === "critical").length} critical violations to fix`);
            writeDebugArtifact(`attempt${attempt}_coverLetter_correction`, { violations: clViolations, fixes: clFixes }, context.job_id);

            currentCoverLetter = await safeGenerateObject({
              schema: TailoredCoverLetterSchema,
              system: clSystemPrompt,
              prompt: `${clUserPrompt}\n\n${correctionPrompt}`,
              temperature: 0.2,
              label: `coverLetter-correction-attempt${attempt}`,
              logger,
            });
            logger?.info(`✅ [generateVerifiedPacket] Attempt ${attempt}: Corrected cover letter generated`);
            writeDebugArtifact(`attempt${attempt}_coverLetter_corrected`, currentCoverLetter, context.job_id);
          } else {
            logger?.info(`✅ [generateVerifiedPacket] Attempt ${attempt}: Cover letter had no violations, keeping previous version`);
          }
        }

        logger?.info(`🔍 [generateVerifiedPacket] Attempt ${attempt}: Running 6-layer truthfulness verification...`);
        currentReport = runTruthfulnessVerification(
          currentResume!,
          currentCoverLetter!,
          allowlist,
          inventory,
        );
        writeDebugArtifact(`attempt${attempt}_verifier_report`, currentReport, context.job_id);

        const criticalCount = currentReport.stats.critical_violations;
        const warningCount = currentReport.stats.warnings;

        const attemptRecord: AttemptRecord = {
          attempt,
          pass: currentReport.pass,
          critical_violations: criticalCount,
          warnings: warningCount,
          total_checks: currentReport.stats.total_checks,
          violation_types: [...new Set(currentReport.violations.map((v) => v.type))],
          timestamp: new Date().toISOString(),
        };
        attemptHistory.push(attemptRecord);

        logger?.info(`🔍 [generateVerifiedPacket] Attempt ${attempt} result: ${currentReport.pass ? "PASS ✅" : "FAIL ❌"}`);
        logger?.info(`🔍 [generateVerifiedPacket] Critical: ${criticalCount}, Warnings: ${warningCount}, Total checks: ${currentReport.stats.total_checks}`);

        const isBetter =
          criticalCount < bestCriticalCount ||
          (criticalCount === bestCriticalCount && warningCount < (bestReport?.stats.warnings ?? Infinity));

        if (isBetter) {
          const previousBest = bestCriticalCount === Infinity ? "∞" : String(bestCriticalCount);
          bestCriticalCount = criticalCount;
          bestAttemptIndex = attempt;
          bestResume = { ...currentResume! };
          bestCoverLetter = { ...currentCoverLetter! };
          bestReport = { ...currentReport };
          logger?.info(`🏆 [generateVerifiedPacket] Attempt ${attempt} is new best (${criticalCount} criticals, down from ${previousBest})`);
        }

        if (currentReport.pass) {
          logger?.info(`\n🎉 [generateVerifiedPacket] VERIFICATION PASSED on attempt ${attempt}!`);
          logger?.info(`🎉 [generateVerifiedPacket] Total checks: ${currentReport.stats.total_checks}, 0 critical violations`);
          break;
        }

        if (attempt < maxAttempts) {
          const critViolTypes = [...new Set(currentReport.violations.filter((v) => v.severity === "critical").map((v) => v.type))];
          logger?.info(`🔄 [generateVerifiedPacket] Will retry. Remaining critical violation types: ${critViolTypes.join(", ")}`);
          for (const v of currentReport.violations.filter((v) => v.severity === "critical").slice(0, 5)) {
            logger?.info(`   ❌ [${v.type}] ${v.location}: ${v.found_value.substring(0, 80)}`);
          }
        }
      } catch (err: any) {
        logger?.error(`💥 [generateVerifiedPacket] Attempt ${attempt} failed with error: ${err.message}`);
        attemptHistory.push({
          attempt,
          pass: false,
          critical_violations: -1,
          warnings: -1,
          total_checks: 0,
          violation_types: ["ERROR"],
          timestamp: new Date().toISOString(),
        });

        if (attempt >= maxAttempts && !bestResume) {
          throw new Error(
            `All ${maxAttempts} attempts failed. Last error: ${err.message}`,
          );
        }
      }
    }

    const finalResume = currentReport?.pass ? currentResume! : bestResume || currentResume!;
    const finalCoverLetter = currentReport?.pass ? currentCoverLetter! : bestCoverLetter || currentCoverLetter!;
    const finalReport = currentReport?.pass ? currentReport : bestReport || currentReport!;
    const passed = finalReport.pass;

    const humanReviewNotes: string[] = [];
    if (!passed) {
      logger?.info(`\n⚠️ [generateVerifiedPacket] ALL ${maxAttempts} ATTEMPTS EXHAUSTED — returning human-review packet`);
      logger?.info(`⚠️ [generateVerifiedPacket] Best attempt was #${bestAttemptIndex} with ${bestCriticalCount} critical violations`);

      humanReviewNotes.push(
        `Automated verification failed after ${maxAttempts} attempts.`,
        `Best attempt was #${bestAttemptIndex} with ${bestCriticalCount} critical violation(s).`,
        `Returning the best attempt for manual review and correction.`,
      );

      const remainingCriticals = finalReport.violations.filter((v) => v.severity === "critical");
      for (const v of remainingCriticals) {
        humanReviewNotes.push(
          `[${v.type}] ${v.location}: ${v.explanation}`,
        );
      }

      for (const fix of finalReport.line_item_fixes.slice(0, 10)) {
        humanReviewNotes.push(
          `FIX @ ${fix.location}: ${fix.reason} — change "${fix.current_text.substring(0, 60)}" to "${fix.suggested_text.substring(0, 60)}"`,
        );
      }
    }

    try {
      await query(
        `UPDATE scores SET breakdown_json = jsonb_set(
           COALESCE(breakdown_json, '{}'::jsonb),
           '{verified_packet}',
           $2::jsonb
         ) WHERE job_id = $1`,
        [
          context.job_id,
          JSON.stringify({
            generated_at: new Date().toISOString(),
            pass: passed,
            attempts_used: attemptHistory.length,
            max_attempts: maxAttempts,
            best_attempt: bestAttemptIndex,
            final_critical_violations: finalReport.stats.critical_violations,
            final_warnings: finalReport.stats.warnings,
            human_review_required: !passed,
            attempt_history: attemptHistory,
          }),
        ],
      );
      logger?.info(`💾 [generateVerifiedPacket] Saved packet metadata to DB`);
    } catch (err: any) {
      logger?.error(`⚠️ [generateVerifiedPacket] Failed to save metadata: ${err.message}`);
    }

    logger?.info(`\n📊 [generateVerifiedPacket] === FINAL SUMMARY ===`);
    logger?.info(`📊 [generateVerifiedPacket] Job ID: ${context.job_id}`);
    logger?.info(`📊 [generateVerifiedPacket] Pass: ${passed}`);
    logger?.info(`📊 [generateVerifiedPacket] Attempts used: ${attemptHistory.length}/${maxAttempts}`);
    logger?.info(`📊 [generateVerifiedPacket] Human review required: ${!passed}`);
    if (!passed) {
      logger?.info(`📊 [generateVerifiedPacket] Remaining violations: ${finalReport.stats.critical_violations} critical, ${finalReport.stats.warnings} warnings`);
      logger?.info(`📊 [generateVerifiedPacket] Human review notes: ${humanReviewNotes.length} items`);
    }

    return {
      success: true,
      job_id: context.job_id,
      pass: passed,
      attempts_used: attemptHistory.length,
      max_attempts: maxAttempts,
      resume: finalResume,
      cover_letter: finalCoverLetter,
      final_report: finalReport,
      attempt_history: attemptHistory,
      human_review_required: !passed,
      human_review_notes: humanReviewNotes,
    };
  },
});
