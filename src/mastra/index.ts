import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { NonRetriableError } from "inngest";
import { z } from "zod";

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";

import { registerCronTrigger } from "../triggers/cronTriggers";
import { jobMatchWorkflow } from "./workflows/jobMatchWorkflow";
import { jobMatchAgent } from "./agents/jobMatchAgent";
import { getDashboardRoutes } from "./dashboardRoutes";

registerCronTrigger({
  cronExpression: process.env.SCHEDULE_CRON_EXPRESSION || "30 12 * * *",
  workflow: jobMatchWorkflow,
});

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
      "@ai-sdk/openai",
      "ai",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
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
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              // This is typically a non-retirable error. It means that the request was not
              // setup correctly to pass in the necessary parameters.
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            // Validation errors are never retriable.
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }
      },
    ],
    apiRoutes: [
      ...getDashboardRoutes(),
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },

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
try {
  if (typeof mastra.getWorkflows === "function" && Object.keys(mastra.getWorkflows()).length > 1) {
    throw new Error(
      "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
    );
  }
} catch (e: any) {
  if (e.message?.includes("More than 1")) throw e;
}

/*  Sanity check 2: Throw an error if there are more than 1 agents.  */
// !!!!!! Do not remove this check. !!!!!!
try {
  if (typeof mastra.getAgents === "function" && Object.keys(mastra.getAgents()).length > 1) {
    throw new Error(
      "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
    );
  }
} catch (e: any) {
  if (e.message?.includes("More than 1")) throw e;
}
