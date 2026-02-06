import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchEmailsFromLabel, type RawEmail } from "./gmailClient";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";
import { query } from "./db";

const USE_FIXTURES = process.env.USE_FIXTURES === "true";
const GMAIL_LABEL = process.env.GMAIL_LABEL || "JOB_ALERTS";

async function loadImportedEmails(maxResults: number): Promise<RawEmail[]> {
  try {
    const result = await query(
      `SELECT id, subject, from_address, date_received, body FROM imported_emails WHERE processed = FALSE ORDER BY created_at DESC LIMIT $1`,
      [maxResults]
    );

    if (result.rows.length > 0) {
      await query(
        `UPDATE imported_emails SET processed = TRUE WHERE id = ANY($1::int[])`,
        [result.rows.map((r: any) => r.id)]
      );
    }

    return result.rows.map((row: any) => ({
      id: `imported-${row.id}`,
      subject: row.subject,
      from: row.from_address,
      date: row.date_received?.toISOString() || new Date().toISOString(),
      body: row.body,
    }));
  } catch (err) {
    console.error("Failed to load imported emails:", err);
    return [];
  }
}

function loadFixtureEmails(): RawEmail[] {
  const fixturesDir = workspacePath("fixtures/emails");
  if (!fs.existsSync(fixturesDir)) {
    return [];
  }
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
  const emails: RawEmail[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, file), "utf-8"),
      );
      emails.push(data);
    } catch (err) {
      console.error(`Failed to load fixture ${file}:`, err);
    }
  }
  return emails;
}

export const fetchEmailsTool = createTool({
  id: "fetch-emails",
  description:
    "Fetches job alert emails from Gmail JOB_ALERTS label or loads fixture emails in dry-run mode",
  inputSchema: z.object({
    labelName: z
      .string()
      .optional()
      .describe("Gmail label to fetch from, defaults to JOB_ALERTS"),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of emails to fetch"),
  }),
  outputSchema: z.object({
    emails: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        from: z.string(),
        date: z.string(),
        body: z.string(),
      }),
    ),
    count: z.number(),
    source: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const label = context.labelName || GMAIL_LABEL;
    const max = context.maxResults || 20;

    if (USE_FIXTURES) {
      logger?.info("📧 [fetchEmails] Using fixture emails (dry-run mode)");
      const emails = loadFixtureEmails();
      logger?.info(
        `📧 [fetchEmails] Loaded ${emails.length} fixture emails`,
      );
      return { emails, count: emails.length, source: "fixtures" };
    }

    const allEmails: RawEmail[] = [];
    let source = "";

    const importedEmails = await loadImportedEmails(max);
    if (importedEmails.length > 0) {
      logger?.info(
        `📥 [fetchEmails] Found ${importedEmails.length} imported emails in database`,
      );
      allEmails.push(...importedEmails);
      source = "imported";
    }

    logger?.info(
      `📧 [fetchEmails] Fetching emails from Gmail label: ${label}`,
    );
    try {
      const gmailEmails = await fetchEmailsFromLabel(label, max);
      if (gmailEmails.length > 0) {
        logger?.info(
          `📧 [fetchEmails] Fetched ${gmailEmails.length} emails from Gmail`,
        );
        allEmails.push(...gmailEmails);
        source = source ? `${source}+gmail` : "gmail";
      }
    } catch (err) {
      logger?.warn(
        `⚠️ [fetchEmails] Gmail fetch failed: ${err}`,
      );
    }

    if (allEmails.length > 0) {
      logger?.info(
        `📧 [fetchEmails] Total emails: ${allEmails.length} (source: ${source})`,
      );
      return { emails: allEmails, count: allEmails.length, source };
    }

    logger?.info("📧 [fetchEmails] No emails found from any source, falling back to fixtures");
    const fixtureEmails = loadFixtureEmails();
    return { emails: fixtureEmails, count: fixtureEmails.length, source: "fixtures-fallback" };
  },
});
