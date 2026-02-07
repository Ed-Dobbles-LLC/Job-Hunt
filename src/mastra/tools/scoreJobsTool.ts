import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";
import {
  SPEC_INFLATION_CONFIG,
  AI_STRATEGY_TERMS,
  AI_ENGINEERING_TERMS,
  getActiveMode,
  getActiveProfile,
  getMaxPositiveScore,
  type ScoringWeights,
  type ScoringProfile,
} from "./scoringConfig";

function loadInventory(): any {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

const EXECUTION_MODE_NEGATIVE_SIGNALS = [
  "agentic",
  "autonomous agents",
  "ai-driven ci/cd",
  "pipelines",
  "mlops",
  "deployment",
  "monitoring",
  "infra",
  "architect",
  "software engineering",
  "platform",
  "latency",
  "slas",
  "kubernetes",
  "devops",
];

const EXECUTION_MODE_POSITIVE_SIGNALS = [
  "roadmap",
  "strategy",
  "business value",
  "operating model",
  "adoption",
  "portfolio",
  "executive stakeholders",
  "board",
  "roi",
  "transformation",
];

export function classifyExecutionMode(jd: string): {
  score: number;
  reason: string;
} {
  const text = jd.toLowerCase();

  const posHits = EXECUTION_MODE_POSITIVE_SIGNALS.filter((s) =>
    text.includes(s),
  );
  const negHits = EXECUTION_MODE_NEGATIVE_SIGNALS.filter((s) =>
    text.includes(s),
  );

  const posCount = posHits.length;
  const negCount = negHits.length;

  let score: number;
  const reasons: string[] = [];

  if (negCount >= 6) {
    score = -20;
    reasons.push(
      `Heavy engineering/platform depth expected (${negCount} infra signals: ${negHits.slice(0, 4).join(", ")}...)`,
    );
  } else if (negCount >= 3 && posCount <= 1) {
    score = -10;
    reasons.push(
      `Engineering-heavy AI ownership (${negCount} infra signals: ${negHits.join(", ")})`,
    );
  } else if (posCount >= 4 && negCount <= 1) {
    score = 10;
    reasons.push(
      `Strategy-led role (${posCount} strategy signals: ${posHits.slice(0, 4).join(", ")})`,
    );
  } else if (posCount >= 2 && negCount <= 1) {
    score = 5;
    reasons.push(
      `Mostly strategy-led (${posCount} strategy signals, ${negCount} infra signals)`,
    );
  } else if (negCount >= 3 && posCount >= 2) {
    score = -5;
    reasons.push(
      `Mixed but leans engineering (${posCount} strategy vs ${negCount} infra signals)`,
    );
  } else {
    score = 0;
    reasons.push(
      `Mixed strategy + execution (${posCount} strategy, ${negCount} infra signals)`,
    );
  }

  if (posHits.length > 0) {
    reasons.push(`Strategy: ${posHits.join(", ")}`);
  }
  if (negHits.length > 0) {
    reasons.push(`Infra: ${negHits.join(", ")}`);
  }

  return { score, reason: reasons.join(". ") };
}

export function computeSpecInflationPenalty(jd: string): {
  score: number;
  reason: string;
  advancedCount: number;
  businessCount: number;
} {
  const text = jd.toLowerCase();
  const cfg = SPEC_INFLATION_CONFIG;

  const advHits = cfg.advancedAITerms.filter((t) => text.includes(t));
  const bizHits = cfg.businessOutcomeTerms.filter((t) => text.includes(t));
  const advCount = advHits.length;
  const bizCount = bizHits.length;

  const th = cfg.thresholds;
  const advLevel =
    advCount >= th.advancedDensity.high
      ? "high"
      : advCount >= th.advancedDensity.med
        ? "med"
        : advCount >= th.advancedDensity.low
          ? "low"
          : "none";
  const bizLevel =
    bizCount >= th.businessDensity.high
      ? "high"
      : bizCount >= th.businessDensity.med
        ? "med"
        : bizCount >= th.businessDensity.low
          ? "low"
          : "none";

  let penalty = 0;

  if (advLevel === "high" && (bizLevel === "none" || bizLevel === "low")) {
    penalty = cfg.penalties.highAdvLowBiz;
  } else if (advLevel === "high" && bizLevel === "med") {
    penalty = cfg.penalties.highAdvMedBiz;
  } else if (advLevel === "med" && (bizLevel === "none" || bizLevel === "low")) {
    penalty = cfg.penalties.medAdvLowBiz;
  } else if (advLevel === "med" && bizLevel === "med") {
    penalty = cfg.penalties.medAdvMedBiz;
  }

  penalty = Math.max(penalty, cfg.maxPenalty);

  const reasons: string[] = [];
  if (penalty < 0) {
    reasons.push(
      `Spec inflation detected: ${advCount} advanced AI terms (${advLevel}) vs ${bizCount} business outcomes (${bizLevel}), penalty ${penalty}`,
    );
    if (advHits.length > 0) reasons.push(`AI terms: ${advHits.join(", ")}`);
    if (bizHits.length > 0) reasons.push(`Biz terms: ${bizHits.join(", ")}`);
  } else {
    reasons.push(
      `No spec inflation (${advCount} advanced, ${bizCount} business)`,
    );
  }

  return {
    score: penalty,
    reason: reasons.join(". "),
    advancedCount: advCount,
    businessCount: bizCount,
  };
}

export function scoreAIStrategyStack(jd: string, maxPoints: number): { score: number; hits: string[] } {
  const text = jd.toLowerCase();
  const hits = AI_STRATEGY_TERMS.filter((t) => text.includes(t));
  const raw = Math.min(maxPoints, Math.round((hits.length / 4) * maxPoints));
  return { score: raw, hits };
}

export function scoreAIEngineeringStack(jd: string, maxPoints: number): { score: number; hits: string[] } {
  const text = jd.toLowerCase();
  const hits = AI_ENGINEERING_TERMS.filter((t) => text.includes(t));
  const raw = Math.min(maxPoints, Math.round((hits.length / 4) * maxPoints));
  return { score: raw, hits };
}

export function scoreSingleJob(
  job: any,
  inventory: any,
  profile?: ScoringProfile,
): { total: number; breakdown: Record<string, any>; mode: string } {
  const p = profile || getActiveProfile();
  const w = p.weights;
  const mode = profile ? (profile === getActiveProfile() ? getActiveMode() : "custom") : getActiveMode();

  const jd = (job.jd_raw_text || "").toLowerCase();
  const title = (job.title || "").toLowerCase();
  const location = (job.location || "").toLowerCase();
  const remoteHybrid = (job.remote_hybrid || "").toLowerCase();

  const breakdown: Record<string, any> = {};

  const vpKeywords = ["vp", "vice president", "head of", "chief", "cdo", "svp"];
  const dirKeywords = ["director", "senior director"];
  const managerKeywords = ["manager", "lead"];
  const isVpPlus = vpKeywords.some((kw) => title.includes(kw));
  if (isVpPlus) {
    breakdown.role_level_match = w.role_level_match;
  } else if (dirKeywords.some((kw) => title.includes(kw))) {
    breakdown.role_level_match = Math.round(w.role_level_match * 0.8);
  } else if (managerKeywords.some((kw) => title.includes(kw))) {
    breakdown.role_level_match = Math.round(w.role_level_match * 0.4);
  } else {
    breakdown.role_level_match = Math.round(w.role_level_match * 0.2);
  }

  const leadershipSignals = [
    "lead a team",
    "build a team",
    "manage",
    "direct reports",
    "team of",
    "organization",
    "department",
    "p&l",
    "budget",
    "executive",
    "c-suite",
    "board",
  ];
  const leadershipCount = leadershipSignals.filter((s) =>
    jd.includes(s),
  ).length;
  breakdown.leadership_scope = Math.min(w.leadership_scope, Math.round((leadershipCount / 4) * w.leadership_scope));

  const domains = inventory.skills?.domains || [];
  const domainMatch = domains.filter((d: string) =>
    jd.includes(d.toLowerCase()),
  ).length;
  breakdown.domain_relevance = Math.min(w.domain_relevance, Math.round((domainMatch / 2) * w.domain_relevance));

  const stratStack = scoreAIStrategyStack(jd, w.ai_strategy_stack);
  breakdown.ai_strategy_stack = stratStack.score;

  const engStack = scoreAIEngineeringStack(jd, w.ai_engineering_stack);
  breakdown.ai_engineering_stack = engStack.score;

  let dominanceAdj = 0;
  if (engStack.score > stratStack.score && isVpPlus && p.dominanceAdjustment !== 0) {
    dominanceAdj = p.dominanceAdjustment;
  }
  breakdown.dominance_adjustment = dominanceAdj;

  const preferredLocations = ["chicago", "remote", "hybrid"];
  const locationMatch = preferredLocations.some(
    (loc) => location.includes(loc) || remoteHybrid.includes(loc),
  );
  breakdown.location_fit = locationMatch ? w.location_fit : Math.round(w.location_fit * 0.375);

  const compText = jd.match(
    /\$[\d,]+\s*[-–]\s*\$[\d,]+/,
  );
  if (compText) {
    const numbers = compText[0].match(/[\d,]+/g) || [];
    const high = parseInt(numbers[numbers.length - 1]?.replace(/,/g, "") || "0");
    if (high >= 300000) breakdown.compensation = w.compensation;
    else if (high >= 250000) breakdown.compensation = Math.round(w.compensation * 0.8);
    else if (high >= 200000) breakdown.compensation = Math.round(w.compensation * 0.6);
    else if (high >= 150000) breakdown.compensation = Math.round(w.compensation * 0.4);
    else breakdown.compensation = Math.round(w.compensation * 0.2);
  } else {
    breakdown.compensation = Math.round(w.compensation * 0.5);
  }

  const transformSignals = [
    "transform",
    "modernize",
    "build from scratch",
    "greenfield",
    "first",
    "establish",
    "new function",
    "scale",
    "grow",
  ];
  const transformCount = transformSignals.filter((s) =>
    jd.includes(s),
  ).length;
  breakdown.transformation_mandate = Math.min(w.transformation_mandate, Math.round((transformCount / 3) * w.transformation_mandate));

  const companyPrefSignals = [
    "series",
    "fortune",
    "growth",
    "innovative",
    "leading",
  ];
  const prefCount = companyPrefSignals.filter((s) => jd.includes(s)).length;
  breakdown.company_preference = Math.min(w.company_preference, Math.round((prefCount / 2) * w.company_preference));

  const execMode = classifyExecutionMode(jd);
  const clampedExec = Math.max(w.execution_mode_match.min, Math.min(w.execution_mode_match.max, execMode.score));
  breakdown.execution_mode_match = clampedExec;
  breakdown.execution_mode_reason = execMode.reason;

  const specInflation = computeSpecInflationPenalty(jd);
  const clampedSpec = Math.max(w.spec_inflation_penalty.min, Math.min(w.spec_inflation_penalty.max, specInflation.score));
  breakdown.spec_inflation_penalty = clampedSpec;
  breakdown.spec_inflation_reason = specInflation.reason;

  const REASON_KEYS = ["execution_mode_reason", "spec_inflation_reason"];
  const rawTotal = Object.entries(breakdown).reduce((sum, [key, v]) => {
    if (REASON_KEYS.includes(key)) return sum;
    return sum + (v as number);
  }, 0);

  const maxPos = getMaxPositiveScore(w);
  const normalized = Math.max(0, Math.min(100, Math.round((rawTotal / maxPos) * 100)));

  breakdown._raw_total = rawTotal;
  breakdown._max_possible = maxPos;
  breakdown._scoring_mode = mode;

  return { total: normalized, breakdown, mode };
}

export const scoreJobsTool = createTool({
  id: "score-jobs",
  description:
    "Scores job postings against the experience inventory using a weighted rubric (0-100). Returns top N jobs sorted by score.",
  inputSchema: z.object({
    jobIds: z.array(z.number()).describe("List of job IDs to score"),
    topN: z
      .number()
      .optional()
      .describe("Number of top jobs to return, defaults to 10"),
  }),
  outputSchema: z.object({
    scoredJobs: z.array(
      z.object({
        job_id: z.number(),
        company: z.string(),
        title: z.string(),
        location: z.string(),
        remote_hybrid: z.string(),
        posting_url: z.string(),
        total_score: z.number(),
        breakdown: z.record(z.string(), z.any()),
        jd_raw_text: z.string(),
      }),
    ),
    totalScored: z.number(),
    scoringMode: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const mode = getActiveMode();
    const profile = getActiveProfile();
    logger?.info(
      `📊 [scoreJobs] Scoring ${context.jobIds.length} jobs in ${mode} mode (${profile.label})`,
    );

    const inventory = loadInventory();
    const topN = context.topN || 10;

    const scoredJobs: any[] = [];

    for (const jobId of context.jobIds) {
      const result = await query("SELECT * FROM jobs WHERE job_id = $1", [
        jobId,
      ]);
      if (result.rows.length === 0) {
        logger?.warn(`⚠️ [scoreJobs] Job ID ${jobId} not found`);
        continue;
      }
      const job = result.rows[0];
      const { total, breakdown } = scoreSingleJob(job, inventory, profile);

      await query(
        `INSERT INTO scores (job_id, total_score, breakdown_json)
         VALUES ($1, $2, $3)
         ON CONFLICT (job_id) DO UPDATE SET total_score = $2, breakdown_json = $3`,
        [jobId, total, JSON.stringify(breakdown)],
      );

      scoredJobs.push({
        job_id: jobId,
        company: job.company || "",
        title: job.title || "",
        location: job.location || "",
        remote_hybrid: job.remote_hybrid || "",
        posting_url: job.posting_url || "",
        total_score: total,
        breakdown,
        jd_raw_text: job.jd_raw_text || "",
      });

      logger?.info(
        `📊 [scoreJobs] ${job.company} - ${job.title}: ${total}/100 (${mode})`,
      );
    }

    scoredJobs.sort((a, b) => b.total_score - a.total_score);
    const topJobs = scoredJobs.slice(0, topN);

    await query(
      `UPDATE jobs SET status = 'shortlisted' WHERE job_id = ANY($1)`,
      [topJobs.map((j) => j.job_id)],
    );

    logger?.info(
      `✅ [scoreJobs] Top ${topJobs.length} jobs selected. Highest: ${topJobs[0]?.total_score}/100 (${mode})`,
    );

    return {
      scoredJobs: topJobs,
      totalScored: scoredJobs.length,
      scoringMode: mode,
    };
  },
});
