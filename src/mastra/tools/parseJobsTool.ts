import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";
import {
  normalizeText,
  computeHash,
  computeSimhash,
  isNearDuplicate,
  hammingDistance,
  classifyLevel,
  extractKeywords,
} from "./jobPostingSchema";

export interface ParsedJob {
  company: string;
  title: string;
  location: string;
  remote_hybrid: string;
  posting_url: string;
  date_posted: string;
  jd_raw_text: string;
  compensation: string;
  source: string;
  source_message_id: string;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);

    if (u.hostname.includes("linkedin.com")) {
      const jobIdMatch = u.pathname.match(/\/jobs\/view\/(\d+)/);
      if (jobIdMatch) {
        return `https://www.linkedin.com/jobs/view/${jobIdMatch[1]}`;
      }
      const commMatch = u.pathname.match(/\/comm\/jobs\/view\/(\d+)/);
      if (commMatch) {
        return `https://www.linkedin.com/jobs/view/${commMatch[1]}`;
      }
    }

    const keepParams = ["view", "id", "job"];
    const newParams = new URLSearchParams();
    for (const [key, value] of u.searchParams) {
      if (keepParams.includes(key)) {
        newParams.set(key, value);
      }
    }
    u.search = newParams.toString();
    return u.toString();
  } catch {
    return url;
  }
}

function detectRemoteHybrid(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("remote") && lower.includes("hybrid"))
    return "Hybrid/Remote";
  if (lower.includes("fully remote") || lower.includes("100% remote"))
    return "Remote";
  if (lower.includes("remote ok") || lower.includes("remote"))
    return "Remote";
  if (lower.includes("hybrid")) return "Hybrid";
  if (lower.includes("on-site") || lower.includes("onsite"))
    return "On-site";
  return "Unknown";
}

function extractCompensation(text: string): string {
  const patterns = [
    /(?:salary|compensation|pay|base)[\s:]*\$[\d,]+\s*[-–]\s*\$[\d,]+/gi,
    /\$[\d,]+\s*[-–]\s*\$[\d,]+(?:\s*(?:\/year|\/yr|annually|per year))?/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return "";
}

const SIMHASH_NEAR_DUPE_THRESHOLD = 10;

export const parseJobsTool = createTool({
  id: "parse-jobs",
  description:
    "Parses raw email bodies to extract individual job postings. Uses LLM-extracted JSON job data and stores them in the database with deduplication.",
  inputSchema: z.object({
    jobs: z.array(
      z.object({
        company: z.string(),
        title: z.string(),
        location: z.string(),
        posting_url: z.string().optional(),
        jd_text: z
          .string()
          .optional()
          .describe(
            "Full job description text if available. LinkedIn alerts typically only have title/company/location, so this may be empty.",
          ),
        compensation: z.string().optional(),
        source: z.string().optional(),
        source_message_id: z.string().optional(),
      }),
    ),
  }),
  outputSchema: z.object({
    newJobIds: z.array(z.number()),
    duplicateCount: z.number(),
    totalParsed: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `📝 [parseJobs] Processing ${context.jobs.length} parsed jobs`,
    );

    const newJobIds: number[] = [];
    let duplicateCount = 0;

    for (const job of context.jobs) {
      const jdText = job.jd_text || "";
      const hashInput = jdText || `${job.company}|${job.title}|${job.location}|${job.posting_url || ""}`;
      const jdHash = computeHash(hashInput);
      const simhash = computeSimhash(jdText);
      const level = classifyLevel(job.title);
      const keywords = extractKeywords(jdText);
      const canonicalUrl = job.posting_url
        ? normalizeUrl(job.posting_url)
        : null;
      const remoteHybrid = detectRemoteHybrid(
        `${job.location} ${jdText}`,
      );
      const compensation =
        job.compensation || extractCompensation(jdText);

      const existingByHash = await query(
        "SELECT job_id FROM jobs WHERE jd_hash = $1",
        [jdHash],
      );
      if (existingByHash.rows.length > 0) {
        logger?.info(
          `🔄 [parseJobs] Duplicate by JD hash: ${job.company} - ${job.title}`,
        );
        duplicateCount++;
        continue;
      }

      if (canonicalUrl) {
        const existingByUrl = await query(
          "SELECT job_id FROM jobs WHERE url_canonical = $1",
          [canonicalUrl],
        );
        if (existingByUrl.rows.length > 0) {
          logger?.info(
            `🔄 [parseJobs] Duplicate by URL: ${job.company} - ${job.title}`,
          );
          duplicateCount++;
          continue;
        }
      }

      if (jdText && simhash !== "0000000000000000") {
        const recentJobs = await query(
          `SELECT job_id, simhash, company, title FROM jobs
           WHERE simhash IS NOT NULL AND simhash != '0000000000000000'
           AND date_ingested > NOW() - INTERVAL '14 days'`,
        );
        let nearDupe = false;
        for (const row of recentJobs.rows) {
          if (isNearDuplicate(simhash, row.simhash, SIMHASH_NEAR_DUPE_THRESHOLD)) {
            const dist = hammingDistance(simhash, row.simhash);
            logger?.info(
              `🔄 [parseJobs] Near-duplicate by simhash (distance=${dist}): ${job.company} - ${job.title} ≈ ${row.company} - ${row.title} (job_id=${row.job_id})`,
            );
            nearDupe = true;
            break;
          }
        }
        if (nearDupe) {
          duplicateCount++;
          continue;
        }
      }

      const normalizedCompany = normalizeText(job.company);
      const normalizedTitle = normalizeText(job.title);
      const normalizedLocation = normalizeText(job.location);
      const existingBySimilar = await query(
        `SELECT job_id FROM jobs
         WHERE LOWER(REPLACE(company, ' ', '')) = $1
         AND LOWER(REPLACE(title, ' ', '')) = $2
         AND LOWER(REPLACE(location, ' ', '')) = $3
         AND date_ingested > NOW() - INTERVAL '14 days'`,
        [
          normalizedCompany.replace(/\s/g, ""),
          normalizedTitle.replace(/\s/g, ""),
          normalizedLocation.replace(/\s/g, ""),
        ],
      );
      if (existingBySimilar.rows.length > 0) {
        logger?.info(
          `🔄 [parseJobs] Duplicate by company/title/location within 14 days: ${job.company} - ${job.title}`,
        );
        duplicateCount++;
        continue;
      }

      const insertResult = await query(
        `INSERT INTO jobs (source, source_message_id, company, title, location, remote_hybrid, level, posting_url, date_posted, jd_raw_text, jd_hash, simhash, keywords, url_canonical, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'new')
         RETURNING job_id`,
        [
          job.source || "email",
          job.source_message_id || "",
          job.company,
          job.title,
          job.location,
          remoteHybrid,
          level,
          canonicalUrl || job.posting_url || "",
          new Date().toISOString().split("T")[0],
          jdText,
          jdHash,
          simhash,
          JSON.stringify(keywords),
          canonicalUrl,
        ],
      );

      newJobIds.push(insertResult.rows[0].job_id);
      logger?.info(
        `✅ [parseJobs] Stored new job: ${job.company} - ${job.title} (level=${level}, keywords=${keywords.length}, ID: ${insertResult.rows[0].job_id})`,
      );
    }

    logger?.info(
      `📊 [parseJobs] Done: ${newJobIds.length} new, ${duplicateCount} duplicates`,
    );

    return {
      newJobIds,
      duplicateCount,
      totalParsed: context.jobs.length,
    };
  },
});
