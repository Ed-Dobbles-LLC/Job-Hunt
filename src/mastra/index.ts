import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { z } from "zod";

// Alias OPENAI_API_KEY → AI_INTEGRATIONS_OPENAI_API_KEY so all tools find it
if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY && process.env.OPENAI_API_KEY) {
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
}

import { sharedPostgresStorage } from "./storage";

// Inngest is optional — only loaded if keys are configured
let inngest: any = null;
let inngestServe: any = null;
const inngestConfigured = !!(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY);
if (inngestConfigured) {
  try {
    const inngestModule = require("./inngest");
    inngest = inngestModule.inngest;
    inngestServe = inngestModule.inngestServe;
    console.log("✅ [Inngest] Loaded (keys configured)");
  } catch (err: any) {
    console.warn(`⚠️ [Inngest] Failed to load: ${err.message}. Workflow will run via direct scheduler.`);
  }
} else {
  console.log("ℹ️ [Inngest] Skipped (no keys configured). Workflow runs via built-in scheduler.");
}

import { jobMatchWorkflow, runWorkflowDirectly } from "./workflows/jobMatchWorkflow";
import { jobMatchAgent } from "./agents/jobMatchAgent";
import { getDashboardRoutes } from "./dashboardRoutes";
import { getProfileBuilderRoutes } from "./profileBuilderRoutes";
import { getJobSourceRoutes } from "./jobSourceRoutes";
import { getSettingsRoutes } from "./settingsRoutes";
import { getSetupRoutes, isSetupComplete } from "./setupRoutes";

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  workflows: { jobMatchWorkflow },
  agents: { jobMatchAgent },
  bundler: {
    // A few dependencies are not properly picked up by
    // the bundler if they are not added directly to the
    // entrypoint.
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
      "mammoth",
      "pdf-parse",
      "docx",
      "googleapis",
      "pg",
      "xlsx",
    ],
    // sourcemaps are good for debugging.
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });
        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
            error,
          });
          // Log but re-throw; Inngest NonRetriableError wrapping removed since Inngest is optional
          throw error;
        }
      },
    ],
    apiRoutes: [
      {
        path: "/",
        method: "GET" as const,
        createHandler: async () => async (c: any) => {
          try {
            const ready = await isSetupComplete();
            return c.redirect(ready ? "/dashboard" : "/setup");
          } catch {
            return c.redirect("/setup");
          }
        },
      },
      {
        path: "/api/health",
        method: "GET",
        createHandler: async () => async (c: any) => {
          return c.json({ status: "ok", timestamp: new Date().toISOString() });
        },
      },
      ...getSetupRoutes(),
      ...getDashboardRoutes(),
      ...getProfileBuilderRoutes(),
      ...getJobSourceRoutes(),
      ...getSettingsRoutes(),
      ...(inngestConfigured && inngestServe ? [{
        path: "/api/inngest",
        method: "ALL" as const,
        createHandler: async ({ mastra }: any) => inngestServe({ mastra, inngest }),
      }] : []),

      {
        path: "/api/import-emails",
        method: "POST",
        createHandler: async ({ mastra }) => async (c: any) => {
          const logger = mastra.getLogger();
          const apiKey = process.env.IMPORT_API_KEY;
          const authHeader = c.req.header("x-api-key") || c.req.header("authorization")?.replace("Bearer ", "");
          if (apiKey && authHeader !== apiKey) {
            return c.json({ success: false, error: "Unauthorized" }, 401);
          }

          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          try {
            const body = await c.req.json();
            const emails = Array.isArray(body) ? body : [body];
            logger?.info(`📥 [importEmails] Importing ${emails.length} emails`);

            let imported = 0;
            for (const email of emails) {
              const subject = email.subject || "Imported Job Alert";
              const from = email.from || "imported";
              const emailBody = email.body || email.text || email.content || "";
              const date = email.date || new Date().toISOString();

              if (!emailBody || emailBody.trim().length < 10) {
                logger?.warn(`⚠️ [importEmails] Skipping email with empty body: ${subject}`);
                continue;
              }

              const dupeCheck = await pool.query(
                `SELECT id FROM imported_emails WHERE subject = $1 AND body = $2 LIMIT 1`,
                [subject, emailBody]
              );
              if (dupeCheck.rows.length > 0) {
                logger?.info(`⏭️ [importEmails] Duplicate skipped: ${subject}`);
                continue;
              }

              await pool.query(
                `INSERT INTO imported_emails (subject, from_address, date_received, body) VALUES ($1, $2, $3, $4)`,
                [subject, from, date, emailBody]
              );
              imported++;
              logger?.info(`✅ [importEmails] Imported: ${subject}`);
            }

            return c.json({ success: true, imported, message: `Imported ${imported} email(s). Run the workflow to process them.` });
          } catch (err: any) {
            logger?.error(`❌ [importEmails] Error: ${err.message}`);
            return c.json({ success: false, error: err.message }, 500);
          } finally {
            await pool.end();
          }
        },
      },
      {
        path: "/api/import-emails",
        method: "GET",
        createHandler: async ({ mastra }) => async (c: any) => {
          const apiKey = process.env.IMPORT_API_KEY;
          const authHeader = c.req.header("x-api-key") || c.req.header("authorization")?.replace("Bearer ", "");
          if (apiKey && authHeader !== apiKey) {
            return c.json({ success: false, error: "Unauthorized" }, 401);
          }

          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          try {
            const result = await pool.query(
              `SELECT id, subject, from_address, date_received, processed, LENGTH(body) as body_length FROM imported_emails ORDER BY created_at DESC`
            );
            return c.json({ emails: result.rows, count: result.rows.length });
          } finally {
            await pool.end();
          }
        },
      },
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "Mastra",
          level: "info",
        })
      : new PinoLogger({
          name: "Mastra",
          level: "info",
        }),
});

/*  Sanity check 1: Throw an error if there are more than 1 workflows.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

/*  Sanity check 2: Throw an error if there are more than 1 agents.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error(
    "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

// Simple in-process scheduler — supports multiple daily runs
// SCHEDULE_CRON_EXPRESSION: morning run (default 12:30 UTC / ~7:30 AM ET)
// SCHEDULE_CRON_EXPRESSION_2: evening run (default 00:00 UTC / ~7:00 PM ET)
const schedules = [
  process.env.SCHEDULE_CRON_EXPRESSION || "30 12 * * *",
  process.env.SCHEDULE_CRON_EXPRESSION_2 || "0 0 * * *",
].map((expr) => {
  const [min, hour] = expr.split(" ").map(Number);
  return { expr, min, hour, lastRunDate: "" };
});

setInterval(() => {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  for (const sched of schedules) {
    if (
      now.getUTCHours() === sched.hour &&
      now.getUTCMinutes() === sched.min &&
      sched.lastRunDate !== today
    ) {
      sched.lastRunDate = today;
      console.log(`🕐 [Scheduler] Starting workflow (${sched.expr})`);
      runWorkflowDirectly(mastra)
        .then((result) => {
          console.log(`✅ [Scheduler] Workflow completed: ${result.summary}`);
        })
        .catch((err) => {
          console.error(`❌ [Scheduler] Workflow failed: ${err.message}`);
        });
      break; // Only run one schedule per tick
    }
  }
}, 60_000);
