import { query } from "./tools/db";
import { getSetting } from "./settingsRoutes";

async function ensureSettingsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Check if the minimum configuration is in place */
export async function isSetupComplete(): Promise<boolean> {
  try {
    const openaiKey = await getSetting("openai_api_key");
    return !!openaiKey;
  } catch {
    return false;
  }
}

export function getSetupRoutes() {
  return [
    /* ── Setup status check (JSON) ──────────────────────── */
    {
      path: "/api/setup/status",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        try {
          await ensureSettingsTable();
          const openaiKey = await getSetting("openai_api_key");
          const googleClientId = await getSetting("google_client_id");
          const googleClientSecret = await getSetting("google_client_secret");
          const googleRefreshToken = await getSetting("google_refresh_token");
          const gmailLabel = await getSetting("gmail_label");
          const dbConnected = !!process.env.DATABASE_URL;

          return c.json({
            setupComplete: !!openaiKey,
            steps: {
              database: { configured: dbConnected, required: true },
              openai: { configured: !!openaiKey, required: true },
              gmail: {
                configured: !!(googleClientId && googleClientSecret && googleRefreshToken),
                required: false,
                hasClientId: !!googleClientId,
                hasClientSecret: !!googleClientSecret,
                hasRefreshToken: !!googleRefreshToken,
                label: gmailLabel || "Job Alerts",
              },
            },
          });
        } catch (err: any) {
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Save a setting from setup ──────────────────────── */
    {
      path: "/api/setup/save",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        try {
          await ensureSettingsTable();
          const body = await c.req.json();
          const { key, value } = body;

          if (!key || !value) {
            return c.json({ error: "key and value required" }, 400);
          }

          // Allowlist of keys that can be set through setup
          const allowed = [
            "openai_api_key", "google_client_id", "google_client_secret",
            "google_refresh_token", "gmail_label", "digest_email",
            "preferred_metros", "preferred_countries",
            "pref_remote", "pref_hybrid", "pref_onsite",
          ];
          if (!allowed.includes(key)) {
            return c.json({ error: `Setting '${key}' not allowed via setup` }, 400);
          }

          await query(
            `INSERT INTO app_settings (key, value, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, value.trim()],
          );

          return c.json({ success: true, key });
        } catch (err: any) {
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Google OAuth: generate auth URL ────────────────── */
    {
      path: "/api/setup/gmail/auth-url",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        try {
          const body = await c.req.json();
          const clientId = body.client_id;
          const redirectUri = body.redirect_uri;

          if (!clientId) {
            return c.json({ error: "client_id is required" }, 400);
          }

          const scopes = [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.labels",
          ];

          const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri || "urn:ietf:wg:oauth:2.0:oob",
            response_type: "code",
            scope: scopes.join(" "),
            access_type: "offline",
            prompt: "consent",
          });

          const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
          return c.json({ authUrl });
        } catch (err: any) {
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Google OAuth: exchange code for refresh token ──── */
    {
      path: "/api/setup/gmail/exchange-code",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        try {
          await ensureSettingsTable();
          const body = await c.req.json();
          const { code, client_id, client_secret, redirect_uri } = body;

          if (!code || !client_id || !client_secret) {
            return c.json({ error: "code, client_id, and client_secret are required" }, 400);
          }

          // Exchange authorization code for tokens
          const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code,
              client_id,
              client_secret,
              redirect_uri: redirect_uri || "urn:ietf:wg:oauth:2.0:oob",
              grant_type: "authorization_code",
            }),
          });

          const tokenData: any = await tokenResponse.json();

          if (tokenData.error) {
            return c.json({
              error: `Google OAuth error: ${tokenData.error_description || tokenData.error}`,
            }, 400);
          }

          if (!tokenData.refresh_token) {
            return c.json({
              error: "No refresh token received. Make sure you used prompt=consent and access_type=offline.",
            }, 400);
          }

          // Save all three credentials to settings
          for (const [key, value] of [
            ["google_client_id", client_id],
            ["google_client_secret", client_secret],
            ["google_refresh_token", tokenData.refresh_token],
          ] as const) {
            await query(
              `INSERT INTO app_settings (key, value, updated_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
              [key, value],
            );
          }

          return c.json({
            success: true,
            message: "Gmail connected successfully! Refresh token saved.",
          });
        } catch (err: any) {
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Test Gmail connection ───────────────────────────── */
    {
      path: "/api/setup/gmail/test",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        try {
          const clientId = await getSetting("google_client_id");
          const clientSecret = await getSetting("google_client_secret");
          const refreshToken = await getSetting("google_refresh_token");

          if (!clientId || !clientSecret || !refreshToken) {
            return c.json({ success: false, error: "Gmail credentials not configured" }, 400);
          }

          // Try to get an access token to verify credentials work
          const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            }),
          });

          const tokenData: any = await tokenResponse.json();

          if (tokenData.error) {
            return c.json({
              success: false,
              error: `Token refresh failed: ${tokenData.error_description || tokenData.error}`,
            });
          }

          // Try to list labels to verify Gmail access
          const labelsResponse = await fetch(
            "https://gmail.googleapis.com/gmail/v1/users/me/labels",
            { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
          );
          const labelsData: any = await labelsResponse.json();

          if (labelsData.error) {
            return c.json({
              success: false,
              error: `Gmail API error: ${labelsData.error.message}`,
            });
          }

          const labelNames = (labelsData.labels || []).map((l: any) => l.name).sort();
          const gmailLabel = await getSetting("gmail_label") || "Job Alerts";
          const hasJobLabel = labelNames.some((n: string) =>
            n.toLowerCase() === gmailLabel.toLowerCase(),
          );

          return c.json({
            success: true,
            labelCount: labelNames.length,
            hasJobLabel,
            configuredLabel: gmailLabel,
            userLabels: labelNames.filter((n: string) =>
              !n.startsWith("CATEGORY_") && !["INBOX","SENT","DRAFT","SPAM","TRASH","STARRED","UNREAD","IMPORTANT","CHAT"].includes(n),
            ),
          });
        } catch (err: any) {
          return c.json({ success: false, error: err.message }, 500);
        }
      },
    },
    /* ── Setup wizard HTML page ─────────────────────────── */
    {
      path: "/setup",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const html = getSetupWizardHtml();
        return c.html(html);
      },
    },
  ];
}

function getSetupWizardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Job Hunt - Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0c1421; --surface: #132035; --surface2: #1a2a42; --border: #1e3554;
      --text: #e8ecf1; --text-dim: #7a8ba5; --text-muted: #4e6380;
      --accent: #e85d4a; --accent-hover: #f06b59;
      --green: #22c55e; --green-soft: rgba(34,197,94,0.12);
      --yellow: #eab308; --yellow-soft: rgba(234,179,8,0.12);
      --blue: #3b82f6; --blue-soft: rgba(59,130,246,0.12);
      --red: #ef4444;
    }
    body { font-family: 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; justify-content:center; padding:40px 20px; }
    .setup-container { max-width:680px; width:100%; }
    .header { text-align:center; margin-bottom:40px; }
    .header h1 { font-size:28px; margin-bottom:8px; }
    .header p { color:var(--text-dim); font-size:15px; }
    .step { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:24px; margin-bottom:16px; transition:border-color 0.2s; }
    .step.active { border-color:var(--blue); }
    .step.done { border-color:var(--green); }
    .step-header { display:flex; align-items:center; gap:12px; cursor:pointer; }
    .step-num { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; background:var(--surface2); color:var(--text-dim); flex-shrink:0; }
    .step.done .step-num { background:var(--green-soft); color:var(--green); }
    .step.active .step-num { background:var(--blue-soft); color:var(--blue); }
    .step-title { font-weight:600; font-size:16px; flex:1; }
    .step-badge { font-size:11px; padding:2px 10px; border-radius:10px; font-weight:600; }
    .badge-done { background:var(--green-soft); color:var(--green); }
    .badge-required { background:var(--yellow-soft); color:var(--yellow); }
    .badge-optional { background:var(--surface2); color:var(--text-dim); }
    .step-body { display:none; margin-top:16px; padding-top:16px; border-top:1px solid var(--border); }
    .step.active .step-body { display:block; }
    .step-desc { font-size:13px; color:var(--text-dim); margin-bottom:16px; line-height:1.6; }
    .form-group { margin-bottom:14px; }
    .form-group label { display:block; font-size:13px; font-weight:600; margin-bottom:6px; }
    .form-group .hint { font-size:11px; color:var(--text-muted); margin-top:4px; }
    input[type="text"], input[type="password"], input[type="email"], select {
      width:100%; padding:10px 14px; background:var(--surface2); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:14px; outline:none;
    }
    input:focus, select:focus { border-color:var(--blue); }
    .btn { padding:10px 20px; border-radius:8px; border:none; font-size:13px; font-weight:600; cursor:pointer; transition:all 0.15s; }
    .btn-primary { background:var(--accent); color:white; }
    .btn-primary:hover { background:var(--accent-hover); }
    .btn-primary:disabled { opacity:0.5; cursor:not-allowed; }
    .btn-secondary { background:var(--surface2); color:var(--text); border:1px solid var(--border); }
    .btn-secondary:hover { background:var(--border); }
    .btn-success { background:var(--green); color:white; }
    .btn-row { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
    .status-msg { padding:10px 14px; border-radius:8px; font-size:13px; margin-top:12px; display:none; }
    .status-msg.success { display:block; background:var(--green-soft); color:var(--green); }
    .status-msg.error { display:block; background:rgba(239,68,68,0.12); color:var(--red); }
    .status-msg.info { display:block; background:var(--blue-soft); color:var(--blue); }
    .oauth-steps { font-size:13px; color:var(--text-dim); line-height:1.8; }
    .oauth-steps ol { padding-left:20px; }
    .oauth-steps a { color:var(--blue); text-decoration:none; }
    .oauth-steps a:hover { text-decoration:underline; }
    .code-box { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:10px 14px; font-family:monospace; font-size:12px; word-break:break-all; margin:8px 0; }
    .finish-section { text-align:center; margin-top:32px; }
    .finish-section .btn { font-size:16px; padding:14px 40px; }
    .spinner { display:inline-block; width:14px; height:14px; border:2px solid transparent; border-top-color:currentColor; border-radius:50%; animation:spin 0.6s linear infinite; vertical-align:middle; margin-right:6px; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .skip-link { font-size:12px; color:var(--text-muted); cursor:pointer; margin-left:8px; }
    .skip-link:hover { color:var(--text-dim); text-decoration:underline; }
  </style>
</head>
<body>
  <div class="setup-container">
    <div class="header">
      <h1>Job Hunt Setup</h1>
      <p>Let's get you configured in a few minutes. Only OpenAI is required to start.</p>
    </div>

    <!-- Step 1: OpenAI -->
    <div class="step active" id="step-1">
      <div class="step-header" onclick="toggleStep(1)">
        <div class="step-num">1</div>
        <div class="step-title">OpenAI API Key</div>
        <span class="step-badge badge-required" id="badge-1">Required</span>
      </div>
      <div class="step-body">
        <div class="step-desc">
          This powers all AI features: job scoring, resume/cover letter generation, and web search enrichment.
          Get your key from <a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--blue)">platform.openai.com/api-keys</a>.
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="password" id="openai-key" placeholder="sk-...">
          <div class="hint">Starts with "sk-". We'll verify it works before saving.</div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="saveOpenAI()">Verify &amp; Save</button>
        </div>
        <div class="status-msg" id="status-1"></div>
      </div>
    </div>

    <!-- Step 2: Gmail (Optional) -->
    <div class="step" id="step-2">
      <div class="step-header" onclick="toggleStep(2)">
        <div class="step-num">2</div>
        <div class="step-title">Gmail Connection</div>
        <span class="step-badge badge-optional" id="badge-2">Optional</span>
      </div>
      <div class="step-body">
        <div class="step-desc">
          Connect Gmail to automatically ingest job alerts from LinkedIn, Indeed, etc.
          <strong>Skip this if you prefer to import jobs via Excel/CSV.</strong>
        </div>

        <div class="oauth-steps">
          <ol>
            <li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console &rarr; Credentials</a></li>
            <li>Create a project (or select existing), then click <strong>Create Credentials &rarr; OAuth Client ID</strong></li>
            <li>Set application type to <strong>Web Application</strong></li>
            <li>Under "Authorized redirect URIs", add: <div class="code-box" id="redirectUri"></div></li>
            <li>Enable the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank">Gmail API</a> for your project</li>
            <li>Copy your Client ID and Client Secret below:</li>
          </ol>
        </div>

        <div class="form-group" style="margin-top:16px">
          <label>Client ID</label>
          <input type="text" id="gmail-client-id" placeholder="123456789.apps.googleusercontent.com">
        </div>
        <div class="form-group">
          <label>Client Secret</label>
          <input type="password" id="gmail-client-secret" placeholder="GOCSPX-...">
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="startGmailAuth()" id="gmail-auth-btn">Connect Gmail</button>
          <span class="skip-link" onclick="skipStep(2)">Skip for now</span>
        </div>
        <div class="status-msg" id="status-2"></div>

        <!-- Token exchange (shown after auth) -->
        <div id="gmail-code-section" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <div class="form-group">
            <label>Authorization Code</label>
            <input type="text" id="gmail-auth-code" placeholder="Paste the code from Google here">
            <div class="hint">After approving access, Google will show you a code. Paste it here.</div>
          </div>
          <div class="btn-row">
            <button class="btn btn-primary" onclick="exchangeGmailCode()">Exchange &amp; Save</button>
          </div>
        </div>

        <!-- Gmail test (shown after connected) -->
        <div id="gmail-test-section" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <div class="form-group">
            <label>Gmail Label for Job Alerts</label>
            <input type="text" id="gmail-label" placeholder="Job Alerts" value="Job Alerts">
            <div class="hint">Create this label in Gmail and filter your job alert emails there.</div>
          </div>
          <div class="btn-row">
            <button class="btn btn-secondary" onclick="testGmail()">Test Connection</button>
            <button class="btn btn-primary" onclick="saveGmailLabel()">Save Label</button>
          </div>
          <div class="status-msg" id="status-2-test"></div>
        </div>
      </div>
    </div>

    <!-- Step 3: Job Preferences -->
    <div class="step" id="step-3">
      <div class="step-header" onclick="toggleStep(3)">
        <div class="step-num">3</div>
        <div class="step-title">Job Preferences</div>
        <span class="step-badge badge-optional" id="badge-3">Optional</span>
      </div>
      <div class="step-body">
        <div class="step-desc">
          Set your location and work style preferences. These improve job scoring accuracy.
          You can change these anytime from the dashboard.
        </div>
        <div class="form-group">
          <label>Preferred Metro Areas (comma-separated)</label>
          <input type="text" id="pref-metros" placeholder="Chicago, New York, Austin, Dallas">
        </div>
        <div class="form-group">
          <label>Accepted Countries (comma-separated)</label>
          <input type="text" id="pref-countries" placeholder="United States, Canada" value="United States">
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div class="form-group" style="flex:1;min-width:150px">
            <label>Remote Work</label>
            <select id="pref-remote"><option value="">--</option><option value="prefer">Prefer</option><option value="will-do">Will Do</option><option value="no">No</option></select>
          </div>
          <div class="form-group" style="flex:1;min-width:150px">
            <label>Hybrid Work</label>
            <select id="pref-hybrid"><option value="">--</option><option value="prefer">Prefer</option><option value="will-do">Will Do</option><option value="no">No</option></select>
          </div>
          <div class="form-group" style="flex:1;min-width:150px">
            <label>In-Office</label>
            <select id="pref-onsite"><option value="">--</option><option value="prefer">Prefer</option><option value="will-do">Will Do</option><option value="no">No</option></select>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="savePreferences()">Save Preferences</button>
          <span class="skip-link" onclick="skipStep(3)">Skip for now</span>
        </div>
        <div class="status-msg" id="status-3"></div>
      </div>
    </div>

    <!-- Finish -->
    <div class="finish-section" id="finish-section" style="display:none">
      <p style="color:var(--text-dim);margin-bottom:16px">You're all set! Head to the dashboard to start finding jobs.</p>
      <a class="btn btn-success" href="/dashboard" style="text-decoration:none;display:inline-block">Go to Dashboard &rarr;</a>
      <p style="margin-top:12px;font-size:12px;color:var(--text-muted)">
        You can import jobs via Excel/CSV from the dashboard, or connect Gmail above to auto-ingest.
      </p>
    </div>
  </div>

  <script>
    const API = '/api/setup';
    let currentStep = 1;
    let stepStatus = { 1: false, 2: false, 3: false };

    // Set redirect URI for OAuth
    document.getElementById('redirectUri').textContent = window.location.origin + '/api/setup/gmail/callback';

    async function checkStatus() {
      try {
        const res = await fetch(API + '/status');
        const data = await res.json();
        if (data.steps.openai.configured) { markDone(1); }
        if (data.steps.gmail.configured) {
          markDone(2);
          document.getElementById('gmail-test-section').style.display = 'block';
        }
      } catch {}
    }
    checkStatus();

    function toggleStep(n) {
      const step = document.getElementById('step-' + n);
      if (step.classList.contains('active')) {
        step.classList.remove('active');
      } else {
        document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
        step.classList.add('active');
        currentStep = n;
      }
    }

    function markDone(n) {
      stepStatus[n] = true;
      const step = document.getElementById('step-' + n);
      step.classList.add('done');
      const badge = document.getElementById('badge-' + n);
      badge.className = 'step-badge badge-done';
      badge.textContent = 'Done';

      // Show finish button if step 1 is done
      if (stepStatus[1]) {
        document.getElementById('finish-section').style.display = 'block';
      }

      // Auto-advance to next step
      if (n < 3) {
        setTimeout(() => toggleStep(n + 1), 300);
      }
    }

    function skipStep(n) {
      document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
      if (n < 3) toggleStep(n + 1);
      if (n === 3 && stepStatus[1]) {
        document.getElementById('finish-section').style.display = 'block';
      }
    }

    function showStatus(stepN, msg, type) {
      const el = document.getElementById('status-' + stepN);
      el.textContent = msg;
      el.className = 'status-msg ' + type;
    }

    async function saveOpenAI() {
      const key = document.getElementById('openai-key').value.trim();
      if (!key || !key.startsWith('sk-')) {
        showStatus(1, 'Please enter a valid OpenAI API key (starts with sk-)', 'error');
        return;
      }

      showStatus(1, 'Verifying key...', 'info');

      try {
        // Quick verification: list models
        const testRes = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': 'Bearer ' + key },
        });

        if (!testRes.ok) {
          const err = await testRes.json().catch(() => ({}));
          showStatus(1, 'Invalid key: ' + (err.error?.message || 'API returned ' + testRes.status), 'error');
          return;
        }

        // Save to settings
        const saveRes = await fetch(API + '/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'openai_api_key', value: key }),
        });
        const saveData = await saveRes.json();

        if (saveData.success) {
          showStatus(1, 'OpenAI key verified and saved!', 'success');
          markDone(1);
        } else {
          showStatus(1, 'Save failed: ' + saveData.error, 'error');
        }
      } catch (e) {
        showStatus(1, 'Error: ' + e.message, 'error');
      }
    }

    async function startGmailAuth() {
      const clientId = document.getElementById('gmail-client-id').value.trim();
      const clientSecret = document.getElementById('gmail-client-secret').value.trim();

      if (!clientId || !clientSecret) {
        showStatus(2, 'Please enter both Client ID and Client Secret', 'error');
        return;
      }

      showStatus(2, 'Generating authorization URL...', 'info');

      try {
        const res = await fetch(API + '/gmail/auth-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId,
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
          }),
        });
        const data = await res.json();

        if (data.authUrl) {
          window.open(data.authUrl, '_blank');
          showStatus(2, 'A new tab opened for Google authorization. After approving, paste the code below.', 'info');
          document.getElementById('gmail-code-section').style.display = 'block';
        } else {
          showStatus(2, 'Failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (e) {
        showStatus(2, 'Error: ' + e.message, 'error');
      }
    }

    async function exchangeGmailCode() {
      const code = document.getElementById('gmail-auth-code').value.trim();
      const clientId = document.getElementById('gmail-client-id').value.trim();
      const clientSecret = document.getElementById('gmail-client-secret').value.trim();

      if (!code) {
        showStatus(2, 'Please paste the authorization code', 'error');
        return;
      }

      showStatus(2, 'Exchanging code for credentials...', 'info');

      try {
        const res = await fetch(API + '/gmail/exchange-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
          }),
        });
        const data = await res.json();

        if (data.success) {
          showStatus(2, 'Gmail connected! Credentials saved.', 'success');
          document.getElementById('gmail-code-section').style.display = 'none';
          document.getElementById('gmail-test-section').style.display = 'block';
          markDone(2);
        } else {
          showStatus(2, 'Error: ' + data.error, 'error');
        }
      } catch (e) {
        showStatus(2, 'Error: ' + e.message, 'error');
      }
    }

    async function testGmail() {
      const statusEl = document.getElementById('status-2-test');
      statusEl.textContent = 'Testing connection...';
      statusEl.className = 'status-msg info';

      try {
        const res = await fetch(API + '/gmail/test', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          let msg = 'Gmail connected! Found ' + data.labelCount + ' labels.';
          if (data.hasJobLabel) {
            msg += ' Label "' + data.configuredLabel + '" found.';
          } else {
            msg += ' Warning: label "' + data.configuredLabel + '" not found. Available labels: ' + data.userLabels.join(', ');
          }
          statusEl.textContent = msg;
          statusEl.className = 'status-msg ' + (data.hasJobLabel ? 'success' : 'error');
        } else {
          statusEl.textContent = 'Connection failed: ' + data.error;
          statusEl.className = 'status-msg error';
        }
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.className = 'status-msg error';
      }
    }

    async function saveGmailLabel() {
      const label = document.getElementById('gmail-label').value.trim();
      if (!label) return;

      try {
        await fetch(API + '/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'gmail_label', value: label }),
        });
        const statusEl = document.getElementById('status-2-test');
        statusEl.textContent = 'Label "' + label + '" saved!';
        statusEl.className = 'status-msg success';
      } catch (e) {
        const statusEl = document.getElementById('status-2-test');
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.className = 'status-msg error';
      }
    }

    async function savePreferences() {
      const prefs = {
        preferred_metros: document.getElementById('pref-metros').value.trim(),
        preferred_countries: document.getElementById('pref-countries').value.trim(),
        pref_remote: document.getElementById('pref-remote').value,
        pref_hybrid: document.getElementById('pref-hybrid').value,
        pref_onsite: document.getElementById('pref-onsite').value,
      };

      showStatus(3, 'Saving...', 'info');

      try {
        for (const [key, value] of Object.entries(prefs)) {
          if (value) {
            await fetch(API + '/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key, value }),
            });
          }
        }
        showStatus(3, 'Preferences saved!', 'success');
        markDone(3);
      } catch (e) {
        showStatus(3, 'Error: ' + e.message, 'error');
      }
    }
  </script>
</body>
</html>`;
}
