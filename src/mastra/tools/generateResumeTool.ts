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
  buildResumeSystemPrompt,
  buildResumeUserPrompt,
  type TailoredResume,
} from "./tailoredResumePrompt";
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

export const generateResumeTool = createTool({
  id: "generate-resume",
  description:
    "Generates a tailored ATS-friendly resume JSON for a specific job posting using LLM. Loads the experience inventory and entity allowlist, builds a structured prompt, and returns a TailoredResume JSON with evidence pointers on every bullet and gap_notes for unsupported requirements. Only uses facts from the experience inventory — never invents content.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to generate resume for"),
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
    logger?.info(`📄 [generateResume] Starting resume generation for job_id=${context.job_id}`);

    let company = context.company || "";
    let title = context.title || "";
    let requirements: JDRequirements;

    if (context.requirements) {
      requirements = context.requirements as JDRequirements;
      logger?.info(`📄 [generateResume] Using provided requirements`);
    } else {
      logger?.info(`📄 [generateResume] Loading job data from DB`);
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

    logger?.info(`📄 [generateResume] Target: ${company} — ${title}`);
    logger?.info(`📄 [generateResume] Loading experience inventory and allowlist`);

    const inventory = loadInventory();
    const allowlist = buildEntityAllowlist(inventory);

    const systemPrompt = buildResumeSystemPrompt();
    const userPrompt = buildResumeUserPrompt(
      inventory,
      allowlist,
      requirements,
      title,
      company,
    );

    logger?.info(`📄 [generateResume] Calling LLM with generateObject (gpt-4o)`);
    logger?.info(`📄 [generateResume] System prompt length: ${systemPrompt.length} chars`);
    logger?.info(`📄 [generateResume] User prompt length: ${userPrompt.length} chars`);

    const { object: resume } = await generateObject({
      model: getOpenAI()("gpt-4o"),
      schema: TailoredResumeSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.3,
    });

    const totalBullets = resume.experience.reduce(
      (sum, exp) => sum + exp.bullets.length,
      0,
    );

    logger?.info(`✅ [generateResume] Resume generated successfully`);
    logger?.info(`📄 [generateResume] Bullets: ${totalBullets}, Evidence pointers: ${resume.evidence_pointers.length}, Gap notes: ${resume.gap_notes.length}`);
    logger?.info(`📄 [generateResume] ATS keywords used: ${resume.ats_keywords_used.length}`);
    logger?.info(`📄 [generateResume] Experience entries: ${resume.experience.length}`);

    if (resume.evidence_pointers.length < totalBullets) {
      logger?.warn(`⚠️ [generateResume] WARNING: ${totalBullets} bullets but only ${resume.evidence_pointers.length} evidence pointers`);
    }

    const stats = {
      total_bullets: totalBullets,
      evidence_pointers: resume.evidence_pointers.length,
      gap_notes: resume.gap_notes.length,
      ats_keywords: resume.ats_keywords_used.length,
      model: "gpt-4o",
    };

    try {
      await query(
        `UPDATE scores SET breakdown_json = jsonb_set(
           COALESCE(breakdown_json, '{}'::jsonb),
           '{tailored_resume}',
           $2::jsonb
         ) WHERE job_id = $1`,
        [context.job_id, JSON.stringify({ generated_at: new Date().toISOString(), stats })],
      );
      logger?.info(`💾 [generateResume] Saved resume metadata to DB`);
    } catch (err: any) {
      logger?.error(`⚠️ [generateResume] Failed to save metadata: ${err.message}`);
    }

    return {
      success: true,
      job_id: context.job_id,
      resume,
      stats,
    };
  },
});
