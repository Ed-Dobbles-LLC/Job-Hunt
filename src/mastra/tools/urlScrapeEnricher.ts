import { query } from "./db";
import { computeHash, computeSimhash, extractKeywords } from "./jobPostingSchema";

/**
 * Deterministic URL-based JD enrichment.
 * Fetches posting URLs directly and extracts job description text.
 * No LLM needed — runs before the agent-based web search fallback.
 */

const JD_MIN_LENGTH = 100;
const FETCH_TIMEOUT_MS = 10_000;

/** Strip HTML tags and collapse whitespace */
function htmlToText(html: string): string {
  // Remove script/style blocks entirely
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Replace common block elements with newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Extract the most JD-like text block from a page */
function extractJdSection(text: string): string {
  // Many job pages have a clear section. Look for common patterns.
  const jdPatterns = [
    /(?:job\s*description|about\s*(?:the|this)\s*(?:role|position|job)|responsibilities|what\s*you['']?ll\s*do|the\s*role)([\s\S]{200,5000}?)(?=(?:about\s*(?:us|the\s*company)|benefits|how\s*to\s*apply|equal\s*opportunity|similar\s*jobs|$))/i,
    /(?:overview|summary)([\s\S]{200,5000}?)(?=(?:benefits|about\s*us|how\s*to\s*apply|equal\s*opportunity|$))/i,
  ];

  for (const pattern of jdPatterns) {
    const match = text.match(pattern);
    if (match && match[0].length >= 200) {
      return match[0].trim();
    }
  }

  // Fallback: return the longest continuous block of text (likely the JD body)
  return text;
}

/** Fetch a single posting URL and extract JD text. Returns null on failure. */
async function scrapePostingUrl(
  url: string,
): Promise<{ jdText: string; compensation?: string; remoteHybrid?: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; JobHuntBot/1.0)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    if (!html || html.length < 200) return null;

    const fullText = htmlToText(html);
    const jdText = extractJdSection(fullText);

    if (jdText.length < JD_MIN_LENGTH) return null;

    // Try to extract compensation
    const compMatch = jdText.match(
      /\$[\d,]+(?:\s*[-–—to]\s*\$[\d,]+)?(?:\s*(?:per\s*(?:year|annum|hr|hour)|\/?yr|\/?hr|annually|\/year))?/i,
    );
    const compensation = compMatch ? compMatch[0] : undefined;

    // Try to extract remote/hybrid status
    const remoteMatch = jdText.match(
      /\b(fully?\s*remote|hybrid|on[- ]?site|in[- ]?office|remote[- ]?first)\b/i,
    );
    const remoteHybrid = remoteMatch ? remoteMatch[1] : undefined;

    // Cap at 5000 chars to avoid storing entire web pages
    return {
      jdText: jdText.slice(0, 5000),
      compensation,
      remoteHybrid,
    };
  } catch {
    return null;
  }
}

export interface UrlEnrichResult {
  job_id: number;
  company: string;
  title: string;
  status: "scraped" | "failed";
  jdLength?: number;
}

/**
 * Attempt to enrich jobs by directly fetching their posting URLs.
 * Returns results for each job attempted.
 */
export async function enrichJobsByUrl(
  jobs: Array<{
    job_id: number;
    company: string;
    title: string;
    posting_url: string | null;
  }>,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<{ results: UrlEnrichResult[]; enrichedCount: number; failedCount: number }> {
  const results: UrlEnrichResult[] = [];
  let enrichedCount = 0;
  let failedCount = 0;

  for (const job of jobs) {
    if (!job.posting_url) {
      results.push({ job_id: job.job_id, company: job.company, title: job.title, status: "failed" });
      failedCount++;
      continue;
    }

    logger?.info(`🔗 [urlEnrich] Fetching URL for Job #${job.job_id}: ${job.company} — ${job.title}`);

    const scraped = await scrapePostingUrl(job.posting_url);

    if (!scraped) {
      logger?.warn(`⚠️ [urlEnrich] Could not extract JD from URL for Job #${job.job_id}`);
      results.push({ job_id: job.job_id, company: job.company, title: job.title, status: "failed" });
      failedCount++;
      continue;
    }

    // Update the database
    const jdHash = computeHash(scraped.jdText);
    const simhash = computeSimhash(scraped.jdText);
    const keywords = extractKeywords(scraped.jdText);

    const updates: string[] = [
      "jd_raw_text = $1",
      "jd_hash = $2",
      "simhash = $3",
      "keywords = $4",
      "status = $5",
    ];
    const values: any[] = [scraped.jdText, jdHash, simhash.toString(), JSON.stringify(keywords), "enriched"];
    let paramIdx = 6;

    if (scraped.compensation) {
      updates.push(`compensation = $${paramIdx}`);
      values.push(scraped.compensation);
      paramIdx++;
    }
    if (scraped.remoteHybrid) {
      updates.push(`remote_hybrid = $${paramIdx}`);
      values.push(scraped.remoteHybrid);
      paramIdx++;
    }

    values.push(job.job_id);

    await query(
      `UPDATE jobs SET ${updates.join(", ")} WHERE job_id = $${paramIdx}`,
      values,
    );

    logger?.info(
      `✅ [urlEnrich] Enriched Job #${job.job_id} (${scraped.jdText.length} chars)`,
    );
    results.push({
      job_id: job.job_id,
      company: job.company,
      title: job.title,
      status: "scraped",
      jdLength: scraped.jdText.length,
    });
    enrichedCount++;
  }

  return { results, enrichedCount, failedCount };
}

/**
 * Fetch all jobs needing enrichment that have posting URLs, and try URL scraping.
 * Returns summary of what was enriched and what still needs LLM web search.
 */
export async function enrichAllByUrl(
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<{ enrichedCount: number; failedCount: number; remainingCount: number }> {
  const result = await query(`
    SELECT job_id, company, title, posting_url
    FROM jobs
    WHERE (jd_raw_text IS NULL OR LENGTH(jd_raw_text) < 100)
      AND (user_action IS NULL OR user_action = '')
    ORDER BY date_ingested DESC
  `);

  const withUrls = result.rows.filter((j: any) => j.posting_url && j.posting_url.startsWith("http"));
  const withoutUrls = result.rows.length - withUrls.length;

  logger?.info(`🔗 [urlEnrich] ${result.rows.length} jobs need enrichment: ${withUrls.length} have URLs, ${withoutUrls} do not`);

  if (withUrls.length === 0) {
    return { enrichedCount: 0, failedCount: 0, remainingCount: result.rows.length };
  }

  const { enrichedCount, failedCount } = await enrichJobsByUrl(withUrls, logger);

  // Re-count remaining after scraping
  const remaining = await query(`
    SELECT COUNT(*) as cnt FROM jobs
    WHERE (jd_raw_text IS NULL OR LENGTH(jd_raw_text) < 100)
      AND (user_action IS NULL OR user_action = '')
  `);
  const remainingCount = parseInt(remaining.rows[0].cnt, 10);

  logger?.info(`📊 [urlEnrich] URL scraping done: ${enrichedCount} enriched, ${failedCount} failed, ${remainingCount} still need JD`);

  return { enrichedCount, failedCount, remainingCount };
}
