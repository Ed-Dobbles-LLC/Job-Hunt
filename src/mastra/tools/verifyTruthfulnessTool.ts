import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import { buildEntityAllowlist } from "./entityAllowlist";
import { TailoredResumeSchema } from "./tailoredResumePrompt";
import { TailoredCoverLetterSchema } from "./tailoredCoverLetterPrompt";
import {
  VerifierReportSchema,
  runTruthfulnessVerification,
} from "./truthfulnessVerifier";

function loadInventory(): Record<string, any> {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

export const verifyTruthfulnessTool = createTool({
  id: "verify-truthfulness",
  description:
    "Adversarial 6-layer truthfulness verifier for generated application packets. Takes TailoredResume and TailoredCoverLetter JSON, cross-references every entity, metric, date, and evidence pointer against the EntityAllowlist and ExperienceInventory. Returns pass/fail verdict, typed violations (NEW_ENTITY, UNSUPPORTED_METRIC, PLACEHOLDER, INCONSISTENT_DATE, STYLE_RULE_BROKEN, ATS_RISK), and actionable line_item_fixes. Assumes the generator may hallucinate — no trust given.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID"),
    resume: TailoredResumeSchema.describe("TailoredResume JSON from generate-resume tool"),
    cover_letter: TailoredCoverLetterSchema.describe("TailoredCoverLetter JSON from generate-cover-letter tool"),
  }),
  outputSchema: z.object({
    job_id: z.number(),
    report: VerifierReportSchema,
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(`🔍 [verifyTruthfulness] Starting adversarial verification for job_id=${context.job_id}`);

    logger?.info(`🔍 [verifyTruthfulness] Loading experience inventory and building allowlist`);
    const inventory = loadInventory();
    const allowlist = buildEntityAllowlist(inventory);

    logger?.info(`🔍 [verifyTruthfulness] Allowlist loaded — ${allowlist.companies.length} companies, ${allowlist.metrics.length} metrics, ${allowlist.dates.length} dates, ${allowlist.tools.length} tools`);

    logger?.info(`🔍 [verifyTruthfulness] Running 6-layer verification...`);
    logger?.info(`🔍 [verifyTruthfulness] Layer 1: NEW_ENTITY — checking all employers, titles, locations, degrees, certifications, skills`);
    logger?.info(`🔍 [verifyTruthfulness] Layer 2: UNSUPPORTED_METRIC — checking all dollar amounts, percentages, team sizes`);
    logger?.info(`🔍 [verifyTruthfulness] Layer 3: PLACEHOLDER — scanning for denylist patterns (placeholder domains, names, code artifacts, template vars)`);
    logger?.info(`🔍 [verifyTruthfulness] Layer 4: INCONSISTENT_DATE — verifying all dates exist in allowlist and are chronologically valid`);
    logger?.info(`🔍 [verifyTruthfulness] Layer 5: STYLE_RULE_BROKEN — validating evidence pointers, source_hash validity, quote accuracy, word count, clichés`);
    logger?.info(`🔍 [verifyTruthfulness] Layer 6: ATS_RISK — checking for tables, special chars, emoji, keyword coverage`);

    const report = runTruthfulnessVerification(
      context.resume,
      context.cover_letter,
      allowlist,
      inventory,
    );

    logger?.info(`🔍 [verifyTruthfulness] Verification complete: ${report.pass ? "PASS ✅" : "FAIL ❌"}`);
    logger?.info(`🔍 [verifyTruthfulness] Total checks: ${report.stats.total_checks}`);
    logger?.info(`🔍 [verifyTruthfulness] Critical violations: ${report.stats.critical_violations}`);
    logger?.info(`🔍 [verifyTruthfulness] Warnings: ${report.stats.warnings}`);
    logger?.info(`🔍 [verifyTruthfulness] Line item fixes suggested: ${report.line_item_fixes.length}`);

    if (!report.pass) {
      const criticals = report.violations.filter((v) => v.severity === "critical");
      for (const v of criticals.slice(0, 10)) {
        logger?.info(`  ❌ [${v.type}] ${v.location}: ${v.explanation}`);
      }
      if (criticals.length > 10) {
        logger?.info(`  ... and ${criticals.length - 10} more critical violations`);
      }
    }

    if (report.violations.filter((v) => v.severity === "warning").length > 0) {
      const warnings = report.violations.filter((v) => v.severity === "warning");
      for (const w of warnings.slice(0, 5)) {
        logger?.info(`  ⚠️ [${w.type}] ${w.location}: ${w.explanation}`);
      }
    }

    try {
      await query(
        `UPDATE scores SET breakdown_json = jsonb_set(
           COALESCE(breakdown_json, '{}'::jsonb),
           '{truthfulness_verification}',
           $2::jsonb
         ) WHERE job_id = $1`,
        [
          context.job_id,
          JSON.stringify({
            verified_at: new Date().toISOString(),
            pass: report.pass,
            critical_violations: report.stats.critical_violations,
            warnings: report.stats.warnings,
            total_checks: report.stats.total_checks,
          }),
        ],
      );
      logger?.info(`💾 [verifyTruthfulness] Saved verification metadata to DB`);
    } catch (err: any) {
      logger?.error(`⚠️ [verifyTruthfulness] Failed to save metadata: ${err.message}`);
    }

    return {
      job_id: context.job_id,
      report,
    };
  },
});
