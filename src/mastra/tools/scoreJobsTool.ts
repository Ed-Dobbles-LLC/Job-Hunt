import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";

function loadInventory(): any {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

function scoreSingleJob(
  job: any,
  inventory: any,
): { total: number; breakdown: Record<string, number> } {
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

  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

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
