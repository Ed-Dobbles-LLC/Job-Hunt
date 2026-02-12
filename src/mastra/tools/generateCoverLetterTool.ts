import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import { buildEntityAllowlist } from "./entityAllowlist";
import {
  TailoredCoverLetterSchema,
  buildCoverLetterSystemPrompt,
  buildCoverLetterUserPrompt,
  type TailoredCoverLetter,
} from "./tailoredCoverLetterPrompt";
import type { JDRequirements } from "./extractJDRequirementsTool";

function loadInventory(): Record<string, any> {
  try {
    const inventoryPath = workspacePath("experience_inventory.json");
    return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  } catch (err: any) {
    throw new Error(`Cannot load experience_inventory.json: ${err.message}. Run the Profile Builder first.`);
  }
}

/** Lazy OpenAI client — reads API key at call time, not import time */
let _openai: ReturnType<typeof createOpenAI> | null = null;
function getOpenAI() {
  if (!_openai) {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY env var.");
    _openai = createOpenAI({ apiKey });
  }
  return _openai;
}

export const generateCoverLetterTool = createTool({
  id: "generate-cover-letter",
  description:
    "Generates a tailored cover letter JSON (250-350 words) for a specific job posting using LLM. Executive tone with exactly 1-3 specific value claims, each backed by evidence pointers. Never invents metrics. Includes company_research_todo when company context is missing. Uses the experience inventory as the sole source of truth.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to generate cover letter for"),
    company: z.string().optional().describe("Company name (loaded from DB if omitted)"),
    title: z.string().optional().describe("Job title (loaded from DB if omitted)"),
    requirements: z
      .record(z.any())
      .optional()
      .describe("JD requirements object. If omitted, loads from DB."),
    company_context: z
      .string()
      .optional()
      .describe(
        "Any known company info (mission, products, news) to personalize the letter",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    job_id: z.number(),
    cover_letter: TailoredCoverLetterSchema,
    stats: z.object({
      word_count: z.number(),
      value_claims: z.number(),
      evidence_pointers: z.number(),
      gap_notes: z.number(),
      company_research_todos: z.number(),
      model: z.string(),
    }),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(`📝 [generateCoverLetter] Starting cover letter generation for job_id=${context.job_id}`);

    let company = context.company || "";
    let title = context.title || "";
    let requirements: JDRequirements;

    if (context.requirements) {
      requirements = context.requirements as JDRequirements;
      logger?.info(`📝 [generateCoverLetter] Using provided requirements`);
    } else {
      logger?.info(`📝 [generateCoverLetter] Loading job data from DB`);
      const result = await query(
        "SELECT company, title, jd_requirements FROM jobs WHERE job_id = $1",
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
      company = company || result.rows[0].company || "";
      title = title || result.rows[0].title || "";
      requirements = result.rows[0].jd_requirements;
    }

    logger?.info(`📝 [generateCoverLetter] Target: ${company} — ${title}`);
    logger?.info(`📝 [generateCoverLetter] Loading experience inventory and allowlist`);

    const inventory = loadInventory();
    const allowlist = buildEntityAllowlist(inventory);

    const systemPrompt = buildCoverLetterSystemPrompt();
    const userPrompt = buildCoverLetterUserPrompt(
      inventory,
      allowlist,
      requirements,
      title,
      company,
      context.company_context,
    );

    logger?.info(`📝 [generateCoverLetter] Calling LLM with generateObject (gpt-4o)`);
    logger?.info(`📝 [generateCoverLetter] System prompt length: ${systemPrompt.length} chars`);
    logger?.info(`📝 [generateCoverLetter] User prompt length: ${userPrompt.length} chars`);

    const { object: coverLetter } = await generateObject({
      model: getOpenAI()("gpt-4o"),
      schema: TailoredCoverLetterSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.4,
    });

    logger?.info(`✅ [generateCoverLetter] Cover letter generated successfully`);
    logger?.info(`📝 [generateCoverLetter] Word count: ${coverLetter.word_count}`);
    logger?.info(`📝 [generateCoverLetter] Value claims: ${coverLetter.value_claims.length}`);
    logger?.info(`📝 [generateCoverLetter] Evidence pointers: ${coverLetter.evidence_pointers.length}`);
    logger?.info(`📝 [generateCoverLetter] Gap notes: ${coverLetter.gap_notes.length}`);
    logger?.info(`📝 [generateCoverLetter] Research todos: ${coverLetter.company_research_todo.length}`);

    if (coverLetter.value_claims.length > 3) {
      logger?.warn(`⚠️ [generateCoverLetter] WARNING: ${coverLetter.value_claims.length} value claims exceeds max of 3`);
    }
    if (coverLetter.word_count < 250 || coverLetter.word_count > 350) {
      logger?.warn(`⚠️ [generateCoverLetter] WARNING: Word count ${coverLetter.word_count} outside 250-350 range`);
    }

    const stats = {
      word_count: coverLetter.word_count,
      value_claims: coverLetter.value_claims.length,
      evidence_pointers: coverLetter.evidence_pointers.length,
      gap_notes: coverLetter.gap_notes.length,
      company_research_todos: coverLetter.company_research_todo.length,
      model: "gpt-4o",
    };

    try {
      await query(
        `UPDATE scores SET breakdown_json = jsonb_set(
           COALESCE(breakdown_json, '{}'::jsonb),
           '{tailored_cover_letter}',
           $2::jsonb
         ) WHERE job_id = $1`,
        [context.job_id, JSON.stringify({ generated_at: new Date().toISOString(), stats })],
      );
      logger?.info(`💾 [generateCoverLetter] Saved cover letter metadata to DB`);
    } catch (err: any) {
      logger?.error(`⚠️ [generateCoverLetter] Failed to save metadata: ${err.message}`);
    }

    return {
      success: true,
      job_id: context.job_id,
      cover_letter: coverLetter,
      stats,
    };
  },
});
