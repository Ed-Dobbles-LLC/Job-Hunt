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
    logger?.info("[apolloSearch] APOLLO_API_KEY not configured, skipping");
    return { newJobIds: [], duplicateCount: 0, totalFound: 0 };
  }

  logger?.info(`[apolloSearch] Searching Apollo for: ${titles.join(", ")}`);

  const allJobs: Array<{
    company: string;
    title: string;
    location: string;
    posting_url: string;
    jd_text: string;
    source: string;
  }> = [];

  // Apollo People Search API - find hiring managers/companies with open roles
  // We search for people with titles that suggest they'd be hiring for our target roles
  for (const targetTitle of titles) {
    try {
      // Use Apollo's mixed company/people search to find relevant job openings
      const searchPayload: Record<string, any> = {
        api_key: apiKey,
        q_organization_keyword_tags: keywords || [],
        page: 1,
        per_page: Math.min(limit, 100),
        person_titles: [targetTitle],
        // Look for people who might be hiring managers
        person_seniorities: ["vp", "director", "c_suite", "senior", "manager"],
      };

      if (locations && locations.length > 0) {
        searchPayload.person_locations = locations;
      }

      const response = await fetch(`${APOLLO_API_BASE}/mixed_people/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(searchPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger?.warn(`[apolloSearch] Apollo API returned ${response.status}: ${errorText}`);
        continue;
      }

      const data = await response.json();
      const people = data.people || [];

      logger?.info(`[apolloSearch] Found ${people.length} results for "${targetTitle}"`);

      // Extract company + role context from Apollo results
      for (const person of people) {
        const org = person.organization || {};
        const companyName = org.name || person.organization_name || "";
        if (!companyName) continue;

        // Build a job lead from the Apollo data
        allJobs.push({
          company: companyName,
          title: targetTitle,
          location: person.city
            ? `${person.city}${person.state ? ", " + person.state : ""}`
            : org.primary_domain ? "" : "Unknown",
          posting_url: org.linkedin_url
            ? `${org.linkedin_url}/jobs`
            : org.website_url || "",
          jd_text: buildJobContext(org, person, targetTitle),
          source: "apollo",
        });
      }
    } catch (err: any) {
      logger?.error(`[apolloSearch] Error searching for "${targetTitle}": ${err.message}`);
    }
  }

  // Also try Apollo's Job Postings endpoint if available
  for (const targetTitle of titles) {
    try {
      const jobSearchPayload: Record<string, any> = {
        api_key: apiKey,
        q_keywords: targetTitle,
        page: 1,
        per_page: Math.min(limit, 25),
      };

      if (locations && locations.length > 0) {
        jobSearchPayload.location_names = locations;
      }

      const response = await fetch(`${APOLLO_API_BASE}/mixed_companies/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          q_keywords: targetTitle,
          page: 1,
          per_page: Math.min(limit, 25),
          organization_num_employees_ranges: ["51,200", "201,1000", "1001,5000", "5001,10000", "10001,"],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const orgs = data.organizations || [];
        logger?.info(`[apolloSearch] Found ${orgs.length} companies for "${targetTitle}"`);

        for (const org of orgs) {
          if (!org.name) continue;
          // Avoid duplicates from the people search
          const alreadyHave = allJobs.some(
            (j) => normalizeText(j.company) === normalizeText(org.name)
          );
          if (alreadyHave) continue;

          allJobs.push({
            company: org.name,
            title: targetTitle,
            location: org.city
              ? `${org.city}${org.state ? ", " + org.state : ""}`
              : "",
            posting_url: org.linkedin_url
              ? `${org.linkedin_url}/jobs`
              : org.website_url || "",
            jd_text: buildOrgContext(org, targetTitle),
            source: "apollo",
          });
        }
      }
    } catch (err: any) {
      logger?.error(`[apolloSearch] Company search error: ${err.message}`);
    }
  }

  logger?.info(`[apolloSearch] Total leads found: ${allJobs.length}`);

  // Deduplicate and insert into jobs table
  const newJobIds: number[] = [];
  let duplicateCount = 0;

  for (const job of allJobs) {
    const hashInput = `${job.company}|${job.title}|${job.location}|${job.posting_url}`;
    const jdHash = computeHash(hashInput);
    const simhash = computeSimhash(job.jd_text);
    const level = classifyLevel(job.title);
    const jobKeywords = extractKeywords(job.jd_text);

    // Check for existing
    const existingByHash = await query(
      "SELECT job_id FROM jobs WHERE jd_hash = $1",
      [jdHash],
    );
    if (existingByHash.rows.length > 0) {
      duplicateCount++;
      continue;
    }

    // Check by company/title similarity
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
        new Date().toISOString().split("T")[0],
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
    "Searches Apollo.io for companies and people related to target job titles. Finds potential job opportunities by identifying companies hiring for similar roles. Requires APOLLO_API_KEY environment variable.",
  inputSchema: z.object({
    titles: z.array(z.string()).describe("Target job titles to search for, e.g. ['VP of Data', 'Chief Data Officer']"),
    locations: z.array(z.string()).optional().describe("Preferred locations, e.g. ['Chicago, IL', 'Remote']"),
    keywords: z.array(z.string()).optional().describe("Industry/domain keywords, e.g. ['fintech', 'healthcare', 'AI']"),
    limit: z.number().optional().describe("Max results per title search (default 25)"),
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
      message: `Found ${result.totalFound} leads from Apollo. ${result.newJobIds.length} new, ${result.duplicateCount} duplicates.`,
    };
  },
});

/* ── Helpers ─────────────────────────────────────────────────────── */

function buildJobContext(
  org: Record<string, any>,
  person: Record<string, any>,
  targetTitle: string,
): string {
  const parts: string[] = [];
  if (org.name) parts.push(`Company: ${org.name}`);
  if (org.short_description) parts.push(`About: ${org.short_description}`);
  if (org.industry) parts.push(`Industry: ${org.industry}`);
  if (org.estimated_num_employees) parts.push(`Company Size: ~${org.estimated_num_employees} employees`);
  if (org.founded_year) parts.push(`Founded: ${org.founded_year}`);
  if (person.name) parts.push(`Contact: ${person.name} (${person.title || ""})`);
  if (person.linkedin_url) parts.push(`Contact LinkedIn: ${person.linkedin_url}`);
  parts.push(`Target Role: ${targetTitle}`);
  parts.push(`Source: Apollo.io people/company search`);
  return parts.join("\n");
}

function buildOrgContext(
  org: Record<string, any>,
  targetTitle: string,
): string {
  const parts: string[] = [];
  if (org.name) parts.push(`Company: ${org.name}`);
  if (org.short_description) parts.push(`About: ${org.short_description}`);
  if (org.industry) parts.push(`Industry: ${org.industry}`);
  if (org.estimated_num_employees) parts.push(`Company Size: ~${org.estimated_num_employees} employees`);
  if (org.founded_year) parts.push(`Founded: ${org.founded_year}`);
  if (org.website_url) parts.push(`Website: ${org.website_url}`);
  parts.push(`Target Role: ${targetTitle}`);
  parts.push(`Source: Apollo.io company search`);
  return parts.join("\n");
}
