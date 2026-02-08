import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import { buildEntityAllowlist } from "./entityAllowlist";
import type { JDRequirements, RequirementItem } from "./extractJDRequirementsTool";

function loadInventory(): Record<string, any> {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function findInventoryEvidence(
  keyword: string,
  inventory: Record<string, any>,
): { found: boolean; sources: { id: string; text: string; context: string }[] } {
  const keyNorm = normalize(keyword);
  const sources: { id: string; text: string; context: string }[] = [];

  for (const exp of inventory.experience || []) {
    for (const bullet of exp.bullets || []) {
      const bulletNorm = normalize(bullet.text);
      const toolsNorm = (bullet.tools || []).map((t: string) => normalize(t));
      if (bulletNorm.includes(keyNorm) || toolsNorm.some((t: string) => t.includes(keyNorm) || keyNorm.includes(t))) {
        sources.push({
          id: bullet.id,
          text: bullet.text,
          context: `${exp.employer} — ${exp.title}`,
        });
      }
    }
  }

  const skillCategories = inventory.skills || {};
  for (const [category, skillList] of Object.entries(skillCategories)) {
    for (const skill of (skillList as string[]) || []) {
      if (normalize(skill).includes(keyNorm) || keyNorm.includes(normalize(skill))) {
        sources.push({
          id: `skill-${category}`,
          text: skill,
          context: `Skills > ${category}`,
        });
      }
    }
  }

  return { found: sources.length > 0, sources };
}

const KeywordAnalysisSchema = z.object({
  keyword: z.string(),
  source: z.enum(["must_have", "nice_to_have", "tech_keywords", "keywords_for_ats", "leadership_scope", "domain_context"]),
  confidence: z.number(),
  in_resume: z.boolean(),
  in_inventory: z.boolean(),
  inventory_sources: z.array(z.object({
    id: z.string(),
    text: z.string(),
    context: z.string(),
  })),
  recommendation: z.enum(["already_covered", "add_to_resume", "add_to_skills", "cannot_add", "consider_rephrasing"]),
  suggestion: z.string(),
});

const OptimizationReportSchema = z.object({
  job_id: z.number(),
  company: z.string(),
  title: z.string(),
  overall_ats_score: z.number().describe("0-100 keyword coverage score"),
  total_keywords: z.number(),
  covered_keywords: z.number(),
  uncovered_keywords: z.number(),
  actionable_additions: z.number(),
  keyword_analysis: z.array(KeywordAnalysisSchema),
  priority_actions: z.array(z.object({
    priority: z.enum(["high", "medium", "low"]),
    action: z.string(),
    keyword: z.string(),
    inventory_source: z.string(),
  })),
  coverage_by_category: z.record(z.string(), z.object({
    total: z.number(),
    covered: z.number(),
    percentage: z.number(),
  })),
});

export const atsKeywordOptimizerTool = createTool({
  id: "ats-keyword-optimizer",
  description:
    "Analyzes a generated resume against JD requirements to identify keyword gaps and produce an optimization report. Compares ATS keywords, tech keywords, must-have terms, and nice-to-have terms against the resume text and experience inventory. Returns prioritized actions for improving ATS coverage — only recommending additions that can be truthfully sourced from the inventory.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to optimize for"),
    resume_text: z.string().describe("Full text of the current resume to analyze"),
    requirements: z
      .record(z.any())
      .optional()
      .describe("JD requirements object. If omitted, loads from DB."),
  }),
  outputSchema: OptimizationReportSchema,
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(`🔑 [atsOptimizer] Starting ATS keyword optimization for job_id=${context.job_id}`);

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
    const resumeNorm = normalize(context.resume_text);

    const categoryKeys: string[] = [
      "must_have", "nice_to_have", "tech_keywords", "keywords_for_ats", "leadership_scope", "domain_context",
    ];

    const keywordAnalysis: z.infer<typeof KeywordAnalysisSchema>[] = [];
    const coverageByCategory: Record<string, { total: number; covered: number; percentage: number }> = {};

    for (const category of categoryKeys) {
      const items: RequirementItem[] = (requirements as Record<string, any>)[category] || [];
      let categoryCovered = 0;

      for (const item of items) {
        const keyNorm = normalize(item.text);
        const inResume = resumeNorm.includes(keyNorm) ||
          keyNorm.split(/\s+/).filter(w => w.length > 3).every(w => resumeNorm.includes(w));

        const inventorySearch = findInventoryEvidence(item.text, inventory);

        let recommendation: "already_covered" | "add_to_resume" | "add_to_skills" | "cannot_add" | "consider_rephrasing";
        let suggestion = "";

        if (inResume) {
          recommendation = "already_covered";
          suggestion = "This keyword is already present in the resume.";
          categoryCovered++;
        } else if (inventorySearch.found) {
          const topSource = inventorySearch.sources[0];
          if (category === "tech_keywords") {
            recommendation = "add_to_skills";
            suggestion = `Add "${item.text}" to the skills section. Found in inventory: ${topSource.context} (${topSource.id}).`;
          } else {
            recommendation = "add_to_resume";
            suggestion = `Incorporate "${item.text}" into resume bullets. Evidence available from: ${topSource.context} — "${topSource.text.substring(0, 100)}..."`;
          }
        } else {
          const keyWords = keyNorm.split(/\s+/).filter(w => w.length > 3);
          const partialMatchInInventory = keyWords.some(w => normalize(JSON.stringify(inventory)).includes(w));

          if (partialMatchInInventory) {
            recommendation = "consider_rephrasing";
            suggestion = `No exact match for "${item.text}" but related terms exist in inventory. Consider if a truthful rephrase can incorporate this concept.`;
          } else {
            recommendation = "cannot_add";
            suggestion = `"${item.text}" is not supported by the experience inventory. Cannot be added without fabrication.`;
          }
        }

        keywordAnalysis.push({
          keyword: item.text,
          source: category as any,
          confidence: item.confidence,
          in_resume: inResume,
          in_inventory: inventorySearch.found,
          inventory_sources: inventorySearch.sources.slice(0, 3),
          recommendation,
          suggestion,
        });
      }

      coverageByCategory[category] = {
        total: items.length,
        covered: categoryCovered,
        percentage: items.length > 0 ? Math.round((categoryCovered / items.length) * 100) : 100,
      };
    }

    const totalKeywords = keywordAnalysis.length;
    const coveredKeywords = keywordAnalysis.filter(k => k.in_resume).length;
    const uncoveredKeywords = totalKeywords - coveredKeywords;
    const actionableAdditions = keywordAnalysis.filter(
      k => k.recommendation === "add_to_resume" || k.recommendation === "add_to_skills",
    ).length;
    const overallAtsScore = totalKeywords > 0 ? Math.round((coveredKeywords / totalKeywords) * 100) : 100;

    const priorityActions = keywordAnalysis
      .filter(k => k.recommendation !== "already_covered" && k.recommendation !== "cannot_add")
      .map(k => {
        let priority: "high" | "medium" | "low";
        if (k.source === "must_have" || (k.source === "keywords_for_ats" && k.confidence >= 0.8)) {
          priority = "high";
        } else if (k.source === "tech_keywords" || k.source === "nice_to_have") {
          priority = "medium";
        } else {
          priority = "low";
        }

        return {
          priority,
          action: k.suggestion,
          keyword: k.keyword,
          inventory_source: k.inventory_sources.length > 0 ? k.inventory_sources[0].id : "none",
        };
      })
      .sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.priority] - order[b.priority];
      });

    logger?.info(`✅ [atsOptimizer] ATS Score: ${overallAtsScore}/100 | Covered: ${coveredKeywords}/${totalKeywords} | Actionable: ${actionableAdditions}`);

    return {
      job_id: context.job_id,
      company,
      title,
      overall_ats_score: overallAtsScore,
      total_keywords: totalKeywords,
      covered_keywords: coveredKeywords,
      uncovered_keywords: uncoveredKeywords,
      actionable_additions: actionableAdditions,
      keyword_analysis: keywordAnalysis,
      priority_actions: priorityActions,
      coverage_by_category: coverageByCategory,
    };
  },
});
