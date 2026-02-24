/**
 * Stage 2c: Automated Company Research
 *
 * Runs AFTER mandate classification (Stage 2), BEFORE positioning strategy (Stage 2b).
 * Scrapes publicly available company information to populate the companyContext
 * field that was previously always empty.
 *
 * Sources (in priority order):
 * 1. Database cache (if we've researched this company before)
 * 2. JD text itself (extract company signals from the job description)
 * 3. Web search via fetch (company website, news, Glassdoor)
 *
 * This is a best-effort module — it never blocks the pipeline on failure.
 * If research fails, the pipeline continues with an empty company context
 * (which is the current behavior anyway).
 *
 * Type: MIXED (DB lookup + optional web fetch + LLM extraction)
 */

import { z } from "zod";
import { resilientGenerateObject } from "../llm-retry";

// ── Schema ──────────────────────────────────────────────────────

export const CompanyResearchSchema = z.object({
  company_name: z.string(),
  industry: z.string().optional(),
  company_size: z.string().optional().describe("Approximate employee count or range"),
  headquarters: z.string().optional(),
  recent_developments: z.array(z.string()).max(5).optional().describe(
    "Recent news, acquisitions, leadership changes, product launches"
  ),
  tech_stack: z.array(z.string()).max(10).optional().describe(
    "Known technology stack — data platforms, BI tools, cloud providers"
  ),
  culture_signals: z.array(z.string()).max(5).optional().describe(
    "Culture indicators from the JD or public sources — remote/hybrid, values, work style"
  ),
  likely_challenges: z.array(z.string()).max(5).optional().describe(
    "Business challenges this company likely faces based on the JD and industry context"
  ),
  data_maturity: z.enum(["early", "growing", "mature", "transforming"]).optional().describe(
    "Estimated data/analytics maturity level"
  ),
  positioning_hooks: z.array(z.string()).max(3).optional().describe(
    "Specific things about this company that the candidate should reference or align with"
  ),
  source: z.enum(["jd_extraction", "web_search", "database_cache", "combined"]),
  confidence: z.number().min(0).max(1).describe("Confidence in the research quality"),
  researched_at: z.string(),
});
export type CompanyResearch = z.infer<typeof CompanyResearchSchema>;

// ── JD-Based Extraction ─────────────────────────────────────────

/**
 * Extract company intelligence from the JD text itself.
 * This always works (no external calls needed) and catches
 * signals like company size, tech stack mentions, culture cues.
 */
export async function extractCompanyFromJD(
  company: string,
  jdText: string,
  logger?: any,
): Promise<CompanyResearch> {
  logger?.info(`🔍 [Research] Extracting company intel from JD for ${company}`);

  try {
    const result = await resilientGenerateObject({
      schema: CompanyResearchSchema,
      system: `You extract company intelligence from job descriptions. Analyze the JD text and identify:
- Industry and company size signals
- Technology stack mentions (tools, platforms, cloud providers)
- Culture signals (remote/hybrid, values language, team structure)
- Business challenges implied by the role requirements
- Data/analytics maturity level based on what they're asking for
- Specific hooks the candidate should reference

Be conservative — only include what's clearly supported by the JD text. Mark confidence based on how much signal the JD contains.`,
      prompt: `Company: ${company}

Job Description:
${jdText.substring(0, 5000)}

Extract company research from this JD. Set source to "jd_extraction". Set researched_at to "${new Date().toISOString()}".`,
      temperature: 0.3,
      label: "Stage 2c: JD Company Extraction",
      lane: "light",
      maxTokens: 1500,
      retry: { maxRetries: 1, timeoutMs: 30000 },
      logger,
    });

    logger?.info(`🔍 [Research] JD extraction complete: confidence=${result.object.confidence}`);
    return result.object;
  } catch (err: any) {
    logger?.warn(`⚠️ [Research] JD extraction failed: ${err.message}`);
    return buildEmptyResearch(company, "jd_extraction");
  }
}

// ── Database Cache ──────────────────────────────────────────────

/**
 * Check if we have cached research for this company.
 * Cache is valid for 30 days.
 */
export async function getCachedResearch(
  company: string,
  logger?: any,
): Promise<CompanyResearch | null> {
  try {
    // Dynamic import to avoid circular dependency with db module
    const { queryWithTimeout } = await import("../../mastra/tools/db");

    const result = await queryWithTimeout(
      `SELECT research_json FROM company_research
       WHERE LOWER(company_name) = LOWER($1)
         AND researched_at > NOW() - INTERVAL '30 days'
       ORDER BY researched_at DESC LIMIT 1`,
      [company],
      5000,
    );

    if (result.rows.length > 0 && result.rows[0].research_json) {
      logger?.info(`🔍 [Research] Cache hit for ${company}`);
      return { ...result.rows[0].research_json, source: "database_cache" };
    }

    return null;
  } catch {
    // Table may not exist yet — non-fatal
    return null;
  }
}

/**
 * Store research in the database cache.
 */
export async function cacheResearch(
  research: CompanyResearch,
  logger?: any,
): Promise<void> {
  try {
    const { query } = await import("../../mastra/tools/db");

    await query(
      `INSERT INTO company_research (company_name, research_json, researched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (company_name) DO UPDATE
       SET research_json = EXCLUDED.research_json, researched_at = NOW()`,
      [research.company_name, JSON.stringify(research)],
    );
  } catch {
    // Non-fatal — cache is optional
    logger?.warn(`⚠️ [Research] Cache write failed for ${research.company_name}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function buildEmptyResearch(company: string, source: CompanyResearch["source"]): CompanyResearch {
  return {
    company_name: company,
    source,
    confidence: 0,
    researched_at: new Date().toISOString(),
  };
}

// ── Main Orchestrator ───────────────────────────────────────────

export interface CompanyResearchInput {
  company: string;
  jdText: string;
  logger?: any;
}

/**
 * Research a company using all available sources.
 *
 * Priority:
 * 1. Database cache (instant, free)
 * 2. JD extraction (fast, one LLM call)
 * 3. Web search (slower, may fail) — future enhancement
 *
 * Never blocks the pipeline on failure. Returns empty research
 * with confidence=0 if everything fails.
 */
export async function researchCompany(
  input: CompanyResearchInput,
): Promise<{ research: CompanyResearch; duration_ms: number }> {
  const start = Date.now();
  const { company, jdText, logger } = input;

  logger?.info(`🔍 [Research] Starting company research for ${company}`);

  // 1. Check cache
  const cached = await getCachedResearch(company, logger);
  if (cached && cached.confidence > 0.3) {
    logger?.info(`🔍 [Research] Using cached research (confidence=${cached.confidence})`);
    return { research: cached, duration_ms: Date.now() - start };
  }

  // 2. Extract from JD (always works, minimal cost)
  const jdResearch = await extractCompanyFromJD(company, jdText, logger);

  // 3. Cache the result for future use
  if (jdResearch.confidence > 0.2) {
    cacheResearch(jdResearch, logger).catch(() => {}); // Fire-and-forget
  }

  const duration = Date.now() - start;
  logger?.info(`🔍 [Research] Company research complete in ${duration}ms (confidence=${jdResearch.confidence})`);

  return { research: jdResearch, duration_ms: duration };
}
