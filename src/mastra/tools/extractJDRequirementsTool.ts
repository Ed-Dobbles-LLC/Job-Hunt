import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { query } from "./db";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const RequirementItemSchema = z.object({
  text: z.string().describe("The requirement or keyword text"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Confidence that this item is correctly classified (0.0-1.0). 1.0 = explicitly stated in JD text; 0.7-0.9 = strongly implied; 0.5-0.69 = inferred from context; <0.5 = speculative",
    ),
});

export const JDRequirementsSchema = z.object({
  must_have: z
    .array(RequirementItemSchema)
    .describe(
      "Hard requirements that a candidate MUST possess. These are explicitly stated as required, mandatory, or minimum qualifications. Include years of experience, specific degrees, certifications, clearances, and skills listed under Required/Minimum Qualifications.",
    ),
  nice_to_have: z
    .array(RequirementItemSchema)
    .describe(
      "Preferred or bonus qualifications. These are listed under Preferred/Desired/Bonus or phrased as 'experience with X is a plus'. Include stretch skills the JD mentions but does not require.",
    ),
  leadership_scope: z
    .array(RequirementItemSchema)
    .describe(
      "Indicators of management and leadership expectations. Include: team size, number of direct reports, cross-functional scope, budget authority, executive stakeholder interaction, board reporting, P&L ownership, org-building language, mentoring expectations.",
    ),
  domain_context: z
    .array(RequirementItemSchema)
    .describe(
      "Industry, vertical, and business-context signals. Include: industry (fintech, healthcare, SaaS, etc.), business model (B2B, B2C, marketplace), stage (startup, growth, enterprise), regulatory environment (SOX, HIPAA, GDPR), geographic scope, customer type.",
    ),
  tech_keywords: z
    .array(RequirementItemSchema)
    .describe(
      "Specific technologies, platforms, frameworks, and tools mentioned. Include: programming languages, cloud platforms (AWS, GCP, Azure), databases (Snowflake, BigQuery, Postgres), ML/AI frameworks (PyTorch, TensorFlow, LangChain), BI tools (Tableau, Looker), orchestration (Airflow, dbt), and any other named technology.",
    ),
  keywords_for_ats: z
    .array(RequirementItemSchema)
    .describe(
      "Exact phrases and terminology from the JD that an ATS (Applicant Tracking System) would scan for. These should be copied verbatim from the JD text — do not paraphrase. Include role-specific jargon, methodology names, framework names, and exact multi-word phrases the JD uses.",
    ),
  red_flags: z
    .array(RequirementItemSchema)
    .describe(
      "Requirements or signals that may indicate a poor fit, unrealistic expectations, or role concerns. Include: unusually broad scope (e.g., IC + people management + strategy + hands-on coding), excessive tech stack breadth, mismatched seniority signals, sponsorship restrictions, mandatory relocation, on-call requirements, excessive travel, unrealistic experience requirements (e.g., 10+ years in a 3-year-old technology), and language suggesting the role is a cost center.",
    ),
});

export type JDRequirements = z.infer<typeof JDRequirementsSchema>;
export type RequirementItem = z.infer<typeof RequirementItemSchema>;

const JD_EXTRACTION_PROMPT = `You are a precision job-description analyst. Your task is to decompose a job description into structured requirement categories.

## RULES
1. Read the ENTIRE job description before extracting anything.
2. Every extracted item must include a confidence score:
   - 1.0 = explicitly stated verbatim in the JD
   - 0.8-0.9 = clearly stated but slightly rephrased
   - 0.6-0.7 = strongly implied by context or adjacent requirements
   - 0.4-0.5 = inferred from role type/industry norms but not stated
   - Do NOT go below 0.4 — if you are guessing, omit the item.
3. For keywords_for_ats: copy EXACT phrases from the JD. Do not paraphrase, summarize, or generalize. These go directly into a resume for ATS matching.
4. For red_flags: be specific about WHY something is a red flag. The text field should describe the concern, not just quote the JD.
5. Prefer specificity over breadth. "5+ years of Python" is better than "programming experience".
6. De-duplicate: if the same concept appears in must_have and nice_to_have, place it in whichever category the JD assigns it to. Do not list it twice.
7. If the JD is vague or boilerplate-heavy, note that in red_flags with an appropriate confidence score.

## CATEGORY GUIDELINES

### must_have
Extract ONLY items the JD marks as required/mandatory/minimum. Look for:
- "Required:", "Minimum Qualifications:", "You must have:", "X+ years of"
- Non-negotiable credentials (degrees, certifications, clearances)
- If the JD doesn't clearly separate required vs. preferred, use judgment: items in the first qualifications section or phrased imperatively ("must", "required") go here.

### nice_to_have
Extract items marked preferred/desired/bonus. Look for:
- "Preferred:", "Nice to have:", "Bonus:", "Plus:", "Ideally"
- Items phrased as "experience with X is a plus"
- If ambiguous between must_have and nice_to_have, default to nice_to_have with lower confidence.

### leadership_scope
Extract management/leadership signals. Look for:
- Direct/indirect reports, team size, org structure
- "Build and lead", "manage a team of", "hire and develop"
- Cross-functional, executive stakeholders, C-suite reporting
- Budget ownership, P&L, revenue targets
- If the role is IC with no leadership signals, return an empty array.

### domain_context
Extract industry/business signals. Look for:
- Named industries (fintech, healthcare, e-commerce, etc.)
- Business model (SaaS, marketplace, B2B enterprise)
- Company stage (startup, Series B, Fortune 500)
- Regulatory mentions (SOX, HIPAA, PCI-DSS, GDPR)
- Geographic scope (global, US-only, EMEA)

### tech_keywords
Extract named technologies. Be specific:
- "Python" not "programming languages"
- "Snowflake" not "cloud data warehouse"
- "dbt" not "data transformation tool"
- Include version numbers if mentioned (e.g., "Python 3.x", "Spark 3.4")

### keywords_for_ats
Copy EXACT multi-word phrases from the JD text that an ATS would match on:
- "cross-functional collaboration"
- "data-driven decision making"  
- "executive stakeholder management"
- "machine learning operations"
- Include both technical and soft-skill phrases
- Prefer 2-4 word phrases that are distinctive to this role

### red_flags
Identify concerns. Common patterns:
- Role scope too broad (IC + manager + strategist + hands-on coder)
- Tech stack too deep for a leadership role (suggests they want an engineer, not a leader)
- Mismatched seniority (VP title but IC responsibilities, or IC title but VP expectations)
- "Unicorn" requirements (must know 15+ technologies at expert level)
- Sponsorship restrictions, mandatory relocation, excessive travel
- Buzzword-heavy with no concrete deliverables
- Unrealistic experience requirements for technology age

## OUTPUT
Return ONLY the JSON object matching the schema. No commentary, no markdown, no code fences.`;

export const extractJDRequirementsTool = createTool({
  id: "extract-jd-requirements",
  description:
    "Extracts structured requirements from a job description using LLM analysis. Decomposes the JD into must_have, nice_to_have, leadership_scope, domain_context, tech_keywords, keywords_for_ats, and red_flags — each with a confidence score. Saves results to the database.",
  inputSchema: z.object({
    job_id: z.number().describe("Database job ID to extract requirements for"),
    jd_text: z
      .string()
      .optional()
      .describe(
        "Job description text. If omitted, fetches from DB using job_id.",
      ),
    company: z.string().optional().describe("Company name for context"),
    title: z.string().optional().describe("Job title for context"),
  }),
  outputSchema: z.object({
    job_id: z.number(),
    requirements: JDRequirementsSchema,
    meta: z.object({
      model: z.string(),
      total_items: z.number(),
      avg_confidence: z.number(),
      categories: z.record(z.string(), z.number()),
    }),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `🔍 [extractJDRequirements] Starting extraction for job_id=${context.job_id}`,
    );

    let jdText = context.jd_text || "";
    let company = context.company || "";
    let title = context.title || "";

    if (!jdText || jdText.length < 50) {
      logger?.info(
        `🔍 [extractJDRequirements] Fetching JD from DB for job_id=${context.job_id}`,
      );
      const result = await query(
        "SELECT jd_raw_text, company, title FROM jobs WHERE job_id = $1",
        [context.job_id],
      );
      if (result.rows.length === 0) {
        throw new Error(
          `Job ID ${context.job_id} not found in database`,
        );
      }
      jdText = result.rows[0].jd_raw_text || "";
      company = company || result.rows[0].company || "";
      title = title || result.rows[0].title || "";
    }

    if (!jdText || jdText.length < 50) {
      logger?.warn(
        `⚠️ [extractJDRequirements] JD text too short (${jdText.length} chars) for job_id=${context.job_id}`,
      );
      const emptyReqs: JDRequirements = {
        must_have: [],
        nice_to_have: [],
        leadership_scope: [],
        domain_context: [],
        tech_keywords: [],
        keywords_for_ats: [],
        red_flags: [
          {
            text: "Job description is missing or too short to analyze",
            confidence: 1.0,
          },
        ],
      };
      return {
        job_id: context.job_id,
        requirements: emptyReqs,
        meta: {
          model: "none",
          total_items: 1,
          avg_confidence: 1.0,
          categories: {
            must_have: 0,
            nice_to_have: 0,
            leadership_scope: 0,
            domain_context: 0,
            tech_keywords: 0,
            keywords_for_ats: 0,
            red_flags: 1,
          },
        },
      };
    }

    logger?.info(
      `🔍 [extractJDRequirements] Calling LLM for ${company} — ${title} (${jdText.length} chars)`,
    );

    const modelId = "gpt-4o";

    const { object: requirements } = await generateObject({
      model: openai(modelId),
      schema: JDRequirementsSchema,
      prompt: `${JD_EXTRACTION_PROMPT}\n\n## JOB DESCRIPTION TO ANALYZE\nCompany: ${company}\nTitle: ${title}\n\n${jdText}`,
      temperature: 0.1,
    });

    const categories: Record<string, number> = {};
    let totalItems = 0;
    let totalConfidence = 0;

    for (const key of Object.keys(requirements) as (keyof JDRequirements)[]) {
      const items = requirements[key];
      categories[key] = items.length;
      totalItems += items.length;
      for (const item of items) {
        totalConfidence += item.confidence;
      }
    }

    const avgConfidence = totalItems > 0 ? totalConfidence / totalItems : 0;

    logger?.info(
      `✅ [extractJDRequirements] Extracted ${totalItems} items across ${Object.keys(categories).length} categories (avg confidence: ${avgConfidence.toFixed(2)})`,
    );
    logger?.info(
      `📊 [extractJDRequirements] Breakdown: ${JSON.stringify(categories)}`,
    );

    try {
      await query(
        `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS jd_requirements JSONB`,
      );
      await query(
        `UPDATE jobs SET jd_requirements = $1 WHERE job_id = $2`,
        [JSON.stringify(requirements), context.job_id],
      );
      logger?.info(
        `💾 [extractJDRequirements] Saved requirements to DB for job_id=${context.job_id}`,
      );
    } catch (err: any) {
      logger?.error(
        `⚠️ [extractJDRequirements] Failed to save to DB: ${err.message}`,
      );
    }

    return {
      job_id: context.job_id,
      requirements,
      meta: {
        model: modelId,
        total_items: totalItems,
        avg_confidence: Math.round(avgConfidence * 1000) / 1000,
        categories,
      },
    };
  },
});
