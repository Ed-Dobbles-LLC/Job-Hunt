import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";
import { computeMatchReport, prettyPrintMatchReport, type ExperienceInventory, type MatchReport } from "./matchScorer";
import { JDRequirementsSchema, type JDRequirements } from "./extractJDRequirementsTool";
import { loadInventoryStrict } from "../../resume-engine/inventory-loader";

/** Load inventory via centralized loader — throws MissingBaselineError, never returns stubs */
async function loadInventory(): Promise<ExperienceInventory> {
  return loadInventoryStrict() as Promise<ExperienceInventory>;
}

const MatchedReqSchema = z.object({
  requirement: z.string(),
  confidence: z.number(),
  matched: z.boolean(),
  match_strength: z.number(),
  evidence_id: z.string(),
  evidence_quote: z.string(),
  evidence_source: z.string(),
});

const UnmatchedReqSchema = z.object({
  requirement: z.string(),
  confidence: z.number(),
  gap_severity: z.enum(["critical", "moderate", "minor"]),
});

const CategoryScoreSchema = z.object({
  score: z.number(),
  max_score: z.number(),
  pct: z.number(),
  matched: z.array(MatchedReqSchema),
  unmatched: z.array(UnmatchedReqSchema),
});

const SupportingBulletSchema = z.object({
  bullet_id: z.string(),
  text: z.string(),
  employer: z.string(),
  title: z.string(),
  matched_requirements: z.array(z.string()),
  relevance_score: z.number(),
});

const MatchExplanationSchema = z.object({
  sentence: z.string(),
  evidence_id: z.string(),
  evidence_quote: z.string(),
  category: z.string(),
});

export const matchScorerTool = createTool({
  id: "match-score",
  description:
    "Compares structured JD requirements against the experience inventory to produce a detailed MatchReport. Takes JD requirements (from extract-jd-requirements) and returns: total score (0-100), sub-scores per category, top 10 supporting inventory bullets, explainability sentences with evidence pointers, ATS keyword coverage, and red flag assessment. This is a deterministic scorer — no LLM calls.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to score"),
    requirements: JDRequirementsSchema.optional().describe(
      "Structured JD requirements. If omitted, loads from jd_requirements column in DB.",
    ),
  }),
  outputSchema: z.object({
    job_id: z.number(),
    total_score: z.number(),
    sub_scores: z.object({
      must_have: CategoryScoreSchema,
      nice_to_have: CategoryScoreSchema,
      leadership_scope: CategoryScoreSchema,
      domain_context: CategoryScoreSchema,
      tech_keywords: CategoryScoreSchema,
    }),
    top_bullets: z.array(SupportingBulletSchema),
    match_explanations: z.array(MatchExplanationSchema),
    ats_coverage: z.object({
      covered: z.array(z.string()),
      uncovered: z.array(z.string()),
      coverage_pct: z.number(),
    }),
    red_flag_assessment: z.object({
      flags: z.array(z.object({
        text: z.string(),
        severity: z.enum(["high", "medium", "low"]),
      })),
      total_risk_score: z.number(),
    }),
    meta: z.object({
      requirements_total: z.number(),
      requirements_matched: z.number(),
      match_rate: z.number(),
      weighted_confidence: z.number(),
    }),
    pretty_report: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(`📊 [matchScorer] Starting match scoring for job_id=${context.job_id}`);

    let requirements: JDRequirements;
    let company = "";
    let title = "";

    if (context.requirements) {
      logger?.info(`📊 [matchScorer] Using provided requirements`);
      requirements = context.requirements;
    } else {
      logger?.info(`📊 [matchScorer] Loading requirements from DB for job_id=${context.job_id}`);
      const result = await query(
        "SELECT jd_requirements, company, title FROM jobs WHERE job_id = $1",
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
      requirements = result.rows[0].jd_requirements;
      company = result.rows[0].company || "";
      title = result.rows[0].title || "";
    }

    logger?.info(`📊 [matchScorer] Loading experience inventory`);
    const inventory = await loadInventory();

    logger?.info(`📊 [matchScorer] Computing match report`);
    const report: MatchReport = computeMatchReport(requirements, inventory);

    const jobLabel = company && title ? `${company} — ${title}` : `Job #${context.job_id}`;
    const prettyReport = prettyPrintMatchReport(report, jobLabel);

    logger?.info(`✅ [matchScorer] Match score: ${report.total_score}/100 | Match rate: ${report.meta.match_rate}% | ATS coverage: ${report.ats_coverage.coverage_pct}%`);
    logger?.info(`📊 [matchScorer] Sub-scores: must_have=${report.sub_scores.must_have.pct}%, nice=${report.sub_scores.nice_to_have.pct}%, leadership=${report.sub_scores.leadership_scope.pct}%, domain=${report.sub_scores.domain_context.pct}%, tech=${report.sub_scores.tech_keywords.pct}%`);
    logger?.info(`📊 [matchScorer] Top bullets: ${report.top_bullets.length} | Explanations: ${report.match_explanations.length} | Red flags: ${report.red_flag_assessment.flags.length}`);

    try {
      await query(
        `ALTER TABLE scores ADD COLUMN IF NOT EXISTS match_report JSONB`,
      );
      await query(
        `INSERT INTO scores (job_id, total_score, breakdown_json, match_report)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_id) DO UPDATE SET
           match_report = $4`,
        [
          context.job_id,
          report.total_score,
          JSON.stringify({ match_score: report.total_score, sub_scores: report.sub_scores }),
          JSON.stringify(report),
        ],
      );
      logger?.info(`💾 [matchScorer] Saved match report to DB for job_id=${context.job_id}`);
    } catch (err: any) {
      logger?.error(`⚠️ [matchScorer] Failed to save to DB: ${err.message}`);
    }

    return {
      job_id: context.job_id,
      ...report,
      pretty_report: prettyReport,
    };
  },
});
