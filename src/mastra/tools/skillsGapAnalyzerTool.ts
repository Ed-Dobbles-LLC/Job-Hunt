import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import type { JDRequirements, RequirementItem } from "./extractJDRequirementsTool";

function loadInventory(): Record<string, any> {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

interface SkillMatch {
  requirement: string;
  confidence: number;
  category: string;
  match_type: "exact" | "strong" | "partial" | "none";
  match_strength: number;
  matched_skills: string[];
  matched_bullets: { id: string; text: string; employer: string }[];
  years_of_evidence: number;
  recommendation: string;
}

function computeYearsOfEvidence(
  keyword: string,
  inventory: Record<string, any>,
): number {
  const keyNorm = normalize(keyword);
  const years = new Set<string>();

  for (const exp of inventory.experience || []) {
    for (const bullet of exp.bullets || []) {
      const bulletNorm = normalize(bullet.text);
      const toolsNorm = (bullet.tools || []).map((t: string) => normalize(t));
      if (
        bulletNorm.includes(keyNorm) ||
        toolsNorm.some((t: string) => t.includes(keyNorm) || keyNorm.includes(t))
      ) {
        if (exp.start_date) years.add(exp.start_date.substring(0, 4));
        if (exp.end_date && exp.end_date !== "present") years.add(exp.end_date.substring(0, 4));
        if (exp.end_date === "present") years.add(new Date().getFullYear().toString());
      }
    }
  }

  if (years.size === 0) return 0;
  const sortedYears = [...years].sort();
  const firstYear = parseInt(sortedYears[0]);
  const lastYear = parseInt(sortedYears[sortedYears.length - 1]);
  return lastYear - firstYear + 1;
}

function findMatchingSkills(
  requirement: string,
  inventory: Record<string, any>,
): { skills: string[]; bullets: { id: string; text: string; employer: string }[] } {
  const reqNorm = normalize(requirement);
  const reqWords = reqNorm.split(/\s+/).filter(w => w.length > 3);

  const skills: string[] = [];
  const bullets: { id: string; text: string; employer: string }[] = [];

  const skillCategories = inventory.skills || {};
  for (const [, skillList] of Object.entries(skillCategories)) {
    for (const skill of (skillList as string[]) || []) {
      const skillNorm = normalize(skill);
      if (skillNorm.includes(reqNorm) || reqNorm.includes(skillNorm) ||
          reqWords.some(w => skillNorm.includes(w))) {
        skills.push(skill);
      }
    }
  }

  for (const exp of inventory.experience || []) {
    for (const bullet of exp.bullets || []) {
      const bulletNorm = normalize(bullet.text);
      const toolsNorm = (bullet.tools || []).map((t: string) => normalize(t));
      const metricsNorm = (bullet.metrics || []).map((m: string) => normalize(m));
      if (
        bulletNorm.includes(reqNorm) ||
        reqNorm.includes(bulletNorm) ||
        toolsNorm.some((t: string) => t.includes(reqNorm) || reqNorm.includes(t)) ||
        reqWords.filter(w => w.length > 4).every(w => bulletNorm.includes(w) || toolsNorm.some((t: string) => t.includes(w)))
      ) {
        bullets.push({ id: bullet.id, text: bullet.text, employer: exp.employer });
      }
    }
  }

  return { skills, bullets };
}

function classifyMatch(
  skills: string[],
  bullets: { id: string; text: string; employer: string }[],
  requirement: string,
): { type: "exact" | "strong" | "partial" | "none"; strength: number } {
  if (skills.length > 0 && bullets.length >= 2) {
    return { type: "exact", strength: 1.0 };
  }
  if (bullets.length >= 2 || (skills.length > 0 && bullets.length >= 1)) {
    return { type: "strong", strength: 0.8 };
  }
  if (bullets.length === 1 || skills.length > 0) {
    return { type: "partial", strength: 0.5 };
  }
  return { type: "none", strength: 0.0 };
}

const SkillMatchSchema = z.object({
  requirement: z.string(),
  confidence: z.number(),
  category: z.string(),
  match_type: z.enum(["exact", "strong", "partial", "none"]),
  match_strength: z.number(),
  matched_skills: z.array(z.string()),
  matched_bullets: z.array(z.object({
    id: z.string(),
    text: z.string(),
    employer: z.string(),
  })),
  years_of_evidence: z.number(),
  recommendation: z.string(),
});

const GapReportSchema = z.object({
  job_id: z.number(),
  company: z.string(),
  title: z.string(),
  overall_fit_score: z.number(),
  total_requirements: z.number(),
  strengths: z.array(SkillMatchSchema),
  partial_matches: z.array(SkillMatchSchema),
  gaps: z.array(SkillMatchSchema),
  summary: z.object({
    strong_match_count: z.number(),
    partial_match_count: z.number(),
    gap_count: z.number(),
    must_have_coverage: z.number(),
    nice_to_have_coverage: z.number(),
    tech_coverage: z.number(),
    leadership_coverage: z.number(),
  }),
  talking_points: z.array(z.string()).describe("Suggested talking points for interviews based on strengths"),
  development_areas: z.array(z.string()).describe("Skills to develop based on identified gaps"),
});

export const skillsGapAnalyzerTool = createTool({
  id: "skills-gap-analyzer",
  description:
    "Performs a deep comparison between the experience inventory and job requirements to produce a comprehensive skills gap report. Identifies exact matches, partial matches, and gaps across all requirement categories. Returns prioritized strengths (talking points for interviews), partial matches (areas to emphasize), and gaps (development areas). All analysis is deterministic — no LLM calls.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to analyze"),
    requirements: z
      .record(z.any())
      .optional()
      .describe("JD requirements object. If omitted, loads from DB."),
  }),
  outputSchema: GapReportSchema,
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(`🔍 [skillsGap] Starting skills gap analysis for job_id=${context.job_id}`);

    let company = "";
    let title = "";
    let requirements: JDRequirements;

    if (context.requirements) {
      requirements = context.requirements as JDRequirements;
    } else {
      const result = await query(
        "SELECT company, title, jd_requirements FROM jobs WHERE job_id = $1",
        [context.job_id],
      );
      if (result.rows.length === 0) {
        throw new Error(`Job ID ${context.job_id} not found in database`);
      }
      if (!result.rows[0].jd_requirements) {
        throw new Error(`Job ID ${context.job_id} has no extracted requirements.`);
      }
      company = result.rows[0].company || "";
      title = result.rows[0].title || "";
      requirements = result.rows[0].jd_requirements;
    }

    const inventory = loadInventory();

    const categoryKeys: string[] = [
      "must_have", "nice_to_have", "tech_keywords", "leadership_scope", "domain_context",
    ];

    const allMatches: SkillMatch[] = [];

    for (const category of categoryKeys) {
      const items: RequirementItem[] = (requirements as Record<string, any>)[category] || [];

      for (const item of items) {
        const { skills, bullets } = findMatchingSkills(item.text, inventory);
        const { type, strength } = classifyMatch(skills, bullets, item.text);
        const yearsEvidence = computeYearsOfEvidence(item.text, inventory);

        let recommendation = "";
        switch (type) {
          case "exact":
            recommendation = `Strong match — ${bullets.length} supporting bullets across ${new Set(bullets.map(b => b.employer)).size} role(s). ${yearsEvidence > 0 ? `${yearsEvidence}+ years of evidence.` : ""} Lead with this in interviews.`;
            break;
          case "strong":
            recommendation = `Good match with supporting evidence. Emphasize relevant bullets in resume and prepare concrete examples for interviews.`;
            break;
          case "partial":
            recommendation = `Partial match — related experience exists but not a direct hit. Frame transferable skills and highlight adjacent experience.`;
            break;
          case "none":
            recommendation = `Gap — no direct evidence in inventory. ${category === "must_have" ? "This is a must-have requirement; consider whether to address in cover letter as a development area." : "Consider if transferable skills from other domains could apply."}`;
            break;
        }

        allMatches.push({
          requirement: item.text,
          confidence: item.confidence,
          category,
          match_type: type,
          match_strength: strength,
          matched_skills: skills.slice(0, 5),
          matched_bullets: bullets.slice(0, 3),
          years_of_evidence: yearsEvidence,
          recommendation,
        });
      }
    }

    const strengths = allMatches.filter(m => m.match_type === "exact" || m.match_type === "strong");
    const partialMatches = allMatches.filter(m => m.match_type === "partial");
    const gaps = allMatches.filter(m => m.match_type === "none");

    const mustHaveItems = allMatches.filter(m => m.category === "must_have");
    const niceToHaveItems = allMatches.filter(m => m.category === "nice_to_have");
    const techItems = allMatches.filter(m => m.category === "tech_keywords");
    const leadershipItems = allMatches.filter(m => m.category === "leadership_scope");

    const categoryCoverage = (items: SkillMatch[]) =>
      items.length > 0
        ? Math.round((items.filter(i => i.match_type !== "none").length / items.length) * 100)
        : 100;

    const totalWeightedScore =
      allMatches.reduce((sum, m) => {
        const categoryWeight = m.category === "must_have" ? 2.0 : m.category === "tech_keywords" ? 1.5 : 1.0;
        return sum + m.match_strength * categoryWeight * m.confidence;
      }, 0);
    const maxWeightedScore =
      allMatches.reduce((sum, m) => {
        const categoryWeight = m.category === "must_have" ? 2.0 : m.category === "tech_keywords" ? 1.5 : 1.0;
        return sum + 1.0 * categoryWeight * m.confidence;
      }, 0);
    const overallFitScore = maxWeightedScore > 0 ? Math.round((totalWeightedScore / maxWeightedScore) * 100) : 0;

    const talkingPoints = strengths
      .sort((a, b) => b.match_strength - a.match_strength)
      .slice(0, 5)
      .map(s => {
        const bulletSnippet = s.matched_bullets.length > 0
          ? ` Evidence: "${s.matched_bullets[0].text.substring(0, 80)}..." (${s.matched_bullets[0].employer})`
          : "";
        return `${s.requirement}: ${s.matched_skills.length > 0 ? s.matched_skills.join(", ") : "demonstrated in experience"}.${bulletSnippet}`;
      });

    const developmentAreas = gaps
      .filter(g => g.category === "must_have" || g.category === "tech_keywords")
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(g => `${g.requirement} (${g.category.replace("_", " ")}, confidence: ${g.confidence})`);

    logger?.info(`✅ [skillsGap] Fit score: ${overallFitScore}/100 | Strengths: ${strengths.length} | Partial: ${partialMatches.length} | Gaps: ${gaps.length}`);

    return {
      job_id: context.job_id,
      company,
      title,
      overall_fit_score: overallFitScore,
      total_requirements: allMatches.length,
      strengths,
      partial_matches: partialMatches,
      gaps,
      summary: {
        strong_match_count: strengths.length,
        partial_match_count: partialMatches.length,
        gap_count: gaps.length,
        must_have_coverage: categoryCoverage(mustHaveItems),
        nice_to_have_coverage: categoryCoverage(niceToHaveItems),
        tech_coverage: categoryCoverage(techItems),
        leadership_coverage: categoryCoverage(leadershipItems),
      },
      talking_points: talkingPoints,
      development_areas: developmentAreas,
    };
  },
});
