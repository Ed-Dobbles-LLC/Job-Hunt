import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import { buildEntityAllowlist } from "./entityAllowlist";
import type { JDRequirements } from "./extractJDRequirementsTool";

function loadInventory(): Record<string, any> {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const SUMMARY_TONES = {
  executive: {
    label: "Executive / C-Suite",
    instructions: `Write as a senior executive addressing a board or executive committee.
Lead with scope: P&L responsibility, org size, strategic impact.
Emphasize transformation, vision, and business outcomes.
Tone: authoritative, concise, high-altitude. 3-4 sentences max.
Example opening: "Data & Analytics executive with 15+ years driving..."`,
  },
  technical_leader: {
    label: "Technical Leader",
    instructions: `Write as a hands-on technical leader who bridges engineering and strategy.
Lead with technical depth: platforms built, architectures designed, teams scaled.
Emphasize both technical prowess and leadership capability.
Tone: knowledgeable, precise, engineering-minded. 3-4 sentences.
Example opening: "Technical leader with deep expertise in modern data architectures..."`,
  },
  transformation_agent: {
    label: "Transformation Agent",
    instructions: `Write as a change agent who transforms organizations.
Lead with before/after: what was broken, what you built, what changed.
Emphasize modernization, culture change, and measurable transformation outcomes.
Tone: dynamic, results-oriented, forward-looking. 3-4 sentences.
Example opening: "Proven transformation leader who modernized data capabilities from..."`,
  },
  data_strategist: {
    label: "Data Strategist",
    instructions: `Write as a strategic thinker who connects data to business value.
Lead with strategy: data-driven decision-making, analytics maturity, business intelligence.
Emphasize: strategy development, cross-functional alignment, analytics ROI.
Tone: thoughtful, business-savvy, consultative. 3-4 sentences.
Example opening: "Analytics strategist who builds data organizations that deliver..."`,
  },
  people_leader: {
    label: "People Leader",
    instructions: `Write as a leader who builds and develops high-performing teams.
Lead with people: team building, talent development, culture creation.
Emphasize: hiring, mentoring, org design, team performance, retention.
Tone: warm but authoritative, people-first. 3-4 sentences.
Example opening: "People-first data leader who has built and scaled teams from..."`,
  },
} as const;

export type SummaryTone = keyof typeof SUMMARY_TONES;

const SummaryVariantSchema = z.object({
  tone: z.string(),
  tone_label: z.string(),
  summary_text: z.string(),
  word_count: z.number(),
  key_themes: z.array(z.string()).describe("Top 3 themes emphasized in this variant"),
  evidence_ids: z.array(z.string()).describe("Inventory IDs referenced in this summary"),
});

export const resumeSummaryVariantsTool = createTool({
  id: "resume-summary-variants",
  description:
    "Generates multiple professional summary variants for a resume, each with a different tone and emphasis (executive, technical leader, transformation agent, data strategist, people leader). All variants use only facts from the experience inventory. Returns 3-5 summary options so the user can choose the best fit for each application.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID for context"),
    tones: z
      .array(z.enum(["executive", "technical_leader", "transformation_agent", "data_strategist", "people_leader"]))
      .min(1)
      .max(5)
      .default(["executive", "technical_leader", "transformation_agent"])
      .describe("Which summary tones to generate"),
    company: z.string().optional(),
    title: z.string().optional(),
    requirements: z.record(z.any()).optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    variants: z.array(SummaryVariantSchema),
    total_variants: z.number(),
    model: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(`📝 [summaryVariants] Generating ${context.tones.length} summary variants for job_id=${context.job_id}`);

    let company = context.company || "";
    let title = context.title || "";
    let requirements: JDRequirements | null = null;

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
      company = company || result.rows[0].company || "";
      title = title || result.rows[0].title || "";
      requirements = result.rows[0].jd_requirements || null;
    }

    const inventory = loadInventory();
    const allowlist = buildEntityAllowlist(inventory);

    const toneInstructions = context.tones.map((tone: string) => {
      const config = SUMMARY_TONES[tone as SummaryTone];
      return `### ${config.label} (tone: "${tone}")
${config.instructions}`;
    }).join("\n\n");

    const systemPrompt = `You are a precision resume summary writer. You produce professional summary variants — each with a distinct tone and emphasis — for the same candidate targeting the same role.

## ABSOLUTE RULES
1. Every fact (employer, title, date, metric, tool, team size) MUST come from the provided inventory and allowlist.
2. NEVER invent, embellish, or fabricate ANY facts.
3. Numbers must be copied EXACTLY from the inventory.
4. Each summary must be 3-4 sentences (50-80 words).
5. Each variant should feel distinctly different in tone and emphasis while remaining factually identical.
6. Track which inventory IDs you reference in each summary.`;

    const userPrompt = `Generate professional summary variants for the following application.

## TARGET
Title: ${title}
Company: ${company}

${requirements ? `## JOB REQUIREMENTS\n${JSON.stringify(requirements, null, 2)}` : ""}

## EXPERIENCE INVENTORY (your ONLY source of truth)
${JSON.stringify(inventory, null, 2)}

## ENTITY ALLOWLIST
${JSON.stringify(allowlist, null, 2)}

## SUMMARY TONES TO GENERATE
${toneInstructions}

For each tone, produce:
- tone: the tone key
- tone_label: the display label
- summary_text: the 3-4 sentence professional summary
- word_count: exact word count
- key_themes: top 3 themes emphasized
- evidence_ids: inventory IDs referenced (e.g., ["exp-001-b1", "exp-002-b3"])

Return ONLY the JSON.`;

    const ResultSchema = z.object({
      variants: z.array(SummaryVariantSchema),
    });

    const { object: result } = await generateObject({
      model: openai("gpt-4o"),
      schema: ResultSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.5,
    });

    logger?.info(`✅ [summaryVariants] Generated ${result.variants.length} summary variants`);
    for (const v of result.variants) {
      logger?.info(`  📝 ${v.tone_label}: ${v.word_count} words, themes: ${v.key_themes.join(", ")}`);
    }

    return {
      success: true,
      job_id: context.job_id,
      company,
      title,
      variants: result.variants,
      total_variants: result.variants.length,
      model: "gpt-4o",
    };
  },
});

export { SUMMARY_TONES };
