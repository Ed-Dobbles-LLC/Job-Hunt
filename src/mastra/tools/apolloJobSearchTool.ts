import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";
import {
  normalizeText,
  computeHash,
  computeSimhash,
  classifyLevel,
  extractKeywords,
} from "./jobPostingSchema";

const APOLLO_API_BASE = "https://api.apollo.io/api/v1";

/** Max organizations to fetch job postings for per run.
 *  Each org postings fetch costs 1 Apollo credit; company search costs 1.
 *  Cap keeps a single run at ~11 credits. */
const MAX_ORGS_PER_RUN = 10;

/* ── Title matching ──────────────────────────────────────────────── */

const SENIORITY_GROUPS: string[][] = [
  ["vp", "svp", "evp", "vice president", "senior vice president", "executive vice president"],
  ["chief", "officer", "cdo", "cao", "caio"],
  ["head of", "head,", "head "],
  ["director", "senior director", "executive director"],
];

const DOMAIN_TOKENS = [
  "analytic", "analytics", "data", "insight", "insights",
  "intelligence", "science", "decision", "ai", "machine learning", "ml",
];

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function seniorityGroupsIn(s: string): Set<number> {
  const n = norm(s);
  const groups = new Set<number>();
  SENIORITY_GROUPS.forEach((syns, i) => {
    if (syns.some((syn) => n.includes(` ${syn.trim()} `) || n.includes(` ${syn.trim()}`))) {
      groups.add(i);
    }
  });
  return groups;
}

function domainTokensIn(s: string): Set<string> {
  const n = norm(s);
  return new Set(DOMAIN_TOKENS.filter((t) => n.includes(t)));
}

/** A posting matches if it contains a target title verbatim, OR carries
 *  leadership seniority (VP/chief/head/director) plus an analytics-domain
 *  token. Recall-oriented by design: the downstream matchScorer handles
 *  precision. */
export function postingMatchesTargets(postingTitle: string, targets: string[]): boolean {
  const pNorm = norm(postingTitle);
  const verbatim = targets.some((t) => {
    const tNorm = norm(t).trim();
    return tNorm.length > 0 && pNorm.includes(` ${tNorm} `);
  });
  if (verbatim) return true;
  return seniorityGroupsIn(postingTitle).size > 0 && domainTokensIn(postingTitle).size > 0;
}

/* ── Apollo API calls ────────────────────────────────────────────── */

async function apolloFetch(
  path: string,
  apiKey: string,
  init?: { method?: string; body?: Record<string, any> },
): Promise<any> {
  const response = await fetch(`${APOLLO_API_BASE}${path}`, {
    method: init?.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Apollo ${path} returned ${response.status}: ${errorText.slice(0, 300)}`);
  }
  return response.json();
}

/* ── Standalone function for use outside Mastra tool context ────── */

export async function searchApolloJobs(options: {
  titles: string[];
  locations?: string[];
  keywords?: string[];
  limit?: number;
  logger?: any;
}): Promise<{
  newJobIds: number[];
  duplicateCount: number;
  totalFound: number;
}> {
  const { titles, locations, keywords, limit = 25, logger } = options;
  const apiKey = process.env.APOLLO_API_KEY;

  if (!apiKey) {
    logger?.warn("[apolloSearch] APOLLO_API_KEY not configured; skipping Apollo search");
    return { newJobIds: [], duplicateCount: 0, totalFound: 0 };
  }
  if (titles.length === 0) {
    return { newJobIds: [], duplicateCount: 0, totalFound: 0 };
  }

  const postedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  /* Step 1: find companies with ACTIVE postings matching the target titles */
  let orgs: Record<string, any>[] = [];
  try {
    const body: Record<string, any> = {
      q_organization_job_titles: titles,
      organization_job_posted_at_range: { min: postedSince },
      page: 1,
      per_page: 25,
    };
    if (locations && locations.length > 0) {
      body.organization_locations = locations;
    }
    const data = await apolloFetch("/mixed_companies/search", apiKey, {
      method: "POST",
      body,
    });
    orgs = data.organizations || data.accounts || [];
    logger?.info(
      `[apolloSearch] ${orgs.length} companies actively posting target titles since ${postedSince}`,
    );
  } catch (err: any) {
    logger?.error(`[apolloSearch] Company search failed: ${err.message}`);
    return { newJobIds: [], duplicateCount: 0, totalFound: 0 };
  }

  /* Step 2: pull REAL job postings from the top orgs */
  const allJobs: Array<{
    company: string;
    title: string;
    location: string;
    posting_url: string;
    jd_text: string;
    date_posted: string | null;
    source: string;
  }> = [];

  const orgsToFetch = orgs.filter((o) => o.id).slice(0, MAX_ORGS_PER_RUN);
  for (const org of orgsToFetch) {
    if (allJobs.length >= limit) break;
    try {
      const data = await apolloFetch(
        `/organizations/${org.id}/job_postings?page=1&per_page=100`,
        apiKey,
      );
      const postings: Record<string, any>[] =
        data.organization_job_postings || data.job_postings || [];

      const matched = postings.filter((p) => p.title && postingMatchesTargets(p.title, titles));
      logger?.info(
        `[apolloSearch] ${org.name}: ${postings.length} open postings, ${matched.length} match targets`,
      );

      for (const p of matched) {
        if (allJobs.length >= limit) break;
        const location = [p.city, p.state].filter(Boolean).join(", ") || p.country || "";
        allJobs.push({
          company: org.name || "",
          title: p.title,
          location,
          posting_url: p.url || "",
          jd_text: buildPostingContext(org, p, keywords),
          date_posted: p.posted_at ? String(p.posted_at).split("T")[0] : null,
          source: "apollo",
        });
      }
    } catch (err: any) {
      logger?.warn(`[apolloSearch] Postings fetch failed for ${org.name}: ${err.message}`);
    }
  }

  logger?.info(`[apolloSearch] Total real postings matched: ${allJobs.length}`);

  /* Step 3: deduplicate and insert into jobs table */
  const newJobIds: number[] = [];
  let duplicateCount = 0;

  for (const job of allJobs) {
    const hashInput = `${job.company}|${job.title}|${job.location}|${job.posting_url}`;
    const jdHash = computeHash(hashInput);
    const simhash = computeSimhash(job.jd_text);
    const level = classifyLevel(job.title);
    const jobKeywords = extractKeywords(job.jd_text);

    const existingByHash = await query(
      "SELECT job_id FROM jobs WHERE jd_hash = $1",
      [jdHash],
    );
    if (existingByHash.rows.length > 0) {
      duplicateCount++;
      continue;
    }

    const normalizedCompany = normalizeText(job.company);
    const normalizedTitle = normalizeText(job.title);
    const existingBySimilar = await query(
      `SELECT job_id FROM jobs
       WHERE LOWER(REPLACE(company, ' ', '')) = $1
       AND LOWER(REPLACE(title, ' ', '')) = $2
       AND date_ingested > NOW() - INTERVAL '14 days'`,
      [
        normalizedCompany.replace(/\s/g, ""),
        normalizedTitle.replace(/\s/g, ""),
      ],
    );
    if (existingBySimilar.rows.length > 0) {
      duplicateCount++;
      continue;
    }

    const insertResult = await query(
      `INSERT INTO jobs (source, source_message_id, company, title, location, remote_hybrid, level, posting_url, date_posted, jd_raw_text, jd_hash, simhash, keywords, url_canonical, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'new')
       RETURNING job_id`,
      [
        "apollo",
        `apollo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        job.company,
        job.title,
        job.location,
        "Unknown",
        level,
        job.posting_url,
        job.date_posted || new Date().toISOString().split("T")[0],
        job.jd_text,
        jdHash,
        simhash,
        JSON.stringify(jobKeywords),
        job.posting_url || null,
      ],
    );

    newJobIds.push(insertResult.rows[0].job_id);
    logger?.info(`[apolloSearch] New lead: ${job.company} - ${job.title} (ID: ${insertResult.rows[0].job_id})`);
  }

  logger?.info(`[apolloSearch] Done: ${newJobIds.length} new, ${duplicateCount} duplicates`);
  return { newJobIds, duplicateCount, totalFound: allJobs.length };
}

/* ── Mastra tool wrapper ────────────────────────────────────────── */

export const apolloJobSearchTool = createTool({
  id: "apollo-job-search",
  description:
    "Searches Apollo.io for REAL open job postings matching target titles. Finds companies actively hiring for the titles, then pulls their live job postings with real URLs and posted dates. Requires APOLLO_API_KEY environment variable. Costs ~1 Apollo credit per company inspected (capped at 10 per run).",
  inputSchema: z.object({
    titles: z.array(z.string()).describe("Target job titles to search for, e.g. ['VP of Data', 'Chief Data Officer']"),
    locations: z.array(z.string()).optional().describe("Company HQ locations to filter, e.g. ['Chicago, IL', 'United States']"),
    keywords: z.array(z.string()).optional().describe("Industry/domain keywords, e.g. ['fintech', 'healthcare', 'AI']"),
    limit: z.number().optional().describe("Max postings to ingest per run (default 25)"),
  }),
  outputSchema: z.object({
    newJobIds: z.array(z.number()),
    duplicateCount: z.number(),
    totalFound: z.number(),
    apolloConfigured: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const apiKey = process.env.APOLLO_API_KEY;

    if (!apiKey) {
      return {
        newJobIds: [],
        duplicateCount: 0,
        totalFound: 0,
        apolloConfigured: false,
        message: "APOLLO_API_KEY not configured. Set it in your .env file to enable Apollo job search.",
      };
    }

    const result = await searchApolloJobs({
      titles: context.titles,
      locations: context.locations,
      keywords: context.keywords,
      limit: context.limit,
      logger,
    });

    return {
      ...result,
      apolloConfigured: true,
      message: `Found ${result.totalFound} real postings from Apollo. ${result.newJobIds.length} new, ${result.duplicateCount} duplicates.`,
    };
  },
});

/* ── Helpers ─────────────────────────────────────────────────────── */

function buildPostingContext(
  org: Record<string, any>,
  posting: Record<string, any>,
  keywords?: string[],
): string {
  const parts: string[] = [];
  parts.push(`Job Title: ${posting.title}`);
  if (org.name) parts.push(`Company: ${org.name}`);
  if (posting.city || posting.state) {
    parts.push(`Location: ${[posting.city, posting.state].filter(Boolean).join(", ")}`);
  }
  if (posting.posted_at) parts.push(`Posted: ${String(posting.posted_at).split("T")[0]}`);
  if (posting.url) parts.push(`Posting URL: ${posting.url}`);
  if (org.short_description) parts.push(`About: ${org.short_description}`);
  if (org.industry) parts.push(`Industry: ${org.industry}`);
  if (org.estimated_num_employees) parts.push(`Company Size: ~${org.estimated_num_employees} employees`);
  if (org.website_url) parts.push(`Website: ${org.website_url}`);
  if (keywords && keywords.length > 0) parts.push(`Search Keywords: ${keywords.join(", ")}`);
  parts.push(`Source: Apollo.io live job postings`);
  return parts.join("\n");
}
