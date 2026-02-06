import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchEmailsFromLabel, type RawEmail } from "./gmailClient";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";

const USE_FIXTURES = process.env.USE_FIXTURES === "true";

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
    const label = context.labelName || "JOB_ALERTS";
    const max = context.maxResults || 20;

    if (USE_FIXTURES) {
      logger?.info("📧 [fetchEmails] Using fixture emails (dry-run mode)");
      const emails = loadFixtureEmails();
      logger?.info(
        `📧 [fetchEmails] Loaded ${emails.length} fixture emails`,
      );
      return { emails, count: emails.length, source: "fixtures" };
    }

    logger?.info(
      `📧 [fetchEmails] Fetching emails from Gmail label: ${label}`,
    );
    try {
      const emails = await fetchEmailsFromLabel(label, max);
      logger?.info(
        `📧 [fetchEmails] Fetched ${emails.length} emails from Gmail`,
      );
      return { emails, count: emails.length, source: "gmail" };
    } catch (err) {
      logger?.error(
        `❌ [fetchEmails] Gmail fetch failed, falling back to fixtures: ${err}`,
      );
      const emails = loadFixtureEmails();
      return { emails, count: emails.length, source: "fixtures-fallback" };
    }
  },
});
