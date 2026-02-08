import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import { buildEntityAllowlist } from "./entityAllowlist";
import {
  TailoredResumeSchema,
  type TailoredResume,
} from "./tailoredResumePrompt";
import type { JDRequirements } from "./extractJDRequirementsTool";

function loadInventory(): Record<string, any> {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const RESUME_STYLES = {
  chronological: {
    label: "Chronological",
    description: "Traditional reverse-chronological format. Experience ordered by date (most recent first). Best for stable career progression.",
    instructions: `Order experience entries strictly by date (most recent first).
Focus on career progression and tenure.
Professional summary should emphasize years of experience and career trajectory.
Bullets should highlight growth and increasing responsibility over time.
Include all roles, even if less relevant, to show a complete career timeline.`,
  },
  functional: {
    label: "Functional / Skills-Based",
    description: "Groups achievements by skill category rather than employer. Best for career changers or when highlighting transferable skills.",
    instructions: `Order experience entries by RELEVANCE to the target role, not by date.
Professional summary should lead with the most relevant skill domains.
Bullets should be selected and grouped to showcase skill clusters (e.g., "Data Strategy", "Team Leadership", "Technical Architecture").
Prioritize bullets that demonstrate transferable capabilities over role-specific duties.
De-emphasize dates and focus on skill depth across multiple roles.`,
  },
  hybrid: {
    label: "Hybrid / Combination",
    description: "Combines chronological structure with skills-based emphasis. Best for experienced professionals targeting specific roles.",
    instructions: `Order experience entries by RELEVANCE first, then by recency as a tiebreaker.
Professional summary should blend skill highlights with career scope.
For the top 2 most relevant roles, select bullets that best match the JD requirements.
For remaining roles, include 2-3 high-impact bullets focusing on transferable results.
Skills section should be prominently positioned and categorized by relevance to the target role.`,
  },
  executive: {
    label: "Executive Brief",
    description: "Concise leadership-focused format. Emphasizes P&L, team size, strategic impact, and transformation outcomes. Best for C-suite and VP roles.",
    instructions: `Professional summary should read as an executive value proposition (4 sentences max).
Lead with scope: team size, budget, revenue responsibility, org breadth.
Order experience by strategic impact and leadership scope, not just dates.
Bullets should prioritize: business outcomes ($, %, revenue), organizational transformation, team building, and cross-functional leadership.
Minimize technical tool references — focus on WHAT was achieved, not HOW.
Each role should have 3-4 high-impact bullets max, no tactical details.
Skills section should emphasize leadership capabilities and strategic competencies over technical tools.`,
  },
} as const;

export type ResumeStyle = keyof typeof RESUME_STYLES;

export const resumeStyleSelectorTool = createTool({
  id: "resume-style-selector",
  description:
    "Generates a tailored resume using a specific style format (chronological, functional, hybrid, or executive). Each style rearranges sections and emphasis differently while maintaining truthfulness guarantees. Uses the same evidence pointer system as the standard resume generator.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to generate resume for"),
    style: z
      .enum(["chronological", "functional", "hybrid", "executive"])
      .describe(
        "Resume style: 'chronological' (date-ordered), 'functional' (skills-based), 'hybrid' (relevance + skills), 'executive' (leadership-focused brief)",
      ),
    company: z.string().optional().describe("Company name (loaded from DB if omitted)"),
    title: z.string().optional().describe("Job title (loaded from DB if omitted)"),
    requirements: z
      .record(z.any())
      .optional()
      .describe("JD requirements object. If omitted, loads from DB."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    job_id: z.number(),
    style: z.string(),
    style_label: z.string(),
    style_description: z.string(),
    resume: TailoredResumeSchema,
    stats: z.object({
      total_bullets: z.number(),
      evidence_pointers: z.number(),
      gap_notes: z.number(),
      ats_keywords: z.number(),
      model: z.string(),
    }),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const style = context.style as ResumeStyle;
    const styleConfig = RESUME_STYLES[style];

    logger?.info(`🎨 [resumeStyleSelector] Generating ${styleConfig.label} resume for job_id=${context.job_id}`);

    let company = context.company || "";
    let title = context.title || "";
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
        throw new Error(`Job ID ${context.job_id} has no extracted requirements. Run extract-jd-requirements first.`);
      }
      company = company || result.rows[0].company || "";
      title = title || result.rows[0].title || "";
      requirements = result.rows[0].jd_requirements;
    }

    const inventory = loadInventory();
    const allowlist = buildEntityAllowlist(inventory);

    const systemPrompt = `You are a precision resume-tailoring engine. You produce a JSON object conforming to the TailoredResume schema.

## RESUME STYLE: ${styleConfig.label.toUpperCase()}
${styleConfig.description}

## STYLE-SPECIFIC INSTRUCTIONS
${styleConfig.instructions}

## ABSOLUTE RULES — VIOLATION = IMMEDIATE REJECTION

1. **ENTITY ALLOWLIST LOCK-DOWN**
   You will receive an EntityAllowlist. Every employer, title, date, location, degree, certification, tool name, metric number, and skill you emit MUST appear in that allowlist.

2. **EVIDENCE ON EVERY BULLET**
   Every bullet in the experience section MUST include source_hash (inventory bullet ID) and evidence_quote (verbatim snippet from that inventory bullet).
   If you cannot find a source for a bullet, DELETE the bullet.

3. **REJECT, DON'T FABRICATE**
   If a JD requirement cannot be supported by the inventory, add a gap_note entry. NEVER invent experience.

4. **NUMBERS ARE SACRED**
   Copy every number, dollar amount, percentage, and metric EXACTLY from the inventory.

5. **ATS-FRIENDLY FORMAT**
   No tables, no columns, no graphics. Plain sections with standard action-verb bullets.

6. **EVIDENCE POINTERS ARRAY**
   One evidence_pointers entry per resume bullet. Confidence >= 0.7 for all pointers.

7. **OUTPUT**
   Return ONLY the JSON object. No markdown fences, no commentary.`;

    const userPrompt = `Generate a ${styleConfig.label} TailoredResume JSON for the following application.

## TARGET ROLE
Title: ${title}
Company: ${company}

## JOB REQUIREMENTS
${JSON.stringify(requirements, null, 2)}

## EXPERIENCE INVENTORY (your ONLY source of truth)
${JSON.stringify(inventory, null, 2)}

## ENTITY ALLOWLIST (every entity you emit must appear here)
${JSON.stringify(allowlist, null, 2)}

## STYLE INSTRUCTIONS
${styleConfig.instructions}

## INSTRUCTIONS
1. Apply the ${styleConfig.label} style format to the resume structure.
2. Select the most relevant experience bullets from the inventory.
3. Tailor bullet wording to emphasize JD-relevant impact, but keep ALL entities and metrics verbatim.
4. For each requirement you CANNOT support, add a gap_note.
5. Include ats_keywords_used listing JD keywords you intentionally wove in.
6. Return ONLY the TailoredResume JSON.`;

    logger?.info(`🎨 [resumeStyleSelector] Calling LLM with ${style} style`);

    const { object: resume } = await generateObject({
      model: openai("gpt-4o"),
      schema: TailoredResumeSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.3,
    });

    const totalBullets = resume.experience.reduce(
      (sum, exp) => sum + exp.bullets.length,
      0,
    );

    logger?.info(`✅ [resumeStyleSelector] ${styleConfig.label} resume generated`);
    logger?.info(`🎨 [resumeStyleSelector] Bullets: ${totalBullets}, Evidence: ${resume.evidence_pointers.length}, Gaps: ${resume.gap_notes.length}`);

    const stats = {
      total_bullets: totalBullets,
      evidence_pointers: resume.evidence_pointers.length,
      gap_notes: resume.gap_notes.length,
      ats_keywords: resume.ats_keywords_used.length,
      model: "gpt-4o",
    };

    return {
      success: true,
      job_id: context.job_id,
      style,
      style_label: styleConfig.label,
      style_description: styleConfig.description,
      resume,
      stats,
    };
  },
});

export { RESUME_STYLES };
