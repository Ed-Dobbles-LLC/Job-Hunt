import { query } from "./tools/db";
import { findPublicFile } from "./tools/paths";
import * as fs from "fs";

let tableReady = false;
async function ensureSettingsTable() {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tableReady = true;
}

// Setting definitions: key, label, env var fallback, whether to mask in UI
const SETTING_DEFS = [
  { key: "openai_api_key", label: "OpenAI API Key", env: "OPENAI_API_KEY", secret: true, group: "AI" },
  { key: "preferred_metros", label: "Preferred Metro Areas (comma-separated)", env: "", secret: false, group: "Job Preferences", placeholder: "Chicago, New York, Dallas, Austin" },
  { key: "preferred_countries", label: "Accepted Countries (comma-separated)", env: "", secret: false, group: "Job Preferences", placeholder: "United States, Canada" },
  { key: "pref_remote", label: "Remote Work", env: "", secret: false, group: "Job Preferences", placeholder: "prefer, will-do, or no", options: ["prefer", "will-do", "no"] },
  { key: "pref_hybrid", label: "Hybrid Work", env: "", secret: false, group: "Job Preferences", placeholder: "prefer, will-do, or no", options: ["prefer", "will-do", "no"] },
  { key: "pref_onsite", label: "In-Office / On-Site", env: "", secret: false, group: "Job Preferences", placeholder: "prefer, will-do, or no", options: ["prefer", "will-do", "no"] },
  { key: "apollo_api_key", label: "Apollo API Key", env: "APOLLO_API_KEY", secret: true, group: "Job Sources" },
  { key: "clay_webhook_url", label: "Clay Outbound Webhook URL", env: "CLAY_WEBHOOK_URL", secret: false, group: "Job Sources" },
  { key: "clay_inbound_secret", label: "Clay Inbound Secret", env: "CLAY_INBOUND_SECRET", secret: true, group: "Job Sources" },
  { key: "google_client_id", label: "Google Client ID", env: "GOOGLE_CLIENT_ID", secret: false, group: "Email (Gmail)" },
  { key: "google_client_secret", label: "Google Client Secret", env: "GOOGLE_CLIENT_SECRET", secret: true, group: "Email (Gmail)" },
  { key: "google_refresh_token", label: "Google Refresh Token", env: "GOOGLE_REFRESH_TOKEN", secret: true, group: "Email (Gmail)" },
  { key: "gmail_label", label: "Gmail Label to Scan", env: "GMAIL_LABEL", secret: false, group: "Email (Gmail)" },
  { key: "digest_email", label: "Digest Recipient Email", env: "DIGEST_EMAIL", secret: false, group: "Email (Gmail)" },
  { key: "schedule_cron", label: "Cron Schedule", env: "SCHEDULE_CRON_EXPRESSION", secret: false, group: "Scheduling" },
  { key: "import_api_key", label: "Import API Key", env: "IMPORT_API_KEY", secret: true, group: "Security" },
  { key: "inngest_event_key", label: "Inngest Event Key", env: "INNGEST_EVENT_KEY", secret: true, group: "Inngest" },
  { key: "inngest_signing_key", label: "Inngest Signing Key", env: "INNGEST_SIGNING_KEY", secret: true, group: "Inngest" },
];

/** Get a setting value: DB first, then env var fallback */
export async function getSetting(key: string): Promise<string | undefined> {
  await ensureSettingsTable();
  const def = SETTING_DEFS.find((d) => d.key === key);
  // Check DB first
  const result = await query("SELECT value FROM app_settings WHERE key = $1", [key]);
  if (result.rows.length > 0 && result.rows[0].value) {
    return result.rows[0].value;
  }
  // Fall back to env var
  if (def?.env) {
    return process.env[def.env] || undefined;
  }
  return undefined;
}

function maskValue(val: string): string {
  if (val.length <= 8) return "****";
  return val.substring(0, 4) + "****" + val.substring(val.length - 4);
}

export function getSettingsRoutes() {
  return [
    // Serve settings HTML page
    {
      path: "/api/settings",
      method: "GET",
      createHandler: async () => async (c: any) => {
        const accept = c.req.header("accept") || "";
        if (accept.includes("text/html") || !accept.includes("application/json")) {
          const filePath = findPublicFile("settings.html");
          if (!filePath) {
            return c.text("Settings page not found", 404);
          }
          const html = fs.readFileSync(filePath, "utf-8");
          return c.html(html);
        }
        // JSON API: return current settings
        await ensureSettingsTable();
        const dbResult = await query("SELECT key, value FROM app_settings");
        const dbMap: Record<string, string> = {};
        for (const row of dbResult.rows) {
          dbMap[row.key] = row.value;
        }
        const settings = SETTING_DEFS.map((def) => {
          const dbVal = dbMap[def.key];
          const envVal = def.env ? process.env[def.env] : undefined;
          const rawValue = dbVal || envVal || "";
          const source = dbVal ? "database" : envVal ? "environment" : "not set";
          return {
            key: def.key,
            label: def.label,
            group: def.group,
            secret: def.secret,
            value: def.secret && rawValue ? maskValue(rawValue) : rawValue,
            source,
            hasValue: !!rawValue,
            options: (def as any).options || undefined,
            placeholder: (def as any).placeholder || undefined,
          };
        });
        return c.json({ settings });
      },
    },
    // Get settings as JSON (explicit JSON endpoint)
    {
      path: "/api/settings/list",
      method: "GET",
      createHandler: async () => async (c: any) => {
        await ensureSettingsTable();
        const dbResult = await query("SELECT key, value FROM app_settings");
        const dbMap: Record<string, string> = {};
        for (const row of dbResult.rows) {
          dbMap[row.key] = row.value;
        }
        const settings = SETTING_DEFS.map((def) => {
          const dbVal = dbMap[def.key];
          const envVal = def.env ? process.env[def.env] : undefined;
          const rawValue = dbVal || envVal || "";
          const source = dbVal ? "database" : envVal ? "environment" : "not set";
          return {
            key: def.key,
            label: def.label,
            group: def.group,
            secret: def.secret,
            value: def.secret && rawValue ? maskValue(rawValue) : rawValue,
            source,
            hasValue: !!rawValue,
            options: (def as any).options || undefined,
            placeholder: (def as any).placeholder || undefined,
          };
        });
        return c.json({ settings });
      },
    },
    // Update settings
    {
      path: "/api/settings",
      method: "POST",
      createHandler: async () => async (c: any) => {
        await ensureSettingsTable();
        const body = await c.req.json();
        const updates: Record<string, string> = body.settings || body;
        let updated = 0;
        for (const [key, value] of Object.entries(updates)) {
          const def = SETTING_DEFS.find((d) => d.key === key);
          if (!def) continue;
          // Skip masked values (user didn't change them)
          if (typeof value === "string" && value.includes("****")) continue;
          if (!value || (typeof value === "string" && value.trim() === "")) {
            // Empty = delete from DB (revert to env var)
            await query("DELETE FROM app_settings WHERE key = $1", [key]);
          } else {
            await query(
              `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
               ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
              [key, value]
            );
          }
          updated++;
        }
        return c.json({ success: true, updated });
      },
    },
  ];
}
