import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { buildEntityAllowlist } from "./entityAllowlist";

function loadInventory(): Record<string, any> {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const EMPHASIS_MODES = {
  quantitative: {
    label: "Quantitative / Metrics-Forward",
    instructions: `Lead every bullet with a measurable outcome or metric from the inventory.
Structure: [Metric/Number] + [Action] + [Context]
Example pattern: "Drove $12M in annual savings by redesigning..."
Front-load dollar amounts, percentages, team sizes, and quantities.
If a bullet has multiple metrics, lead with the most impressive one.
Every number must come EXACTLY from the inventory — never combine, round, or infer.`,
  },
  leadership: {
    label: "Leadership / People-Forward",
    instructions: `Lead every bullet with team leadership, org building, or people impact.
Structure: [Leadership action] + [Scope/Team] + [Outcome]
Example pattern: "Led a 45-person cross-functional organization to deliver..."
Emphasize: team building, hiring, mentoring, cross-functional alignment, executive stakeholder management.
Include team sizes and org scope when available in inventory.
Frame technical achievements through the lens of leading others to achieve them.`,
  },
  technical: {
    label: "Technical / Architecture-Forward",
    instructions: `Lead every bullet with the technical solution, platform, or architecture.
Structure: [Technical approach/tool] + [Application] + [Business result]
Example pattern: "Architected a Snowflake-based analytics platform that..."
Emphasize: specific technologies, architectural decisions, system design, data pipelines, ML models.
Name specific tools and platforms from the inventory.
Position technical depth as the driver of business outcomes.`,
  },
  strategic: {
    label: "Strategic / Business Impact-Forward",
    instructions: `Lead every bullet with the strategic business impact or transformation.
Structure: [Strategic outcome] + [How you drove it] + [Measurable result]
Example pattern: "Transformed the company's data strategy from reactive reporting to predictive analytics..."
Emphasize: business transformation, strategic vision, competitive advantage, market impact, P&L impact.
Frame everything as strategic decisions that drove business value.
Minimize tactical details — focus on the "what" and "why", not the "how".`,
  },
} as const;

export type EmphasisMode = keyof typeof EMPHASIS_MODES;

const RewrittenBulletSchema = z.object({
  original_text: z.string(),
  rewritten_text: z.string(),
  source_hash: z.string().describe("Inventory bullet ID this was derived from"),
  evidence_quote: z.string().describe("Verbatim quote from inventory"),
  emphasis_applied: z.string(),
  changes_made: z.string().describe("Brief explanation of what changed"),
});

export const bulletRewriterTool = createTool({
  id: "bullet-rewriter",
  description:
    "Rewrites resume bullets with a specific emphasis mode (quantitative, leadership, technical, or strategic) while maintaining strict truthfulness. Takes existing resume bullets with their source IDs and rewrites them to lead with the chosen emphasis. Every rewritten bullet maintains its evidence pointer and uses only facts from the experience inventory.",
  inputSchema: z.object({
    bullets: z
      .array(
        z.object({
          text: z.string().describe("Current bullet text"),
          source_hash: z.string().describe("Inventory bullet ID (e.g., exp-001-b2)"),
          evidence_quote: z.string().describe("Original inventory quote"),
        }),
      )
      .min(1)
      .max(20)
      .describe("Resume bullets to rewrite"),
    emphasis: z
      .enum(["quantitative", "leadership", "technical", "strategic"])
      .describe("Emphasis mode for the rewrite"),
    target_role: z.string().optional().describe("Target job title for context"),
    target_company: z.string().optional().describe("Target company for context"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    emphasis: z.string(),
    emphasis_label: z.string(),
    total_bullets: z.number(),
    rewritten_bullets: z.array(RewrittenBulletSchema),
    model: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const emphasis = context.emphasis as EmphasisMode;
    const emphasisConfig = EMPHASIS_MODES[emphasis];

    logger?.info(`✏️ [bulletRewriter] Rewriting ${context.bullets.length} bullets with ${emphasisConfig.label} emphasis`);

    const inventory = loadInventory();
    const allowlist = buildEntityAllowlist(inventory);

    const systemPrompt = `You are a precision resume bullet rewriter. You rewrite resume bullets with a specific emphasis while maintaining ABSOLUTE truthfulness.

## EMPHASIS MODE: ${emphasisConfig.label.toUpperCase()}
${emphasisConfig.instructions}

## ABSOLUTE RULES
1. Every entity (employer, title, date, tool, number, metric) MUST come from the provided inventory and allowlist. DO NOT change any named entity or metric.
2. You may rephrase sentence structure and reorder clauses, but NEVER change the facts.
3. Each rewritten bullet must remain truthful to its source inventory bullet.
4. Numbers are sacred — copy them EXACTLY. No rounding, combining, or approximating.
5. The rewritten bullet should be a single sentence, action-verb led, suitable for a resume.
6. If a bullet cannot be meaningfully rewritten for this emphasis (e.g., no metrics available for quantitative mode), make minimal changes and note this in changes_made.`;

    const userPrompt = `Rewrite the following resume bullets using ${emphasisConfig.label} emphasis.

## BULLETS TO REWRITE
${context.bullets.map((b, i) => `
### Bullet ${i + 1}
- Current text: "${b.text}"
- Source ID: ${b.source_hash}
- Inventory evidence: "${b.evidence_quote}"
`).join("\n")}

## TARGET CONTEXT
${context.target_role ? `Role: ${context.target_role}` : ""}
${context.target_company ? `Company: ${context.target_company}` : ""}

## ENTITY ALLOWLIST
${JSON.stringify(allowlist, null, 2)}

## EMPHASIS INSTRUCTIONS
${emphasisConfig.instructions}

For each bullet, return:
- original_text: the input text exactly as provided
- rewritten_text: the rewritten version with ${emphasis} emphasis
- source_hash: the same source_hash from input
- evidence_quote: the same evidence_quote from input
- emphasis_applied: "${emphasis}"
- changes_made: brief description of what you changed

Return ONLY the JSON array.`;

    const ResultSchema = z.object({
      rewritten_bullets: z.array(RewrittenBulletSchema),
    });

    const { object: result } = await generateObject({
      model: openai("gpt-4o"),
      schema: ResultSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.3,
    });

    logger?.info(`✅ [bulletRewriter] Rewrote ${result.rewritten_bullets.length} bullets with ${emphasisConfig.label} emphasis`);

    return {
      success: true,
      emphasis,
      emphasis_label: emphasisConfig.label,
      total_bullets: result.rewritten_bullets.length,
      rewritten_bullets: result.rewritten_bullets,
      model: "gpt-4o",
    };
  },
});

export { EMPHASIS_MODES };
