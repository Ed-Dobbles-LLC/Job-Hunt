import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";
import { SPEC_INFLATION_CONFIG } from "./scoringConfig";

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

function scoreSingleJob(
  job: any,
  inventory: any,
): { total: number; breakdown: Record<string, any> } {
  const jd = (job.jd_raw_text || "").toLowerCase();
  const title = (job.title || "").toLowerCase();
  const location = (job.location || "").toLowerCase();
  const remoteHybrid = (job.remote_hybrid || "").toLowerCase();

  const breakdown: Record<string, number> = {};

  const vpKeywords = ["vp", "vice president", "head of", "chief", "cdo"];
  const dirKeywords = ["director", "senior director"];
  const managerKeywords = ["manager", "lead"];
  if (vpKeywords.some((kw) => title.includes(kw))) {
    breakdown.role_level_match = 25;
  } else if (dirKeywords.some((kw) => title.includes(kw))) {
    breakdown.role_level_match = 20;
  } else if (managerKeywords.some((kw) => title.includes(kw))) {
    breakdown.role_level_match = 10;
  } else {
    breakdown.role_level_match = 5;
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
  breakdown.leadership_scope = Math.min(15, Math.round((leadershipCount / 4) * 15));

  const domains = inventory.skills?.domains || [];
  const domainMatch = domains.filter((d: string) =>
    jd.includes(d.toLowerCase()),
  ).length;
  breakdown.domain_relevance = Math.min(10, Math.round((domainMatch / 2) * 10));

  const techSkills = inventory.skills?.technical || [];
  const dsSkills = inventory.skills?.data_science || [];
  const allTech = [...techSkills, ...dsSkills];
  const techMatch = allTech.filter((t: string) =>
    jd.includes(t.toLowerCase()),
  ).length;
  breakdown.data_ai_stack_match = Math.min(15, Math.round((techMatch / 5) * 15));

  const preferredLocations = ["chicago", "remote", "hybrid"];
  const locationMatch = preferredLocations.some(
    (loc) => location.includes(loc) || remoteHybrid.includes(loc),
  );
  breakdown.location_fit = locationMatch ? 10 : 3;

  const compText = jd.match(
    /\$[\d,]+\s*[-–]\s*\$[\d,]+/,
  );
  if (compText) {
    const numbers = compText[0].match(/[\d,]+/g) || [];
    const high = parseInt(numbers[numbers.length - 1]?.replace(/,/g, "") || "0");
    if (high >= 300000) breakdown.compensation = 10;
    else if (high >= 250000) breakdown.compensation = 8;
    else if (high >= 200000) breakdown.compensation = 6;
    else if (high >= 150000) breakdown.compensation = 4;
    else breakdown.compensation = 2;
  } else {
    breakdown.compensation = 5;
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
  breakdown.transformation_mandate = Math.min(10, Math.round((transformCount / 3) * 10));

  const companyPrefSignals = [
    "series",
    "fortune",
    "growth",
    "innovative",
    "leading",
  ];
  const prefCount = companyPrefSignals.filter((s) => jd.includes(s)).length;
  breakdown.company_preference = Math.min(5, Math.round((prefCount / 2) * 5));

  const execMode = classifyExecutionMode(jd);
  breakdown.execution_mode_match = execMode.score;
  breakdown.execution_mode_reason = execMode.reason as any;

  const specInflation = computeSpecInflationPenalty(jd);
  breakdown.spec_inflation_penalty = specInflation.score;
  breakdown.spec_inflation_reason = specInflation.reason as any;

  const total = Object.entries(breakdown).reduce((sum, [key, v]) => {
    if (key === "execution_mode_reason" || key === "spec_inflation_reason") return sum;
    return sum + (v as number);
  }, 0);

  return { total, breakdown };
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
        breakdown: z.record(z.string(), z.number()),
        jd_raw_text: z.string(),
      }),
    ),
    totalScored: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `📊 [scoreJobs] Scoring ${context.jobIds.length} jobs`,
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
      const { total, breakdown } = scoreSingleJob(job, inventory);

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
        `📊 [scoreJobs] ${job.company} - ${job.title}: ${total}/100`,
      );
    }

    scoredJobs.sort((a, b) => b.total_score - a.total_score);
    const topJobs = scoredJobs.slice(0, topN);

    await query(
      `UPDATE jobs SET status = 'shortlisted' WHERE job_id = ANY($1)`,
      [topJobs.map((j) => j.job_id)],
    );

    logger?.info(
      `✅ [scoreJobs] Top ${topJobs.length} jobs selected. Highest: ${topJobs[0]?.total_score}/100`,
    );

    return {
      scoredJobs: topJobs,
      totalScored: scoredJobs.length,
    };
  },
});
