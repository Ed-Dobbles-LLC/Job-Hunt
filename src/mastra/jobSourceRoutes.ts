import { query } from "./tools/db";
import { mapClayLead } from "./tools/clayLeadMapper";
import { searchApolloJobs } from "./tools/apolloJobSearchTool";
import {
  normalizeText,
  computeHash,
  computeSimhash,
  classifyLevel,
  extractKeywords,
} from "./tools/jobPostingSchema";

/**
 * Routes for job source integrations:
 * - Apollo job search (manual trigger)
 * - Clay inbound webhook (receives enriched leads from Clay)
 * - Recruiter email parsing trigger
 * - Job sources status dashboard
 */
// Cap raw-payload debug dumps per process boot (self-diagnosing failures without log flooding)
let clayDebugDumpsRemaining = 5;

export function getJobSourceRoutes() {
  return [
    /* ── Apollo: manually trigger a job search ─────────────────────── */
    {
      path: "/api/sources/apollo/search",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const apiKey = process.env.APOLLO_API_KEY;

        if (!apiKey) {
          return c.json({
            error: "APOLLO_API_KEY not configured. Add it to your .env file.",
            configured: false,
          }, 400);
        }

        try {
          const body = await c.req.json().catch(() => ({}));
          const titles: string[] = body.titles || [];
          const locations: string[] = body.locations || [];
          const keywords: string[] = body.keywords || [];
          const limit: number = body.limit || 25;

          if (titles.length === 0) {
            return c.json({ error: "Provide at least one title to search for." }, 400);
          }

          logger?.info(`[sources/apollo] Searching: ${titles.join(", ")}`);

          const result = await searchApolloJobs({
            titles,
            locations,
            keywords,
            limit,
            logger,
          });

          return c.json({
            success: true,
            ...result,
            message: `Found ${result.totalFound} leads. ${result.newJobIds.length} new jobs added, ${result.duplicateCount} duplicates skipped.`,
          });
        } catch (err: any) {
          logger?.error(`[sources/apollo] Search error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Clay inbound webhook: receive enriched job leads ──────────── */
    {
      path: "/api/sources/clay/webhook",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();

        // Optional auth via shared secret
        const claySecret = process.env.CLAY_INBOUND_SECRET;
        if (claySecret) {
          const authHeader = c.req.header("x-clay-secret") || c.req.header("authorization")?.replace("Bearer ", "");
          if (authHeader !== claySecret) {
            return c.json({ error: "Unauthorized" }, 401);
          }
        }

        try {
          const body = await c.req.json();
          const leads = Array.isArray(body) ? body : [body];

          logger?.info(`[sources/clay] Received ${leads.length} leads from Clay`);

          const newJobIds: number[] = [];
          let duplicateCount = 0;

          for (const rawLead of leads) {
            const lead = mapClayLead(rawLead);
            const company = lead.company;
            const title = lead.title;
            const location = lead.location;
            const postingUrl = lead.postingUrl;
            const jdText = lead.jdText;
            const compensation = lead.compensation;

            if (!company && !title) {
              // Self-diagnosing rejection: name the keys we actually received
              logger?.warn(
                `[sources/clay] Skipping lead with no company or title. Received keys: [${lead.rawKeys.join(", ")}]`,
              );
              if (clayDebugDumpsRemaining > 0) {
                clayDebugDumpsRemaining--;
                logger?.warn(
                  `[sources/clay] Raw payload dump (${clayDebugDumpsRemaining} dumps remaining this boot): ${JSON.stringify(rawLead).slice(0, 2000)}`,
                );
              }
              continue;
            }

            // Dedup check
            const hashInput = jdText || `${company}|${title}|${location}|${postingUrl}`;
            const jdHash = computeHash(hashInput);

            const existingByHash = await query(
              "SELECT job_id FROM jobs WHERE jd_hash = $1",
              [jdHash],
            );
            if (existingByHash.rows.length > 0) {
              duplicateCount++;
              continue;
            }

            const normalizedCompany = normalizeText(company);
            const normalizedTitle = normalizeText(title);
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

            const simhash = computeSimhash(jdText);
            const level = classifyLevel(title);
            const jobKeywords = extractKeywords(jdText);

            // Build enrichment context from Clay fields
            const enrichmentParts: string[] = [];
            if (lead.companyDescription) enrichmentParts.push(`Company: ${lead.companyDescription}`);
            if (lead.industry) enrichmentParts.push(`Industry: ${lead.industry}`);
            if (lead.companySize) enrichmentParts.push(`Size: ${lead.companySize}`);
            if (lead.funding) enrichmentParts.push(`Funding: ${lead.funding}`);
            if (lead.contactName) enrichmentParts.push(`Hiring Contact: ${lead.contactName} (${lead.contactTitle || ""})`);
            if (lead.contactLinkedin) enrichmentParts.push(`Contact LinkedIn: ${lead.contactLinkedin}`);
            if (lead.contactEmail) enrichmentParts.push(`Contact Email: ${lead.contactEmail}`);
            if (compensation) enrichmentParts.push(`Compensation: ${compensation}`);

            const fullJdText = jdText
              ? `${jdText}\n\n--- Clay Enrichment ---\n${enrichmentParts.join("\n")}`
              : enrichmentParts.join("\n");

            const insertResult = await query(
              `INSERT INTO jobs (source, source_message_id, company, title, location, remote_hybrid, level, posting_url, date_posted, jd_raw_text, jd_hash, simhash, keywords, url_canonical, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               RETURNING job_id`,
              [
                "clay",
                lead.clayRowId || `clay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                company,
                title,
                location,
                lead.remoteHybrid || "Unknown",
                level,
                postingUrl,
                new Date().toISOString().split("T")[0],
                fullJdText,
                jdHash,
                simhash,
                JSON.stringify(jobKeywords),
                postingUrl || null,
                fullJdText.length > 200 ? "enriched" : "new",
              ],
            );

            newJobIds.push(insertResult.rows[0].job_id);
            logger?.info(`[sources/clay] New lead: ${company} - ${title} (ID: ${insertResult.rows[0].job_id})`);

            // Also store contact info if provided
            if (lead.contactName) {
              try {
                await query(
                  `INSERT INTO contacts (job_id, person_name, title, linkedin_url, email, rank, rationale)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    insertResult.rows[0].job_id,
                    lead.contactName,
                    lead.contactTitle || "",
                    lead.contactLinkedin || "",
                    lead.contactEmail || "",
                    1,
                    "Contact provided by Clay enrichment",
                  ],
                );
              } catch (contactErr: any) {
                logger?.warn(`[sources/clay] Failed to store contact: ${contactErr.message}`);
              }
            }
          }

          logger?.info(`[sources/clay] Done: ${newJobIds.length} new, ${duplicateCount} duplicates`);

          return c.json({
            success: true,
            newJobIds,
            duplicateCount,
            totalReceived: leads.length,
            message: `Processed ${leads.length} leads. ${newJobIds.length} new jobs added.`,
          });
        } catch (err: any) {
          logger?.error(`[sources/clay] Webhook error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Job sources status ─────────────────────────────────────────── */
    {
      path: "/api/sources/status",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        try {
          // Count jobs by source
          const sourceCounts = await query(`
            SELECT source, COUNT(*) as count, MAX(date_ingested) as latest
            FROM jobs
            GROUP BY source
            ORDER BY count DESC
          `);

          // Recent jobs from each source
          const recentJobs = await query(`
            SELECT job_id, source, company, title, location, status, date_ingested
            FROM jobs
            ORDER BY date_ingested DESC
            LIMIT 20
          `);

          return c.json({
            sources: sourceCounts.rows,
            recentJobs: recentJobs.rows,
            integrations: {
              apollo: { configured: !!process.env.APOLLO_API_KEY },
              clay_outbound: { configured: !!process.env.CLAY_WEBHOOK_URL },
              clay_inbound: { configured: true, endpoint: "/api/sources/clay/webhook" },
              gmail: { configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN) },
              import_api: { configured: !!process.env.IMPORT_API_KEY, endpoint: "/api/import-emails" },
            },
          });
        } catch (err: any) {
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Manually trigger recruiter email scan ─────────────────────── */
    {
      path: "/api/sources/email/scan",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();

        try {
          const body = await c.req.json().catch(() => ({}));
          const label = body.label || process.env.GMAIL_LABEL || "Job Alerts";
          const maxResults = body.maxResults || 20;
          const includeRecruiter = body.includeRecruiter !== false;

          logger?.info(`[sources/email] Scanning Gmail label "${label}" (max: ${maxResults}, recruiter: ${includeRecruiter})`);

          // Import dynamically to avoid circular deps
          const { fetchEmailsFromLabel } = await import("./tools/gmailClient");
          const emails = await fetchEmailsFromLabel(label, maxResults);

          logger?.info(`[sources/email] Fetched ${emails.length} emails`);

          // If recruiter scanning enabled, also check inbox for recruiter patterns
          let recruiterEmails: any[] = [];
          if (includeRecruiter) {
            try {
              const { fetchEmailsFromLabel: fetch2 } = await import("./tools/gmailClient");
              // Search for recruiter outreach patterns
              recruiterEmails = await fetch2("INBOX", maxResults);
              recruiterEmails = recruiterEmails.filter((e: any) => isRecruiterEmail(e));
              logger?.info(`[sources/email] Found ${recruiterEmails.length} recruiter emails`);
            } catch (err: any) {
              logger?.warn(`[sources/email] Recruiter scan failed: ${err.message}`);
            }
          }

          return c.json({
            success: true,
            alertEmails: emails.length,
            recruiterEmails: recruiterEmails.length,
            totalEmails: emails.length + recruiterEmails.length,
            message: `Found ${emails.length} job alerts and ${recruiterEmails.length} recruiter emails. Run the workflow to process them.`,
          });
        } catch (err: any) {
          logger?.error(`[sources/email] Scan error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
  ];
}

/* ── Recruiter email detection ──────────────────────────────────── */

const RECRUITER_PATTERNS = [
  /i('m| am) (a |an )?(senior |lead |executive )?recruiter/i,
  /i('m| am) reaching out (about|regarding|for)/i,
  /i('d| would) love to (connect|chat|discuss|talk)/i,
  /i (came across|found|saw) your (profile|resume|background|linkedin)/i,
  /we (have|are hiring for) (a |an )?(exciting |great )?(new )?(role|position|opportunity)/i,
  /hiring (manager|team) (at|for|with)/i,
  /open (role|position|opportunity) (at|for|with)/i,
  /talent (acquisition|sourcing)/i,
  /are you (open to|interested in|exploring)/i,
  /your (background|experience|profile) (is|would be|seems|looks) (a |an )?(great |perfect |strong )?fit/i,
  /on behalf of (my client|our client)/i,
  /staffing|headhunter|executive search/i,
];

const RECRUITER_FROM_PATTERNS = [
  /recruiter|recruiting|talent|staffing|headhunt/i,
  /@(hays|robertwalters|kforce|teksystems|randstad|adecco|manpower)/i,
  /@(heidrick|spencer|kornferry|egon|russell|boyden)/i,
];

export function isRecruiterEmail(email: { subject?: string; from?: string; body?: string }): boolean {
  const subject = email.subject || "";
  const from = email.from || "";
  const body = email.body || "";

  // Check from address
  for (const pattern of RECRUITER_FROM_PATTERNS) {
    if (pattern.test(from)) return true;
  }

  // Check subject + body for recruiter language
  const text = `${subject} ${body}`;
  let matchCount = 0;
  for (const pattern of RECRUITER_PATTERNS) {
    if (pattern.test(text)) matchCount++;
    if (matchCount >= 2) return true; // Need at least 2 pattern matches
  }

  return false;
}

/**
 * Extracts job details from a recruiter outreach email.
 * Returns structured data ready for the parseJobsTool.
 */
export function parseRecruiterEmail(email: {
  id: string;
  subject: string;
  from: string;
  body: string;
}): {
  company: string;
  title: string;
  location: string;
  jd_text: string;
  source: string;
  source_message_id: string;
} | null {
  const body = email.body || "";
  const subject = email.subject || "";

  // Try to extract company name
  let company = "";
  const companyPatterns = [
    /(?:at|for|with|@)\s+([A-Z][A-Za-z0-9\s&]+?)(?:\s*[,.]|\s+(?:is|are|we|has|have|and|in|that|which))/,
    /(?:company|client|organization|firm)(?:\s+is)?\s*:?\s*([A-Z][A-Za-z0-9\s&]+?)(?:\s*[,.\n])/,
    /(?:join|joining)\s+([A-Z][A-Za-z0-9\s&]+?)(?:\s*[,.]|\s+(?:as|in|to|and))/,
  ];
  for (const pattern of companyPatterns) {
    const match = body.match(pattern) || subject.match(pattern);
    if (match) {
      company = match[1].trim();
      break;
    }
  }

  // Try to extract job title
  let title = "";
  const titlePatterns = [
    /(?:role|position|opportunity)\s+(?:of|as|for|is)\s*:?\s*([A-Z][A-Za-z\s/&,]+?)(?:\s*[,.\n]|\s+(?:at|in|for|with))/,
    /(?:hiring|looking)\s+(?:a|an|for)\s+([A-Z][A-Za-z\s/&,]+?)(?:\s*[,.\n]|\s+(?:at|in|for|with|to))/,
    /(?:VP|SVP|Director|Head|Chief|CDO|CTO|CIO)\s+(?:of\s+)?[A-Za-z\s&/]+/,
  ];
  for (const pattern of titlePatterns) {
    const match = body.match(pattern) || subject.match(pattern);
    if (match) {
      title = match[1] ? match[1].trim() : match[0].trim();
      break;
    }
  }

  // If we couldn't extract either company or title, use subject line
  if (!title && !company) {
    // Try subject line as last resort
    const subjectMatch = subject.match(/(?:opportunity|role|position).*?(?:at|for|with)\s+(.+)/i);
    if (subjectMatch) {
      company = subjectMatch[1].trim();
    }
  }

  if (!company && !title) return null;

  // Extract location
  let location = "";
  const locationPatterns = [
    /(?:location|based|located|office)\s*(?:in|:)\s*([A-Za-z\s,]+?)(?:\s*[.\n])/i,
    /(?:remote|hybrid|on-?site)/i,
  ];
  for (const pattern of locationPatterns) {
    const match = body.match(pattern);
    if (match) {
      location = match[1] ? match[1].trim() : match[0].trim();
      break;
    }
  }

  return {
    company: company || "Unknown (Recruiter Outreach)",
    title: title || subject.slice(0, 100),
    location,
    jd_text: `--- Recruiter Email ---\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${body}`,
    source: "recruiter",
    source_message_id: email.id,
  };
}
