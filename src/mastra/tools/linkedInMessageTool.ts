import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { query } from "./db";
import type {
  ExperienceInventory,
  InventoryBullet,
  InventoryExperience,
} from "./matchScorer";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

async function loadInventory(): Promise<ExperienceInventory> {
  try {
    const dbResult = await query("SELECT value FROM app_settings WHERE key = 'experience_inventory'");
    if (dbResult.rows.length > 0 && dbResult.rows[0].value) return JSON.parse(dbResult.rows[0].value);
  } catch { /* fall through */ }
  return JSON.parse(fs.readFileSync(workspacePath("experience_inventory.json"), "utf-8"));
}

const EvidencePointerSchema = z.object({
  source_hash: z
    .string()
    .describe("Inventory bullet ID e.g. exp-001-b2, edu-001, cert-001"),
  evidence_quote: z
    .string()
    .describe("Verbatim or near-verbatim text from the inventory that supports the claim"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How closely the message text matches the evidence (>= 0.7 required)"),
});

const LinkedInMessageSchema = z.object({
  warm_message: z.object({
    text: z
      .string()
      .max(450)
      .describe("The warm outreach message (<450 chars). Assumes a mutual connection or shared context."),
    char_count: z.number().describe("Exact character count of the message text"),
    hook_used: z
      .string()
      .describe("The specific JD requirement or keyword used as the hook in this message"),
    evidence_pointers: z
      .array(EvidencePointerSchema)
      .min(1)
      .describe("Evidence pointers for every factual claim in the message"),
  }),
  cold_message: z.object({
    text: z
      .string()
      .max(450)
      .describe("The cold outreach message (<450 chars). No prior relationship assumed."),
    char_count: z.number().describe("Exact character count of the message text"),
    hook_used: z
      .string()
      .describe("The specific JD requirement or keyword used as the hook in this message"),
    evidence_pointers: z
      .array(EvidencePointerSchema)
      .min(1)
      .describe("Evidence pointers for every factual claim in the message"),
  }),
  job_context: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    recipient_name: z.string().optional().describe("Target recipient name if known"),
    recipient_title: z.string().optional().describe("Target recipient title if known"),
  }),
  validation: z.object({
    warm_under_limit: z.boolean().describe("True if warm message is under 450 chars"),
    cold_under_limit: z.boolean().describe("True if cold message is under 450 chars"),
    all_pointers_valid: z
      .boolean()
      .describe("True if all evidence pointers reference real inventory IDs"),
    hooks_from_jd: z
      .boolean()
      .describe("True if both hooks reference actual JD requirements"),
  }),
});

export type LinkedInMessages = z.infer<typeof LinkedInMessageSchema>;

export function buildEvidenceSummary(inventory: ExperienceInventory): string {
  const lines: string[] = [];

  lines.push(`## CANDIDATE PROFILE`);
  lines.push(`Name: ${inventory.profile.name}`);
  lines.push(`Title: ${inventory.profile.current_title}`);
  lines.push(`Summary: ${inventory.profile.summary}`);
  lines.push("");

  lines.push(`## EXPERIENCE (use these IDs as source_hash)`);
  for (const exp of inventory.experience) {
    lines.push(`### ${exp.employer} — ${exp.title} (${exp.start_date} to ${exp.end_date})`);
    for (const bullet of exp.bullets) {
      const metricsTag = bullet.metrics?.length ? ` [metrics: ${bullet.metrics.join(", ")}]` : "";
      const toolsTag = bullet.tools?.length ? ` [tools: ${bullet.tools.join(", ")}]` : "";
      lines.push(`  - [${bullet.id}] ${bullet.text}${metricsTag}${toolsTag}`);
    }
    lines.push("");
  }

  if (inventory.skills) {
    lines.push(`## SKILLS`);
    if (inventory.skills.technical?.length) {
      lines.push(`Technical: ${inventory.skills.technical.join(", ")}`);
    }
    if (inventory.skills.leadership?.length) {
      lines.push(`Leadership: ${inventory.skills.leadership.join(", ")}`);
    }
    if (inventory.skills.data_science?.length) {
      lines.push(`Data Science: ${inventory.skills.data_science.join(", ")}`);
    }
    if (inventory.skills.domains?.length) {
      lines.push(`Domains: ${inventory.skills.domains.join(", ")}`);
    }
    lines.push("");
  }

  if (inventory.certifications?.length) {
    lines.push(`## CERTIFICATIONS`);
    for (const cert of inventory.certifications) {
      lines.push(`  - [${cert.id}] ${cert.name} (${cert.year})`);
    }
    lines.push("");
  }

  if (inventory.education?.length) {
    lines.push(`## EDUCATION`);
    for (const edu of inventory.education) {
      lines.push(`  - [${edu.id}] ${edu.degree}, ${edu.institution} (${edu.year})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function extractAllBulletIds(inventory: ExperienceInventory): Set<string> {
  const ids = new Set<string>();

  for (const exp of inventory.experience) {
    for (const bullet of exp.bullets) {
      ids.add(bullet.id);
    }
  }

  for (const edu of inventory.education ?? []) {
    ids.add(edu.id);
  }

  for (const cert of inventory.certifications ?? []) {
    ids.add(cert.id);
  }

  return ids;
}

export function extractRequirementTexts(
  requirements: Record<string, any>,
): Set<string> {
  const texts = new Set<string>();
  for (const key of [
    "must_have",
    "nice_to_have",
    "tech_keywords",
    "leadership_scope",
    "domain_context",
    "keywords_for_ats",
  ]) {
    const items = requirements[key];
    if (Array.isArray(items)) {
      for (const item of items) {
        const text = typeof item === "string" ? item : item?.text;
        if (text) texts.add(text.toLowerCase().trim());
      }
    }
  }
  return texts;
}

export function hookMatchesRequirements(
  hook: string,
  requirementTexts: Set<string>,
): boolean {
  if (!hook || hook.trim().length === 0) return false;
  const hookLower = hook.toLowerCase().trim();
  for (const req of requirementTexts) {
    if (req.includes(hookLower) || hookLower.includes(req)) return true;
    const hookWords = hookLower.split(/\s+/).filter((w) => w.length > 3);
    const matchCount = hookWords.filter((w) => req.includes(w)).length;
    if (hookWords.length > 0 && matchCount / hookWords.length >= 0.5) return true;
  }
  return false;
}

export function validateMessages(
  messages: LinkedInMessages,
  validIds: Set<string>,
  requirements?: Record<string, any>,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (messages.warm_message.text.length > 450) {
    issues.push(
      `Warm message exceeds 450 chars: ${messages.warm_message.text.length}`,
    );
  }
  if (messages.cold_message.text.length > 450) {
    issues.push(
      `Cold message exceeds 450 chars: ${messages.cold_message.text.length}`,
    );
  }

  if (messages.warm_message.char_count !== messages.warm_message.text.length) {
    issues.push(
      `Warm message char_count mismatch: reported ${messages.warm_message.char_count}, actual ${messages.warm_message.text.length}`,
    );
  }
  if (messages.cold_message.char_count !== messages.cold_message.text.length) {
    issues.push(
      `Cold message char_count mismatch: reported ${messages.cold_message.char_count}, actual ${messages.cold_message.text.length}`,
    );
  }

  for (const ptr of messages.warm_message.evidence_pointers) {
    if (!validIds.has(ptr.source_hash)) {
      issues.push(`Warm message: invalid source_hash "${ptr.source_hash}"`);
    }
    if (ptr.confidence < 0.7) {
      issues.push(
        `Warm message: low confidence ${ptr.confidence} for "${ptr.source_hash}"`,
      );
    }
  }

  for (const ptr of messages.cold_message.evidence_pointers) {
    if (!validIds.has(ptr.source_hash)) {
      issues.push(`Cold message: invalid source_hash "${ptr.source_hash}"`);
    }
    if (ptr.confidence < 0.7) {
      issues.push(
        `Cold message: low confidence ${ptr.confidence} for "${ptr.source_hash}"`,
      );
    }
  }

  if (messages.warm_message.evidence_pointers.length === 0) {
    issues.push("Warm message has no evidence pointers");
  }
  if (messages.cold_message.evidence_pointers.length === 0) {
    issues.push("Cold message has no evidence pointers");
  }

  if (
    messages.warm_message.hook_used &&
    messages.cold_message.hook_used &&
    messages.warm_message.hook_used.toLowerCase().trim() ===
      messages.cold_message.hook_used.toLowerCase().trim()
  ) {
    issues.push(
      `Warm and cold messages use the same hook: "${messages.warm_message.hook_used}"`,
    );
  }

  if (requirements && Object.keys(requirements).length > 0) {
    const reqTexts = extractRequirementTexts(requirements);
    if (reqTexts.size > 0) {
      if (!hookMatchesRequirements(messages.warm_message.hook_used, reqTexts)) {
        issues.push(
          `Warm message hook "${messages.warm_message.hook_used}" does not match any JD requirement`,
        );
      }
      if (!hookMatchesRequirements(messages.cold_message.hook_used, reqTexts)) {
        issues.push(
          `Cold message hook "${messages.cold_message.hook_used}" does not match any JD requirement`,
        );
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

function buildSystemPrompt(evidenceSummary: string): string {
  return `You are a LinkedIn outreach message writer that generates TWO short, grounded outreach messages for job applications.

## STRICT RULES
1. Each message MUST be under 450 characters. This is a hard limit — LinkedIn truncates longer messages.
2. EVERY factual claim (metric, achievement, tool, company name, title) MUST have an evidence pointer linking to the experience inventory.
3. You MUST include exactly ONE specific hook from the job requirements in each message — a concrete skill, technology, or requirement from the JD.
4. NEVER invent facts, metrics, employers, titles, or achievements not in the inventory.
5. The warm and cold messages must use DIFFERENT hooks from the JD requirements.

## MESSAGE TYPES
- **Warm message**: Assumes the recipient is a mutual connection, a referral, or someone the candidate has interacted with. Tone: conversational, direct, slightly informal. Opens with shared context.
- **Cold message**: No prior relationship. Tone: professional, concise, value-first. Opens with a specific, relevant observation about the role or company.

## MESSAGE STRUCTURE (both types)
1. Opening (1 sentence): Context for reaching out
2. Value proposition (1-2 sentences): ONE specific, supported achievement that directly addresses a JD requirement
3. Ask (1 sentence): Clear, low-friction next step

## EVIDENCE REQUIREMENTS
- For each factual claim in the message, provide a source_hash (inventory bullet ID), evidence_quote (verbatim text from inventory), and confidence (>= 0.7).
- The hook_used field must quote or closely paraphrase an actual requirement from the JD.
- char_count must be the exact character count of the text field.

## EXPERIENCE INVENTORY (your ONLY source of facts)
${evidenceSummary}`;
}

function buildUserPrompt(
  company: string,
  title: string,
  requirements: Record<string, any>,
  recipientName?: string,
  recipientTitle?: string,
): string {
  const reqSections: string[] = [];

  const addSection = (key: string, label: string) => {
    const items = requirements[key];
    if (Array.isArray(items) && items.length > 0) {
      const texts = items.map((item: any) =>
        typeof item === "string" ? item : item.text || JSON.stringify(item),
      );
      reqSections.push(`**${label}:** ${texts.join("; ")}`);
    }
  };

  addSection("must_have", "Must-Have Requirements");
  addSection("nice_to_have", "Nice-to-Have");
  addSection("tech_keywords", "Tech Keywords");
  addSection("leadership_scope", "Leadership Scope");
  addSection("domain_context", "Domain Context");

  const recipientInfo = recipientName
    ? `\n**Recipient:** ${recipientName}${recipientTitle ? `, ${recipientTitle}` : ""}`
    : recipientTitle
      ? `\n**Recipient Title:** ${recipientTitle}`
      : "";

  return `Generate two LinkedIn outreach messages for the following opportunity:

**Company:** ${company}
**Job Title:** ${title}${recipientInfo}

## JOB REQUIREMENTS (pick ONE requirement as your hook per message — use DIFFERENT hooks)
${reqSections.join("\n")}

Remember:
- Each message MUST be under 450 characters
- Each message needs a DIFFERENT hook from the requirements above
- Every factual claim needs an evidence pointer
- Use the candidate's real achievements from the inventory — never fabricate
- The warm message should feel like reaching out to someone you know
- The cold message should lead with value and be direct`;
}

export const linkedInMessageTool = createTool({
  id: "generate-linkedin-messages",
  description:
    "Generates two grounded LinkedIn outreach messages (warm and cold) for a job opportunity. Each message is <450 characters, references only supported facts from the experience inventory, and includes one specific hook from job requirements. Returns messages with evidence pointers for truthfulness verification.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to generate messages for"),
    company: z.string().optional().describe("Company name (loaded from DB if omitted)"),
    title: z.string().optional().describe("Job title (loaded from DB if omitted)"),
    requirements: z
      .record(z.any())
      .optional()
      .describe("JD requirements object. If omitted, loads from DB."),
    recipient_name: z
      .string()
      .optional()
      .describe("Name of the outreach target (from contact discovery)"),
    recipient_title: z
      .string()
      .optional()
      .describe("Title of the outreach target"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    job_id: z.number(),
    warm_message: z.object({
      text: z.string(),
      char_count: z.number(),
      hook_used: z.string(),
      evidence_pointers: z.array(EvidencePointerSchema),
    }),
    cold_message: z.object({
      text: z.string(),
      char_count: z.number(),
      hook_used: z.string(),
      evidence_pointers: z.array(EvidencePointerSchema),
    }),
    validation: z.object({
      warm_under_limit: z.boolean(),
      cold_under_limit: z.boolean(),
      all_pointers_valid: z.boolean(),
      hooks_from_jd: z.boolean(),
    }),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `📩 [linkedInMessages] Starting message generation for job_id=${context.job_id}`,
    );

    try {
      const inventory = await loadInventory();
      const validIds = extractAllBulletIds(inventory);
      const evidenceSummary = buildEvidenceSummary(inventory);

      logger?.info(
        `📋 [linkedInMessages] Loaded inventory: ${validIds.size} valid bullet IDs`,
      );

      let company = context.company;
      let title = context.title;
      let requirements = context.requirements;

      if (!company || !title || !requirements) {
        logger?.info(
          `🔍 [linkedInMessages] Loading job details from DB for job_id=${context.job_id}`,
        );
        const jobResult = await query(
          `SELECT j.company, j.title, j.jd_requirements
           FROM jobs j WHERE j.job_id = $1`,
          [context.job_id],
        );

        if (jobResult.rows.length === 0) {
          logger?.error(
            `❌ [linkedInMessages] Job not found: ${context.job_id}`,
          );
          return {
            success: false,
            job_id: context.job_id,
            warm_message: { text: "", char_count: 0, hook_used: "", evidence_pointers: [] },
            cold_message: { text: "", char_count: 0, hook_used: "", evidence_pointers: [] },
            validation: {
              warm_under_limit: false,
              cold_under_limit: false,
              all_pointers_valid: false,
              hooks_from_jd: false,
            },
            error: `Job ${context.job_id} not found in database`,
          };
        }

        const job = jobResult.rows[0];
        company = company || job.company;
        title = title || job.title;
        requirements = requirements || job.jd_requirements || {};
      }

      logger?.info(
        `🏢 [linkedInMessages] Generating messages for: ${company} — ${title}`,
      );

      const systemPrompt = buildSystemPrompt(evidenceSummary);
      const userPrompt = buildUserPrompt(
        company!,
        title!,
        requirements!,
        context.recipient_name,
        context.recipient_title,
      );

      const { object: messages } = await generateObject({
        model: openai("gpt-4o"),
        schema: LinkedInMessageSchema,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0.4,
      });

      logger?.info(
        `✉️ [linkedInMessages] Generated messages — warm: ${messages.warm_message.text.length} chars, cold: ${messages.cold_message.text.length} chars`,
      );

      const { valid, issues } = validateMessages(messages, validIds, requirements);
      if (!valid) {
        logger?.warn(
          `⚠️ [linkedInMessages] Validation issues found: ${issues.join("; ")}`,
        );

        logger?.info(
          `🔄 [linkedInMessages] Attempting correction pass...`,
        );
        const correctionPrompt = `The previous messages had validation issues:
${issues.map((i) => `- ${i}`).join("\n")}

Please regenerate the messages fixing these specific issues:
- If a message exceeds 450 characters, shorten it while keeping the key value proposition
- If an evidence pointer references an invalid ID, replace it with the correct inventory bullet ID
- If confidence is below 0.7, choose a stronger match from the inventory
- Ensure each message has at least one evidence pointer
- Ensure warm and cold messages use DIFFERENT hooks from the JD requirements
- Ensure char_count matches the actual character count of the text

Original request:
${userPrompt}`;

        const { object: corrected } = await generateObject({
          model: openai("gpt-4o"),
          schema: LinkedInMessageSchema,
          system: systemPrompt,
          prompt: correctionPrompt,
          temperature: 0.2,
        });

        const { valid: correctedValid, issues: correctedIssues } =
          validateMessages(corrected, validIds, requirements);

        if (correctedValid) {
          logger?.info(`✅ [linkedInMessages] Correction pass succeeded`);

          await persistMessages(context.job_id, corrected, logger);

          return {
            success: true,
            job_id: context.job_id,
            warm_message: corrected.warm_message,
            cold_message: corrected.cold_message,
            validation: corrected.validation,
          };
        }

        logger?.warn(
          `⚠️ [linkedInMessages] Correction pass still has issues: ${correctedIssues.join("; ")}`,
        );
      }

      await persistMessages(context.job_id, messages, logger);

      logger?.info(`✅ [linkedInMessages] Messages generated successfully`);

      return {
        success: true,
        job_id: context.job_id,
        warm_message: messages.warm_message,
        cold_message: messages.cold_message,
        validation: {
          warm_under_limit: messages.warm_message.text.length <= 450,
          cold_under_limit: messages.cold_message.text.length <= 450,
          all_pointers_valid: valid,
          hooks_from_jd: messages.validation.hooks_from_jd,
        },
      };
    } catch (err: any) {
      logger?.error(`❌ [linkedInMessages] Error: ${err.message}`);
      return {
        success: false,
        job_id: context.job_id,
        warm_message: { text: "", char_count: 0, hook_used: "", evidence_pointers: [] },
        cold_message: { text: "", char_count: 0, hook_used: "", evidence_pointers: [] },
        validation: {
          warm_under_limit: false,
          cold_under_limit: false,
          all_pointers_valid: false,
          hooks_from_jd: false,
        },
        error: err.message,
      };
    }
  },
});

async function persistMessages(
  jobId: number,
  messages: LinkedInMessages,
  logger: any,
): Promise<void> {
  try {
    await query(
      `UPDATE contacts
       SET message_draft = $1
       WHERE job_id = $2 AND rank = 1`,
      [
        JSON.stringify({
          warm: messages.warm_message,
          cold: messages.cold_message,
        }),
        jobId,
      ],
    );

    logger?.info(
      `💾 [linkedInMessages] Persisted messages to contacts table for job_id=${jobId}`,
    );
  } catch (err: any) {
    logger?.warn(
      `⚠️ [linkedInMessages] Could not persist to contacts table: ${err.message}`,
    );
  }
}
