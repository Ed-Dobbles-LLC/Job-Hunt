import { query, initDatabase } from "./tools/db";
import * as fs from "fs";
import * as path from "path";
import { workspacePath, findPublicFile } from "./tools/paths";
import mammoth from "mammoth";
import { runWorkflowDirectly } from "./workflows/jobMatchWorkflow";
import { extractJDRequirementsTool } from "./tools/extractJDRequirementsTool";
import { generateVerifiedPacketTool } from "./tools/generateVerifiedPacketTool";
import { buildOutputTool } from "./tools/buildOutputTool";
import { scoreJobsTool } from "./tools/scoreJobsTool";
import { renderResumeDocx, renderCoverLetterDocx, convertDocxToPdf } from "./tools/docxRenderer";
import {
  normalizeText,
  computeHash,
  computeSimhash,
  classifyLevel,
  extractKeywords,
} from "./tools/jobPostingSchema";
import { autoGenerateInBackground } from "../resume-engine/auto-generate";
import { jobMatchAgent } from "./agents/jobMatchAgent";
import { isSetupComplete } from "./setupRoutes";
import { loadInventoryStrict } from "../resume-engine/inventory-loader";

let dbReady = false;

// In-memory generation log — survives within a single deploy
interface GenLogEntry { ts: string; jobId: number; company: string; title: string; status: "running" | "success" | "error"; message: string; phase?: string; }
const generationLog: GenLogEntry[] = [];
function logGen(entry: Omit<GenLogEntry, "ts">) {
  generationLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (generationLog.length > 100) generationLog.length = 100;
}

// In-memory packet generation status tracker (for async generation)
interface PacketGenStatus {
  job_id: number;
  status: "queued" | "extracting" | "generating" | "rendering" | "saving" | "done" | "error";
  phase: string;
  started_at: string;
  updated_at: string;
  result?: any;
  error?: string;
  hint?: string;
  abort?: AbortController;
}
const packetGenStatus = new Map<number, PacketGenStatus>();
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per generation

function updateGenStatus(jobId: number, update: Partial<PacketGenStatus>) {
  const existing = packetGenStatus.get(jobId);
  if (existing) {
    Object.assign(existing, update, { updated_at: new Date().toISOString() });
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Build a download filename like "Ed Dobbles Resume - Acme Corp.docx" */
function buildDownloadFilename(profileName: string, company: string, type: string, ext: string): string {
  const safeName = profileName.replace(/[^\w\s.-]/g, "").trim() || "Resume";
  const safeCompany = company.replace(/[^\w\s.&,-]/g, "").trim() || "Unknown";
  const label = type === "cover" ? "Cover Letter" : "Resume";
  return `${safeName} ${label} - ${safeCompany}.${ext}`;
}

/** Load experience inventory via centralized loader — throws MissingBaselineError, never returns stubs */
async function loadInventoryProfile(): Promise<Record<string, any>> {
  return loadInventoryStrict();
}

export function getDashboardRoutes() {
  return [
    {
      path: "/dashboard",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        // Redirect to setup wizard if not configured yet
        try {
          const ready = await isSetupComplete();
          if (!ready) {
            return c.redirect("/setup");
          }
        } catch {
          // If we can't check, just show the dashboard
        }

        const found = findPublicFile("index.html");
        if (!found) {
          return c.text("Dashboard not found", 404);
        }
        const html = fs.readFileSync(found, "utf-8");
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
    {
      path: "/api/dashboard",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        logger?.info("📊 [dashboard] Fetching dashboard data");
        try {
          // Ensure tables exist on first request
          if (!dbReady) {
            await initDatabase();
            dbReady = true;
          }
          const jobCount = await query("SELECT COUNT(*) as count FROM jobs");
          const scoredCount = await query("SELECT COUNT(*) as count FROM scores");
          const artifactCount = await query("SELECT COUNT(*) as count FROM artifacts WHERE truth_pass = true");
          const recentRuns = await query(
            "SELECT run_id, start_ts, end_ts, status FROM runs ORDER BY start_ts DESC LIMIT 5"
          );
          const topJobs = await query(`
            SELECT j.job_id, j.company, j.title, j.location, j.status, j.posting_url,
                   s.total_score
            FROM jobs j
            LEFT JOIN scores s ON j.job_id = s.job_id
            ORDER BY s.total_score DESC NULLS LAST
            LIMIT 5
          `);

          return c.json({
            stats: {
              totalJobs: parseInt(jobCount.rows[0].count),
              scoredJobs: parseInt(scoredCount.rows[0].count),
              packetsGenerated: parseInt(artifactCount.rows[0].count),
            },
            recentRuns: recentRuns.rows,
            topJobs: topJobs.rows,
          });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Error: ${err.message}`);
          // Return 200 with error info so healthcheck passes even if DB tables aren't ready
          return c.json({ status: "starting", error: err.message, stats: { totalJobs: 0, scoredJobs: 0, packetsGenerated: 0 }, recentRuns: [], topJobs: [] });
        }
      },
    },
    {
      path: "/api/dashboard/jobs",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        logger?.info("📊 [dashboard] Fetching all jobs");
        try {
          const url = new URL(c.req.url);
          const page = parseInt(url.searchParams.get("page") || "1");
          const limit = parseInt(url.searchParams.get("limit") || "500");
          const offset = (page - 1) * limit;

          const result = await query(`
            SELECT j.job_id, j.company, j.title, j.location, j.remote_hybrid,
                   j.posting_url, j.status, j.date_ingested, j.compensation,
                   j.user_action,
                   s.total_score, s.breakdown_json,
                   CASE WHEN a.id IS NOT NULL THEN true ELSE false END as has_artifacts,
                   a.truth_pass
            FROM jobs j
            LEFT JOIN scores s ON j.job_id = s.job_id
            LEFT JOIN artifacts a ON j.job_id = a.job_id
            ORDER BY j.date_ingested DESC
            LIMIT $1 OFFSET $2
          `, [limit, offset]);

          const countResult = await query("SELECT COUNT(*) as count FROM jobs");

          return c.json({
            jobs: result.rows,
            total: parseInt(countResult.rows[0].count),
            page,
            limit,
          });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Jobs error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    {
      path: "/api/dashboard/jobs/:id",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = c.req.param("id");
        logger?.info(`📊 [dashboard] Fetching job detail: ${jobId}`);
        try {
          const job = await query("SELECT * FROM jobs WHERE job_id = $1", [jobId]);
          if (job.rows.length === 0) {
            return c.json({ error: "Job not found" }, 404);
          }

          const score = await query("SELECT * FROM scores WHERE job_id = $1", [jobId]);
          const artifacts = await query(
            "SELECT *, resume_docx IS NOT NULL as has_resume_blob, cover_docx IS NOT NULL as has_cover_blob FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1",
            [jobId]
          );
          const contacts = await query(
            "SELECT * FROM contacts WHERE job_id = $1 ORDER BY rank ASC",
            [jobId]
          );
          const evidence = await query(
            "SELECT * FROM evidence_map WHERE job_id = $1 ORDER BY confidence DESC",
            [jobId]
          );

          return c.json({
            job: job.rows[0],
            score: score.rows[0] || null,
            artifact: artifacts.rows[0] || null,
            contacts: contacts.rows,
            evidence: evidence.rows,
          });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Job detail error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    {
      path: "/api/dashboard/runs",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        logger?.info("📊 [dashboard] Fetching runs");
        try {
          const result = await query(
            "SELECT * FROM runs ORDER BY start_ts DESC LIMIT 20"
          );
          return c.json({ runs: result.rows });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Runs error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    {
      path: "/api/dashboard/trigger",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        logger?.info("🚀 [dashboard] Triggering workflow directly (no Inngest)");

        // Return immediately, run workflow in background
        const runPromise = runWorkflowDirectly(mastra).then((result) => {
          logger?.info(`✅ [dashboard] Workflow completed: ${result.summary}`);
        }).catch((err) => {
          logger?.error(`❌ [dashboard] Workflow failed: ${err.message}`);
        });

        // Don't await — let it run in background
        return c.json({ success: true, message: "Workflow started in background" });
      },
    },
    {
      path: "/api/dashboard/jobs/:id/action",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = c.req.param("id");
        try {
          const body = await c.req.json();
          const action = body.action;
          if (!['applied', 'deleted', null].includes(action)) {
            return c.json({ error: "Invalid action. Use 'applied', 'deleted', or null." }, 400);
          }
          logger?.info(`📊 [dashboard] Setting job ${jobId} action to: ${action}`);
          await query("UPDATE jobs SET user_action = $1 WHERE job_id = $2", [action, jobId]);
          return c.json({ success: true, job_id: jobId, action });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Action update error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    {
      path: "/api/dashboard/preview/:jobId/:type",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = c.req.param("jobId");
        const type = c.req.param("type");
        logger?.info(`👁️ [dashboard] Preview request: job=${jobId}, type=${type}`);

        try {
          const artifact = await query(
            "SELECT * FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1",
            [jobId]
          );

          if (artifact.rows.length === 0) {
            return c.json({ error: "No artifacts found" }, 404);
          }

          const row = artifact.rows[0];
          const job = await query("SELECT company, title FROM jobs WHERE job_id = $1", [jobId]);
          const jobInfo = job.rows[0] || { company: 'Unknown', title: 'Unknown' };

          let filePath = "";
          let label = "";

          switch (type) {
            case "resume":
              filePath = row.resume_docx_path;
              label = "Resume";
              break;
            case "cover":
              filePath = row.cover_docx_path;
              label = "Cover Letter";
              break;
            case "evidence":
              filePath = row.evidence_map_path;
              label = "Evidence Map";
              break;
            case "verifier":
              filePath = row.verifier_json_path;
              label = "Verifier Report";
              break;
            case "reviewer":
              filePath = "";
              label = "Recruiter Review";
              break;
            default:
              return c.json({ error: "Invalid type" }, 400);
          }

          // Try disk first, then DB blob
          let resolvedPath = "";
          if (filePath) {
            resolvedPath = filePath.startsWith("/") ? filePath : workspacePath(filePath);
            if (!fs.existsSync(resolvedPath) && filePath.startsWith("/")) {
              const asRelative = workspacePath(filePath.replace(/^\/app\//, "").replace(/^\/home\/user\/Job-Hunt\//, ""));
              if (fs.existsSync(asRelative)) resolvedPath = asRelative;
            }
          }

          let contentHtml = "";
          const diskExists = resolvedPath && fs.existsSync(resolvedPath);

          if (diskExists) {
            // Serve from disk (fast path)
            if (type === "evidence" || type === "verifier" || type === "reviewer") {
              const jsonContent = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
              contentHtml = `<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:monospace;font-size:13px;line-height:1.6;">${escapeHtml(JSON.stringify(jsonContent, null, 2))}</pre>`;
            } else {
              const result = await mammoth.convertToHtml({ path: resolvedPath });
              contentHtml = result.value;
            }
          } else {
            // Serve from DB blob
            const blobColMap: Record<string, string> = {
              resume: "resume_docx",
              cover: "cover_docx",
              evidence: "evidence_map_json",
              verifier: "verifier_json",
              reviewer: "reviewer_json",
            };
            const blobCol = blobColMap[type] || "verifier_json";
            const blobRow = await query(`SELECT ${blobCol} FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1`, [jobId]);
            const blob = blobRow.rows[0]?.[blobCol];
            if (!blob) {
              return c.json({ error: `No ${type} data available. Try regenerating the packet.` }, 404);
            }
            if (type === "evidence" || type === "verifier" || type === "reviewer") {
              const jsonContent = typeof blob === "string" ? JSON.parse(blob) : blob;
              contentHtml = `<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:monospace;font-size:13px;line-height:1.6;">${escapeHtml(JSON.stringify(jsonContent, null, 2))}</pre>`;
            } else {
              const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
              const result = await mammoth.convertToHtml({ buffer: buf });
              contentHtml = result.value;
            }
          }

          const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(label)} - ${escapeHtml(jobInfo.company)} - ${escapeHtml(jobInfo.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; background: #f5f5f5; color: #1a1a1a; }
    .toolbar { background: #1a1d27; color: #e4e6ef; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
    .toolbar h1 { font-size: 16px; font-weight: 600; }
    .toolbar .sub { font-size: 13px; color: #8b8fa3; margin-top: 2px; }
    .toolbar-actions { display: flex; gap: 8px; }
    .toolbar-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid #2e3140; background: #242734; color: #e4e6ef; cursor: pointer; font-size: 13px; text-decoration: none; }
    .toolbar-btn:hover { border-color: #6366f1; }
    .toolbar-btn.print { background: #6366f1; border-color: #6366f1; }
    .page { max-width: 850px; margin: 24px auto; background: white; padding: 48px 56px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); min-height: 80vh; line-height: 1.6; }
    .page h1, .page h2, .page h3 { margin-top: 16px; margin-bottom: 8px; }
    .page p { margin-bottom: 8px; }
    .page ul, .page ol { margin-left: 24px; margin-bottom: 8px; }
    .page table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    .page td, .page th { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    @media print { .toolbar { display: none; } .page { margin: 0; box-shadow: none; border-radius: 0; padding: 24px; } body { background: white; } }
    @media (max-width: 768px) { .page { margin: 12px; padding: 24px 20px; } }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <h1>${escapeHtml(label)}</h1>
      <div class="sub">${escapeHtml(jobInfo.company)} - ${escapeHtml(jobInfo.title)}</div>
    </div>
    <div class="toolbar-actions">
      <a class="toolbar-btn print" href="/api/dashboard/download/${jobId}/${type}/pdf">Download PDF</a>
      <a class="toolbar-btn" href="/api/dashboard/download/${jobId}/${type}">Download DOCX</a>
      <button class="toolbar-btn" onclick="window.print()">Print</button>
      <button class="toolbar-btn" onclick="window.close()">Close</button>
    </div>
  </div>
  <div class="page">${contentHtml}</div>
</body>
</html>`;

          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Preview error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    {
      path: "/api/dashboard/download/:jobId/:type",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = c.req.param("jobId");
        const type = c.req.param("type");
        logger?.info(`📥 [dashboard] Download request: job=${jobId}, type=${type}`);

        try {
          const artifact = await query(
            "SELECT * FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1",
            [jobId]
          );

          if (artifact.rows.length === 0) {
            return c.json({ error: "No artifacts found" }, 404);
          }

          const row = artifact.rows[0];

          // Load profile name and company for friendly filenames
          const jobRow = await query("SELECT company, title FROM jobs WHERE job_id = $1", [jobId]);
          const jobInfo = jobRow.rows[0] || { company: "Unknown", title: "Unknown" };
          const inventory = await loadInventoryProfile();
          const profileName = inventory.profile?.name || "Resume";

          let filePath = "";
          let contentType = "application/octet-stream";
          let filename = "";

          switch (type) {
            case "resume":
              filePath = row.resume_docx_path;
              contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
              filename = buildDownloadFilename(profileName, jobInfo.company, "resume", "docx");
              break;
            case "cover":
              filePath = row.cover_docx_path;
              contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
              filename = buildDownloadFilename(profileName, jobInfo.company, "cover", "docx");
              break;
            case "evidence":
              filePath = row.evidence_map_path;
              contentType = "application/json";
              filename = `evidence_map_${jobId}.json`;
              break;
            case "verifier":
              filePath = row.verifier_json_path;
              contentType = "application/json";
              filename = `verifier_${jobId}.json`;
              break;
            case "reviewer":
              filePath = "";
              contentType = "application/json";
              filename = `recruiter_review_${jobId}.json`;
              break;
            default:
              return c.json({ error: "Invalid type" }, 400);
          }

          // Try disk first, then DB blob
          let resolvedPath = "";
          if (filePath) {
            resolvedPath = filePath.startsWith("/") ? filePath : workspacePath(filePath);
            if (!fs.existsSync(resolvedPath) && filePath.startsWith("/")) {
              const asRelative = workspacePath(filePath.replace(/^\/app\//, "").replace(/^\/home\/user\/Job-Hunt\//, ""));
              if (fs.existsSync(asRelative)) resolvedPath = asRelative;
            }
          }

          let fileBuffer: Buffer;
          if (resolvedPath && fs.existsSync(resolvedPath)) {
            fileBuffer = fs.readFileSync(resolvedPath);
          } else {
            // Serve from DB blob
            const dlBlobMap: Record<string, string> = {
              resume: "resume_docx",
              cover: "cover_docx",
              evidence: "evidence_map_json",
              verifier: "verifier_json",
              reviewer: "reviewer_json",
            };
            const blobCol = dlBlobMap[type] || "verifier_json";
            const blobRow = await query(`SELECT ${blobCol} FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1`, [jobId]);
            const blob = blobRow.rows[0]?.[blobCol];
            if (!blob) {
              return c.json({ error: `No ${type} data available. Try regenerating the packet.` }, 404);
            }
            fileBuffer = Buffer.isBuffer(blob) ? blob : Buffer.from(typeof blob === "string" ? blob : JSON.stringify(blob));
          }

          return new Response(new Uint8Array(fileBuffer), {
            headers: {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="${filename}"`,
            },
          });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Download error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── PDF Download (DOCX → PDF on-the-fly via LibreOffice) ── */
    {
      path: "/api/dashboard/download/:jobId/:type/pdf",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = c.req.param("jobId");
        const type = c.req.param("type");
        logger?.info(`📥 [dashboard] PDF download request: job=${jobId}, type=${type}`);

        if (type !== "resume" && type !== "cover") {
          return c.json({ error: "PDF download only available for resume and cover letter" }, 400);
        }

        try {
          const artifact = await query(
            "SELECT * FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1",
            [jobId]
          );

          if (artifact.rows.length === 0) {
            return c.json({ error: "No artifacts found" }, 404);
          }

          const row = artifact.rows[0];

          // Load profile name and company for filename
          const jobRow = await query("SELECT company, title FROM jobs WHERE job_id = $1", [jobId]);
          const jobInfo = jobRow.rows[0] || { company: "Unknown", title: "Unknown" };
          const inventory = await loadInventoryProfile();
          const profileName = inventory.profile?.name || "Resume";
          const filename = buildDownloadFilename(profileName, jobInfo.company, type, "pdf");

          // Get DOCX buffer from disk or DB
          const filePath = type === "resume" ? row.resume_docx_path : row.cover_docx_path;
          let docxBuffer: Buffer;

          let resolvedPath = "";
          if (filePath) {
            resolvedPath = filePath.startsWith("/") ? filePath : workspacePath(filePath);
            if (!fs.existsSync(resolvedPath) && filePath.startsWith("/")) {
              const asRelative = workspacePath(filePath.replace(/^\/app\//, "").replace(/^\/home\/user\/Job-Hunt\//, ""));
              if (fs.existsSync(asRelative)) resolvedPath = asRelative;
            }
          }

          if (resolvedPath && fs.existsSync(resolvedPath)) {
            docxBuffer = fs.readFileSync(resolvedPath);
          } else {
            const blobCol = type === "resume" ? "resume_docx" : "cover_docx";
            const blobRow = await query(`SELECT ${blobCol} FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1`, [jobId]);
            const blob = blobRow.rows[0]?.[blobCol];
            if (!blob) {
              return c.json({ error: `No ${type} data available. Try regenerating the packet.` }, 404);
            }
            docxBuffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
          }

          // Write DOCX to temp file, convert to PDF via LibreOffice
          const os = await import("os");
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-pdf-"));
          const tmpDocx = path.join(tmpDir, "doc.docx");
          fs.writeFileSync(tmpDocx, docxBuffer);

          try {
            const { pdfPath } = await convertDocxToPdf(tmpDocx, tmpDir);
            const pdfBuffer = fs.readFileSync(pdfPath);

            // Clean up temp files
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

            return new Response(new Uint8Array(pdfBuffer), {
              headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${filename}"`,
              },
            });
          } catch (convertErr: any) {
            // Clean up temp files on error
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
            logger?.error(`❌ [dashboard] PDF conversion error: ${convertErr.message}`);
            return c.json({ error: `PDF conversion failed: ${convertErr.message}. Try downloading the DOCX instead.` }, 500);
          }
        } catch (err: any) {
          logger?.error(`❌ [dashboard] PDF download error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    {
      path: "/api/dashboard/generate-packet/:jobId",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = parseInt(c.req.param("jobId"));
        logger?.info(`🔄 [generate-packet] Starting for job_id=${jobId}`);

        try {
          if (!dbReady) {
            try {
              await initDatabase();
              dbReady = true;
            } catch (dbErr: any) {
              logGen({ jobId, company: "?", title: "?", status: "error", message: `Database init failed: ${dbErr.message}`, phase: "db-init" });
              return c.json({ error: `Database initialization failed: ${dbErr.message}`, phase: "db-init" }, 500);
            }
          }

          // Preflight: check OpenAI API key
          const hasApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
          if (!hasApiKey) {
            logGen({ jobId, company: "?", title: "?", status: "error", message: "OpenAI API key not configured", phase: "preflight" });
            return c.json({
              error: "OpenAI API key not configured. Set OPENAI_API_KEY in Railway environment variables (Settings > Variables).",
              phase: "preflight",
            }, 400);
          }

          // Preflight: check inventory exists (DB or filesystem)
          try {
            await loadInventoryProfile();
          } catch (prefErr: any) {
            return c.json({
              error: "Experience inventory not found. Go to Profile Builder to upload and finalize your resume first.",
              phase: "preflight",
              detail: prefErr.message,
            }, 400);
          }

          // Load job (synchronous preflight — fast DB query)
          const jobResult = await query(
            `SELECT j.job_id, j.company, j.title, j.location, j.remote_hybrid,
                    j.jd_raw_text, j.jd_requirements, j.posting_url,
                    s.total_score, s.breakdown_json
             FROM jobs j
             LEFT JOIN scores s ON j.job_id = s.job_id
             WHERE j.job_id = $1`,
            [jobId],
          );
          if (jobResult.rows.length === 0) {
            return c.json({ error: "Job not found", phase: "load" }, 404);
          }
          const job = jobResult.rows[0];

          if (!job.jd_raw_text || job.jd_raw_text.length < 100) {
            return c.json({
              error: `Job has insufficient JD text (${(job.jd_raw_text || '').length} chars, need 100+). The JD may not have been fully extracted from the email. Try re-running the workflow or manually adding job description text.`,
              phase: "validation",
            }, 400);
          }

          // Check if already generating for this job
          const existing = packetGenStatus.get(jobId);
          if (existing && (existing.status !== "done" && existing.status !== "error")) {
            return c.json({
              success: true,
              job_id: jobId,
              async: true,
              status: existing.status,
              phase: existing.phase,
              message: `Generation already in progress (${existing.phase})`,
            }, 202);
          }

          // Initialize status tracker with abort controller — return 202 immediately
          const genAbort = new AbortController();
          packetGenStatus.set(jobId, {
            job_id: jobId,
            status: "queued",
            phase: "init",
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            abort: genAbort,
          });
          logGen({ jobId, company: job.company, title: job.title, status: "running", message: "Starting generation...", phase: "init" });

          // Outer timeout: kill generation after 10 minutes
          const genTimeout = setTimeout(() => {
            const status = packetGenStatus.get(jobId);
            if (status && status.status !== "done" && status.status !== "error") {
              logger?.error(`⏰ [generate-packet] TIMEOUT after ${GENERATION_TIMEOUT_MS / 1000}s for job_id=${jobId} (stuck at ${status.phase})`);
              logGen({ jobId, company: job.company, title: job.title, status: "error", message: `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s at phase: ${status.phase}`, phase: status.phase });
              updateGenStatus(jobId, {
                status: "error",
                phase: status.phase,
                error: `Generation timed out after ${Math.round(GENERATION_TIMEOUT_MS / 60000)} minutes. The LLM may be slow or unresponsive. Try again.`,
                hint: "If this keeps happening, check OpenAI status at status.openai.com.",
              });
              genAbort.abort();
            }
          }, GENERATION_TIMEOUT_MS);

          // Fire-and-forget: run the heavy pipeline in the background
          (async () => {
            try {
              // Phase 1: Extract JD requirements if missing
              if (!job.jd_requirements) {
                updateGenStatus(jobId, { status: "extracting", phase: "extract-requirements" });
                logger?.info(`📋 [generate-packet] Phase 1: Extracting JD requirements for job_id=${jobId}`);
                try {
                  await extractJDRequirementsTool.execute!({
                    context: {
                      job_id: jobId,
                      jd_text: job.jd_raw_text,
                      company: job.company,
                      title: job.title,
                    },
                    mastra,
                  } as any);
                  logger?.info(`✅ [generate-packet] Phase 1 complete: JD requirements extracted`);
                } catch (phase1Err: any) {
                  logger?.error(`❌ [generate-packet] Phase 1 failed: ${phase1Err.message}`);
                  logGen({ jobId, company: job.company, title: job.title, status: "error", message: phase1Err.message, phase: "extract-requirements" });
                  updateGenStatus(jobId, {
                    status: "error",
                    phase: "extract-requirements",
                    error: `Failed to extract JD requirements: ${phase1Err.message}`,
                    hint: phase1Err.message.includes("API key") || phase1Err.message.includes("401")
                      ? "Check your OpenAI API key in Railway environment variables."
                      : phase1Err.message.includes("rate") || phase1Err.message.includes("429")
                      ? "OpenAI rate limit hit. Wait a moment and try again."
                      : undefined,
                  });
                  return;
                }
              }

              // Check for abort before expensive Phase 2
              if (genAbort.signal.aborted) {
                logger?.warn(`🛑 [generate-packet] Aborted before Phase 2 for job_id=${jobId}`);
                clearTimeout(genTimeout);
                return;
              }

              // Phase 2: Generate verified packet (resume + cover letter + truth verification)
              updateGenStatus(jobId, { status: "generating", phase: "generate-packet" });
              logger?.info(`📄 [generate-packet] Phase 2: Generating verified packet...`);
              let packetResult: any;
              try {
                packetResult = await generateVerifiedPacketTool.execute!({
                  context: {
                    job_id: jobId,
                    company: job.company,
                    title: job.title,
                    max_attempts: 3,
                  },
                  mastra,
                } as any);
                logger?.info(`✅ [generate-packet] Phase 2 complete: pass=${packetResult.pass}, attempts=${packetResult.attempts_used}`);
              } catch (phase2Err: any) {
                logger?.error(`❌ [generate-packet] Phase 2 failed: ${phase2Err.message}`);
                logGen({ jobId, company: job.company, title: job.title, status: "error", message: phase2Err.message, phase: "generate-packet" });
                updateGenStatus(jobId, {
                  status: "error",
                  phase: "generate-packet",
                  error: `Failed to generate resume/cover letter: ${phase2Err.message}`,
                  hint: phase2Err.message.includes("API key") || phase2Err.message.includes("401")
                    ? "Check your OpenAI API key in Railway environment variables."
                    : phase2Err.message.includes("rate") || phase2Err.message.includes("429")
                    ? "OpenAI rate limit hit. Wait a moment and try again."
                    : phase2Err.message.includes("All") && phase2Err.message.includes("attempts failed")
                    ? "The AI couldn't generate a verified resume after multiple attempts. Try again — results vary between runs."
                    : undefined,
                });
                return;
              }

              // Phase 3: Combine evidence pointers
              const resumePointers = (packetResult.resume?.evidence_pointers || []).map((p: any) => ({
                claim_text: p.claim_text,
                evidence_id: p.source_hash,
                evidence_quote: p.evidence_quote,
                evidence_source_key: p.source_hash,
                confidence: p.confidence,
              }));
              const clPointers = (packetResult.cover_letter?.evidence_pointers || []).map((p: any) => ({
                claim_text: p.claim_text,
                evidence_id: p.source_hash,
                evidence_quote: p.evidence_quote,
                evidence_source_key: p.source_hash,
                confidence: p.confidence,
              }));
              const combinedEvidence = [...resumePointers, ...clPointers];

              // Check for abort before Phase 4
              if (genAbort.signal.aborted) {
                logger?.warn(`🛑 [generate-packet] Aborted before Phase 4 for job_id=${jobId}`);
                clearTimeout(genTimeout);
                return;
              }

              // Phase 4: Render DOCX and save to DB (primary) + filesystem (best-effort)
              updateGenStatus(jobId, { status: "rendering", phase: "render-docx" });
              logger?.info(`📁 [generate-packet] Phase 4: Rendering DOCX and saving to DB...`);
              const truthPass = Boolean(packetResult.pass);
              const evidenceJson = JSON.stringify(combinedEvidence, null, 2);
              const verifierJson = JSON.stringify(packetResult.final_report, null, 2);
              let resumeBuffer: Buffer | null = null;
              let coverBuffer: Buffer | null = null;
              let diskFiles = 0;

              // Render DOCX from JSON
              try {
                const inventory = await loadInventoryProfile();
                const profile = inventory.profile || {};
                resumeBuffer = await renderResumeDocx(packetResult.resume, profile);
                coverBuffer = await renderCoverLetterDocx(packetResult.cover_letter, profile);
                logger?.info(`✅ [generate-packet] DOCX rendered: resume=${resumeBuffer.length}B, cover=${coverBuffer.length}B`);
              } catch (renderErr: any) {
                logger?.error(`⚠️ [generate-packet] DOCX render failed: ${renderErr.message}`);
              }

              // Save to DB (critical path — this is what makes packets visible)
              updateGenStatus(jobId, { status: "saving", phase: "db-save" });
              try {
                await query(`DELETE FROM artifacts WHERE job_id = $1`, [jobId]);
                await query(`DELETE FROM evidence_map WHERE job_id = $1`, [jobId]);
                await query(
                  `INSERT INTO artifacts (job_id, resume_docx_path, cover_docx_path, evidence_map_path, verifier_json_path, prompt_version, model_used, truth_pass, resume_docx, cover_docx, evidence_map_json, verifier_json)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                  [jobId, "", "", "", "", "v2", "gpt-4o", truthPass, resumeBuffer, coverBuffer, evidenceJson, verifierJson],
                );
                for (const ev of combinedEvidence) {
                  await query(
                    `INSERT INTO evidence_map (job_id, claim_id, claim_text, evidence_quote, evidence_source_key, confidence)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [jobId, ev.evidence_id || "", ev.claim_text, ev.evidence_quote, ev.evidence_source_key, ev.confidence],
                  ).catch((e: any) => logger?.error(`⚠️ [generate-packet] Evidence insert error: ${e.message}`));
                }
                // Store recruiter review report if available
                if (packetResult.recruiter_review) {
                  try {
                    await query(
                      `UPDATE artifacts SET reviewer_json = $1 WHERE job_id = $2`,
                      [JSON.stringify(packetResult.recruiter_review, null, 2), jobId],
                    );
                  } catch { /* column may not exist yet — non-fatal */ }
                }

                logger?.info(`💾 [generate-packet] Artifacts saved to DB for job_id=${jobId}`);
              } catch (dbErr: any) {
                logger?.error(`❌ [generate-packet] DB save failed: ${dbErr.message}`);
                logGen({ jobId, company: job.company, title: job.title, status: "error", message: `DB save failed: ${dbErr.message}`, phase: "db-save" });
                updateGenStatus(jobId, {
                  status: "error",
                  phase: "db-save",
                  error: `Resume generated but failed to save to database: ${dbErr.message}`,
                  hint: "The resume was generated successfully but couldn't be saved. This is a database error.",
                });
                return;
              }

              // Write to filesystem (best-effort, not required)
              try {
                const buildResult = await buildOutputTool.execute!({
                  context: {
                    job_id: jobId, company: job.company, title: job.title,
                    resume: packetResult.resume, cover_letter: packetResult.cover_letter,
                    evidenceMap: combinedEvidence, verifierResult: packetResult.final_report,
                    scoringBreakdown: job.breakdown_json || {}, totalScore: job.total_score || 0,
                    skip_pdf: true,
                  },
                  mastra,
                } as any);
                diskFiles = buildResult?.files?.length || 0;
                logger?.info(`📁 [generate-packet] Disk files: ${diskFiles}`);
              } catch (diskErr: any) {
                logger?.warn(`⚠️ [generate-packet] Disk write failed (non-critical): ${diskErr.message}`);
              }

              // Update job status
              await query(
                "UPDATE jobs SET status = $1 WHERE job_id = $2",
                [truthPass ? "generated" : "generated-unverified", jobId],
              );

              const resumeExp = packetResult.resume?.experience || [];
              logger?.info(`✅ [generate-packet] Done! pass=${truthPass}, diskFiles=${diskFiles}`);
              logGen({ jobId, company: job.company, title: job.title, status: "success", message: `${resumeExp.length} roles, truth: ${truthPass ? "PASS" : "REVIEW"}, saved to DB`, phase: "done" });

              // Mark as done with full result
              clearTimeout(genTimeout);
              updateGenStatus(jobId, {
                status: "done",
                phase: "done",
                result: {
                  success: true,
                  job_id: jobId,
                  company: job.company,
                  title: job.title,
                  truth_pass: truthPass,
                  attempts_used: packetResult.attempts_used,
                  evidence_count: combinedEvidence.length,
                  files: diskFiles,
                  resume_summary: packetResult.resume?.professional_summary || "",
                  resume_roles: resumeExp.length,
                  resume_bullets: resumeExp.reduce((s: number, e: any) => s + (e?.bullets?.length || 0), 0),
                  ats_keywords: packetResult.resume?.ats_keywords_used || [],
                  gap_notes: packetResult.resume?.gap_notes || [],
                  cover_letter_words: packetResult.cover_letter?.word_count || 0,
                },
              });
            } catch (err: any) {
              clearTimeout(genTimeout);
              const errMsg = err?.message || String(err);
              logger?.error(`❌ [generate-packet] Unhandled error: ${errMsg}`);
              logGen({ jobId, company: job.company || "?", title: job.title || "?", status: "error", message: errMsg, phase: "unknown" });
              updateGenStatus(jobId, {
                status: "error",
                phase: "unknown",
                error: errMsg,
              });
            }
          })();

          // Return 202 Accepted immediately — frontend will poll for status
          return c.json({
            success: true,
            job_id: jobId,
            async: true,
            status: "queued",
            phase: "init",
            message: "Packet generation started. Poll /api/dashboard/generate-packet/" + jobId + "/status for progress.",
          }, 202);
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          const errStack = err?.stack?.split('\n').slice(0, 8) || [];
          logger?.error(`❌ [generate-packet] Preflight error: ${errMsg}\n${errStack.join('\n')}`);
          logGen({ jobId, company: "?", title: "?", status: "error", message: errMsg, phase: "preflight" });
          return c.json({ error: errMsg, phase: "preflight", stack: errStack }, 500);
        }
      },
    },
    /* ── Packet generation status (polling endpoint) ──────── */
    {
      path: "/api/dashboard/generate-packet/:jobId/status",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const jobId = parseInt(c.req.param("jobId"));
        const status = packetGenStatus.get(jobId);

        if (!status) {
          return c.json({ job_id: jobId, status: "unknown", message: "No generation in progress or recently completed for this job" }, 404);
        }

        const elapsed = ((Date.now() - new Date(status.started_at).getTime()) / 1000).toFixed(1);

        if (status.status === "done") {
          // Clean up after delivering the result (keep for 60s in case of multiple polls)
          setTimeout(() => packetGenStatus.delete(jobId), 60_000);
          return c.json({
            job_id: jobId,
            status: "done",
            phase: "done",
            elapsed_s: elapsed,
            ...status.result,
          });
        }

        if (status.status === "error") {
          // Clean up after delivering the error
          setTimeout(() => packetGenStatus.delete(jobId), 60_000);
          return c.json({
            job_id: jobId,
            status: "error",
            phase: status.phase,
            elapsed_s: elapsed,
            error: status.error,
            hint: status.hint,
          });
        }

        // Still in progress
        const elapsedNum = parseFloat(elapsed);
        const timeoutS = GENERATION_TIMEOUT_MS / 1000;
        return c.json({
          job_id: jobId,
          status: status.status,
          phase: status.phase,
          elapsed_s: elapsed,
          timeout_s: timeoutS,
          remaining_s: Math.max(0, timeoutS - elapsedNum).toFixed(0),
          message: `Generation in progress (${status.phase})...`,
        }, 202);
      },
    },
    /* ── Cancel packet generation ─────────────────────────── */
    {
      path: "/api/dashboard/generate-packet/:jobId/cancel",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = parseInt(c.req.param("jobId"));
        const status = packetGenStatus.get(jobId);

        if (!status) {
          return c.json({ job_id: jobId, cancelled: false, message: "No generation in progress for this job" }, 404);
        }

        if (status.status === "done" || status.status === "error") {
          return c.json({ job_id: jobId, cancelled: false, message: `Generation already ${status.status}` });
        }

        logger?.warn(`🛑 [generate-packet] Cancelling generation for job_id=${jobId} at phase: ${status.phase}`);
        logGen({ jobId, company: "?", title: "?", status: "error", message: `Cancelled by user at phase: ${status.phase}`, phase: status.phase });

        // Signal abort and update status
        if (status.abort) {
          status.abort.abort();
        }
        updateGenStatus(jobId, {
          status: "error",
          error: "Generation cancelled by user.",
          hint: "You can retry by clicking Generate again.",
        });

        return c.json({ job_id: jobId, cancelled: true, phase: status.phase, message: "Generation cancelled." });
      },
    },
    /* ── Generation log (in-memory) ───────────────────────── */
    {
      path: "/api/dashboard/generation-log",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        return c.json({ log: generationLog.slice(0, 50) });
      },
    },
    /* ── Purge stale artifacts (from old deployments) ────────── */
    {
      path: "/api/dashboard/purge-stale-artifacts",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          // Find artifacts where the resume file doesn't exist on disk AND has no DB blob
          const allArtifacts = await query(`SELECT id, job_id, resume_docx_path, resume_docx IS NOT NULL as has_blob FROM artifacts`);
          const staleIds: number[] = [];
          for (const row of allArtifacts.rows) {
            // If we have a DB blob, the artifact is NOT stale (survives deploys)
            if (row.has_blob) continue;
            const filePath = row.resume_docx_path;
            if (!filePath) { staleIds.push(row.id); continue; }
            const resolved = filePath.startsWith("/") ? filePath : workspacePath(filePath);
            if (!fs.existsSync(resolved)) {
              staleIds.push(row.id);
            }
          }

          if (staleIds.length === 0) {
            return c.json({ success: true, message: "No stale artifacts found", purged: 0 });
          }

          await query(`DELETE FROM artifacts WHERE id = ANY($1)`, [staleIds]);
          // Reset job status so Generate Packet button reappears
          await query(
            `UPDATE jobs SET status = 'new' WHERE status IN ('generated', 'generated-unverified') AND job_id NOT IN (SELECT job_id FROM artifacts)`,
          );

          logger?.info(`🧹 [purge] Removed ${staleIds.length} stale artifact records`);
          return c.json({ success: true, purged: staleIds.length, message: `Removed ${staleIds.length} stale artifact records from previous deployments` });
        } catch (err: any) {
          logger?.error(`❌ [purge] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Purge ALL packets (reset for regeneration) ────────── */
    {
      path: "/api/dashboard/purge-all-packets",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          const artifactCount = await query("SELECT COUNT(*) as count FROM artifacts");
          const total = parseInt(artifactCount.rows[0].count);

          if (total === 0) {
            return c.json({ success: true, message: "No packets to purge", purged: 0 });
          }

          await query("DELETE FROM evidence_map");
          await query("DELETE FROM artifacts");
          await query(
            "UPDATE jobs SET status = 'new' WHERE status IN ('generated', 'generated-unverified')",
          );

          logger?.info(`🧹 [purge-all] Removed ALL ${total} artifact records for regeneration`);
          return c.json({ success: true, purged: total, message: `Removed all ${total} packets. Jobs are ready for regeneration.` });
        } catch (err: any) {
          logger?.error(`❌ [purge-all] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Re-score jobs ────────────────────────────────────── */
    {
      path: "/api/dashboard/rescore",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          const url = new URL(c.req.url);
          const all = url.searchParams.get("all") === "true";

          let jobIds: number[];
          if (all) {
            const allResult = await query(`SELECT job_id FROM jobs`);
            jobIds = allResult.rows.map((r: any) => Number(r.job_id));
          } else {
            const unscoredResult = await query(
              `SELECT j.job_id FROM jobs j LEFT JOIN scores s ON j.job_id = s.job_id WHERE s.job_id IS NULL`
            );
            jobIds = unscoredResult.rows.map((r: any) => Number(r.job_id));
          }

          if (jobIds.length === 0) {
            return c.json({ success: true, message: "No jobs to score", count: 0 });
          }

          logger?.info(`📊 [rescore] Scoring ${jobIds.length} jobs (all=${all}) in background...`);

          scoreJobsTool.execute!({
            context: { jobIds, topN: jobIds.length },
            mastra,
          } as any)
            .then((result: any) => {
              logger?.info(`✅ [rescore] Done: ${result.totalScored} scored`);
              // Auto-generate packets for top recommended jobs after scoring
              const autoGen = process.env.AUTO_GENERATE_AFTER_SCORE !== "false";
              if (autoGen) {
                logger?.info(`🤖 [rescore] Triggering auto-generation for top recommended jobs`);
                autoGenerateInBackground({ mastra, minScore: 60, topN: 20, maxAttempts: 2 });
              }
            })
            .catch((err: any) => logger?.error(`⚠️ [rescore] Failed: ${err.message}`));

          return c.json({ success: true, message: `Scoring ${jobIds.length} jobs in background (auto-generation will follow)`, count: jobIds.length });
        } catch (err: any) {
          logger?.error(`❌ [rescore] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Auto-generate packets for top matches ──────────────── */
    {
      path: "/api/dashboard/auto-generate-packets",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
            return c.json({ error: "OpenAI API key not configured. Set OPENAI_API_KEY in Railway variables.", phase: "preflight" }, 400);
          }

          const url = new URL(c.req.url);
          const topN = parseInt(url.searchParams.get("topN") || "10");
          const minScore = parseInt(url.searchParams.get("minScore") || "0");

          // Find top scored jobs that don't already have packets
          const candidates = await query(
            `SELECT j.job_id, j.company, j.title, s.total_score
             FROM jobs j
             INNER JOIN scores s ON j.job_id = s.job_id
             LEFT JOIN artifacts a ON j.job_id = a.job_id
             WHERE a.job_id IS NULL
               AND LENGTH(COALESCE(j.jd_raw_text, '')) >= 100
               AND s.total_score >= $1
             ORDER BY s.total_score DESC
             LIMIT $2`,
            [minScore, topN],
          );

          const jobs = candidates.rows;
          if (jobs.length === 0) {
            return c.json({ success: true, message: "No eligible jobs found (all top matches already have packets, or no scored jobs with sufficient JD text)", queued: 0 });
          }

          logger?.info(`🚀 [auto-generate] Queuing packet generation for ${jobs.length} top jobs`);

          // Return immediately, process in background
          const jobList = jobs.map((j: any) => ({ job_id: j.job_id, company: j.company, title: j.title, score: j.total_score }));

          // Background: generate packets sequentially (each takes ~30-60s of LLM calls)
          (async () => {
            let success = 0;
            let failed = 0;
            for (const job of jobs) {
              try {
                logger?.info(`📦 [auto-generate] ${success + failed + 1}/${jobs.length}: ${job.company} — ${job.title} (score: ${job.total_score})`);

                // Load full job
                const jobResult = await query(
                  `SELECT j.*, s.total_score, s.breakdown_json FROM jobs j LEFT JOIN scores s ON j.job_id = s.job_id WHERE j.job_id = $1`,
                  [job.job_id],
                );
                const fullJob = jobResult.rows[0];
                if (!fullJob) { failed++; continue; }

                // Phase 1: Extract JD requirements if missing
                if (!fullJob.jd_requirements) {
                  await extractJDRequirementsTool.execute!({
                    context: { job_id: job.job_id, jd_text: fullJob.jd_raw_text, company: fullJob.company, title: fullJob.title },
                    mastra,
                  } as any);
                }

                // Phase 2: Generate verified packet
                const packetResult: any = await generateVerifiedPacketTool.execute!({
                  context: { job_id: job.job_id, company: fullJob.company, title: fullJob.title, max_attempts: 2 },
                  mastra,
                } as any);

                // Phase 3: Combine evidence + render DOCX + save to DB
                const resumePointers = (packetResult.resume?.evidence_pointers || []).map((p: any) => ({
                  claim_text: p.claim_text, evidence_id: p.source_hash, evidence_quote: p.evidence_quote,
                  evidence_source_key: p.source_hash, confidence: p.confidence,
                }));
                const clPointers = (packetResult.cover_letter?.evidence_pointers || []).map((p: any) => ({
                  claim_text: p.claim_text, evidence_id: p.source_hash, evidence_quote: p.evidence_quote,
                  evidence_source_key: p.source_hash, confidence: p.confidence,
                }));
                const allEvidence = [...resumePointers, ...clPointers];
                const truthPass = Boolean(packetResult.pass);

                // Render DOCX
                let resumeBuf: Buffer | null = null;
                let coverBuf: Buffer | null = null;
                try {
                  const inv = await loadInventoryProfile();
                  resumeBuf = await renderResumeDocx(packetResult.resume, inv.profile || {});
                  coverBuf = await renderCoverLetterDocx(packetResult.cover_letter, inv.profile || {});
                } catch (e: any) {
                  logger?.warn(`⚠️ [auto-generate] DOCX render failed: ${e.message}`);
                }

                // Save to DB
                await query(`DELETE FROM artifacts WHERE job_id = $1`, [job.job_id]);
                await query(`DELETE FROM evidence_map WHERE job_id = $1`, [job.job_id]);
                await query(
                  `INSERT INTO artifacts (job_id, resume_docx_path, cover_docx_path, evidence_map_path, verifier_json_path, prompt_version, model_used, truth_pass, resume_docx, cover_docx, evidence_map_json, verifier_json)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                  [job.job_id, "", "", "", "", "v2", "gpt-4o", truthPass, resumeBuf, coverBuf, JSON.stringify(allEvidence, null, 2), JSON.stringify(packetResult.final_report, null, 2)],
                );
                for (const ev of allEvidence) {
                  await query(
                    `INSERT INTO evidence_map (job_id, claim_id, claim_text, evidence_quote, evidence_source_key, confidence) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [job.job_id, ev.evidence_id || "", ev.claim_text, ev.evidence_quote, ev.evidence_source_key, ev.confidence],
                  ).catch(() => {});
                }

                // Store recruiter review report if available
                if (packetResult.recruiter_review) {
                  try {
                    await query(
                      `UPDATE artifacts SET reviewer_json = $1 WHERE job_id = $2`,
                      [JSON.stringify(packetResult.recruiter_review, null, 2), job.job_id],
                    );
                  } catch { /* column may not exist yet — non-fatal */ }
                }

                // Update status
                await query("UPDATE jobs SET status = $1 WHERE job_id = $2",
                  [truthPass ? "generated" : "generated-unverified", job.job_id]);

                success++;
                logger?.info(`✅ [auto-generate] ${job.company} — ${job.title}: done (pass=${packetResult.pass})`);
                logGen({ jobId: job.job_id, company: job.company, title: job.title, status: "success", message: `pass=${packetResult.pass}`, phase: "auto-generate" });
              } catch (err: any) {
                failed++;
                logger?.error(`❌ [auto-generate] ${job.company} — ${job.title}: ${err.message}`);
                logGen({ jobId: job.job_id, company: job.company, title: job.title, status: "error", message: err.message, phase: "auto-generate" });
              }
            }
            logger?.info(`🏁 [auto-generate] Complete: ${success} succeeded, ${failed} failed out of ${jobs.length}`);
          })();

          return c.json({
            success: true,
            queued: jobs.length,
            jobs: jobList,
            message: `Generating packets for ${jobs.length} top matches in background. This will take a few minutes.`,
          });
        } catch (err: any) {
          logger?.error(`❌ [auto-generate] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Quick Add Job (single job by URL or company+title) ── */
    {
      path: "/api/dashboard/quick-add",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }
          const body = await c.req.json();
          const { company, title, location, posting_url, jd_text } = body;

          if (!company || !title) {
            return c.json({ error: "Company and title are required" }, 400);
          }

          const jdRaw = (jd_text || "").trim();
          const hashInput = jdRaw || `${company}|${title}|${location || ""}|${posting_url || ""}`;
          const jdHash = computeHash(hashInput);
          const simhash = computeSimhash(jdRaw);
          const keywords = extractKeywords(jdRaw);
          const level = classifyLevel(title);

          // Check for duplicates
          const existing = await query("SELECT job_id FROM jobs WHERE jd_hash = $1", [jdHash]);
          if (existing.rows.length > 0) {
            return c.json({
              success: false,
              error: "This job already exists in your list",
              existingJobId: existing.rows[0].job_id,
            }, 409);
          }

          const result = await query(
            `INSERT INTO jobs (source, company, title, location, posting_url, jd_raw_text, jd_hash, simhash, keywords, level, status, source_message_id)
             VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'new', '')
             RETURNING job_id`,
            [company, title, location || "", posting_url || "", jdRaw, jdHash, simhash.toString(), JSON.stringify(keywords), level],
          );

          const jobId = result.rows[0].job_id;
          logger?.info(`✅ [quick-add] Added job #${jobId}: ${company} — ${title}`);

          // If JD text is thin, try web search enrichment in background
          if (jdRaw.length < 100 && (company && title)) {
            logger?.info(`🔍 [quick-add] Job #${jobId} needs enrichment, starting web search...`);
            (async () => {
              try {
                const enrichResponse = await jobMatchAgent.generateLegacy(
                  [{
                    role: "user",
                    content: `Find the full job description for this job posting:
- Job ID: ${jobId}
- Title: "${title}" at ${company}
- Location: ${location || "unknown"}
${posting_url ? `- URL: ${posting_url}` : ""}

Use webSearch to find: "${title} ${company} job description responsibilities requirements"
Then call the enrich-jobs tool with the results. jd_text must be at least 300 characters.
ONLY use webSearch and enrich-jobs tools.`,
                  }],
                  { maxSteps: 6 },
                );
                logger?.info(`✅ [quick-add] Enrichment complete for job #${jobId}`);
              } catch (err: any) {
                logger?.warn(`⚠️ [quick-add] Enrichment failed for job #${jobId}: ${err.message}`);
              }
            })();
          }

          return c.json({
            success: true,
            job_id: jobId,
            message: `Job added!${jdRaw.length < 100 ? " Web search enrichment running in background." : ""}`,
            needsEnrichment: jdRaw.length < 100,
          });
        } catch (err: any) {
          logger?.error(`❌ [quick-add] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Needs Enrichment: jobs with missing/thin JD text ───── */
    {
      path: "/api/dashboard/needs-enrichment",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }
          const result = await query(`
            SELECT job_id, company, title, location, posting_url, status,
                   COALESCE(LENGTH(jd_raw_text), 0) as jd_length,
                   date_ingested
            FROM jobs
            WHERE jd_raw_text IS NULL OR LENGTH(jd_raw_text) < 100
            ORDER BY date_ingested DESC
          `);
          return c.json({ jobs: result.rows, total: result.rows.length });
        } catch (err: any) {
          logger?.error(`❌ [needs-enrichment] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Enrich jobs via web search (on-demand) ────────────── */
    {
      path: "/api/dashboard/enrich-jobs",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          const body = await c.req.json().catch(() => ({}));
          const requestedIds: number[] | undefined = body.jobIds;

          // Either use provided IDs or find all needs-enrichment jobs
          let jobsToEnrich: any[];
          if (requestedIds && requestedIds.length > 0) {
            const result = await query(
              `SELECT job_id, company, title, location, posting_url
               FROM jobs WHERE job_id = ANY($1)
               AND (jd_raw_text IS NULL OR LENGTH(jd_raw_text) < 100)`,
              [requestedIds],
            );
            jobsToEnrich = result.rows;
          } else {
            const result = await query(
              `SELECT job_id, company, title, location, posting_url
               FROM jobs
               WHERE jd_raw_text IS NULL OR LENGTH(jd_raw_text) < 100
               ORDER BY date_ingested DESC`,
            );
            jobsToEnrich = result.rows;
          }

          if (jobsToEnrich.length === 0) {
            return c.json({ success: true, message: "No jobs need enrichment", queued: 0 });
          }

          logger?.info(`🔍 [enrich] Starting enrichment for ${jobsToEnrich.length} jobs`);

          // Fire-and-forget: run enrichment in background
          (async () => {
            let totalEnriched = 0;
            let totalFailed = 0;

            try {
            // Phase 1: Deterministic URL scraping (fast, free, no LLM)
            const withUrls = jobsToEnrich.filter(
              (j: any) => j.posting_url && j.posting_url.startsWith("http"),
            );

            if (withUrls.length > 0) {
              logger?.info(`🔗 [enrich] Phase 1: URL scraping ${withUrls.length} jobs`);
              try {
                const { enrichJobsByUrl } = await import("./tools/urlScrapeEnricher");
                const urlResult = await enrichJobsByUrl(withUrls, logger as any);
                totalEnriched += urlResult.enrichedCount;
                logger?.info(
                  `🔗 [enrich] URL scraping: ${urlResult.enrichedCount} enriched, ${urlResult.failedCount} failed`,
                );
              } catch (err: any) {
                logger?.error(`❌ [enrich] URL scraping error: ${err.message}`);
              }
            }

            // Phase 2: LLM web search for remaining jobs
            const stillNeedEnrichment = await query(
              `SELECT job_id, company, title, location, posting_url
               FROM jobs WHERE job_id = ANY($1)
               AND (jd_raw_text IS NULL OR LENGTH(jd_raw_text) < 100)`,
              [jobsToEnrich.map((j: any) => j.job_id)],
            );

            if (stillNeedEnrichment.rows.length > 0) {
              logger?.info(
                `🔍 [enrich] Phase 2: LLM web search for ${stillNeedEnrichment.rows.length} remaining jobs`,
              );

              const batchSize = 3;
              const totalBatches = Math.ceil(stillNeedEnrichment.rows.length / batchSize);
              for (let i = 0; i < stillNeedEnrichment.rows.length; i += batchSize) {
                const batch = stillNeedEnrichment.rows.slice(i, i + batchSize);
                const batchNum = Math.floor(i / batchSize) + 1;
                const jobSummaries = batch
                  .map((j: any) =>
                    `- Job ID ${j.job_id}: "${j.title}" at ${j.company} (${j.location})${j.posting_url ? ` — URL: ${j.posting_url}` : ""}`,
                  )
                  .join("\n");

                logger?.info(`🔍 [enrich] Batch ${batchNum}/${totalBatches}: ${batch.length} jobs`);

                try {
                  const enrichResponse = await jobMatchAgent.generateLegacy(
                    [
                      {
                        role: "user",
                        content: `I need you to find full job descriptions for these ${batch.length} jobs. They were parsed from LinkedIn alerts and only have title, company, and location — no job description.

YOUR PROCESS (follow this EXACTLY):
1. For EACH job below, use the webSearch tool to search for: "[job title] [company name] job description responsibilities requirements"
2. From the search results, extract: full responsibilities, requirements, qualifications, preferred skills, compensation/salary, and remote/hybrid status
3. Write a comprehensive job description summary (at least 300 words) for each job based on what you find
4. After searching ALL jobs, call the enrich-jobs tool ONCE with ALL enrichments

Jobs to search:
${jobSummaries}

CRITICAL INSTRUCTIONS:
- You MUST call webSearch BEFORE calling enrich-jobs
- Each enrichment jd_text MUST be at least 300 characters
- Include specific requirements, responsibilities, tools/technologies mentioned
- If you can't find the exact posting, search for the company + role type to understand what they look for
- ONLY use webSearch and enrich-jobs tools in this step.`,
                      },
                    ],
                    { maxSteps: 15 },
                  );

                  const allToolResults =
                    enrichResponse.steps?.flatMap((s: any) => s.toolResults || []) || [];
                  const allResults = allToolResults.map((r: any) => r.result || r);
                  const enrichResult = allResults.find((r: any) => r.enrichedJobIds);
                  totalEnriched += enrichResult?.enrichedCount || 0;
                } catch (err: any) {
                  totalFailed += batch.length;
                  logger?.error(`❌ [enrich] Batch ${batchNum}/${totalBatches} failed: ${err.message}`);
                }

                // Rate-limit delay between batches to avoid OpenAI throttling
                if (i + batchSize < stillNeedEnrichment.rows.length) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
              }
            }

            logger?.info(`✅ [enrich] Done: ${totalEnriched} enriched, ${totalFailed} failed`);
            } catch (outerErr: any) {
              logger?.error(`❌ [enrich] Background enrichment crashed: ${outerErr.message}`);
            }
          })();

          return c.json({
            success: true,
            queued: jobsToEnrich.length,
            jobs: jobsToEnrich.map((j: any) => ({ job_id: j.job_id, company: j.company, title: j.title })),
            message: `Enriching ${jobsToEnrich.length} jobs via web search in background. Check "Needs JD" tab to see progress.`,
          });
        } catch (err: any) {
          logger?.error(`❌ [enrich] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── URL-scrape enrichment (deterministic, no LLM) ────────── */
    {
      path: "/api/dashboard/enrich-urls",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }
          const { enrichAllByUrl } = await import("./tools/urlScrapeEnricher");
          const result = await enrichAllByUrl(logger as any);
          return c.json({
            success: true,
            enrichedCount: result.enrichedCount,
            failedCount: result.failedCount,
            remainingCount: result.remainingCount,
            message: `URL scraping complete: ${result.enrichedCount} enriched, ${result.remainingCount} still need JD.`,
          });
        } catch (err: any) {
          logger?.error(`❌ [enrich-urls] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Manually set JD text for a job ──────────────────────── */
    {
      path: "/api/dashboard/jobs/:id/jd",
      method: "PUT" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = c.req.param("id");
        try {
          const body = await c.req.json();
          const jdText = body.jd_text;
          if (!jdText || typeof jdText !== "string" || jdText.trim().length < 50) {
            return c.json({ error: "jd_text must be at least 50 characters" }, 400);
          }

          const trimmed = jdText.trim();
          const jdHash = computeHash(trimmed);
          const simhash = computeSimhash(trimmed);
          const keywords = extractKeywords(trimmed);

          await query(
            `UPDATE jobs SET jd_raw_text = $1, jd_hash = $2, simhash = $3, keywords = $4
             WHERE job_id = $5`,
            [trimmed, jdHash, simhash.toString(), JSON.stringify(keywords), jobId],
          );

          logger?.info(`✅ [jd-update] Updated JD text for job_id=${jobId} (${trimmed.length} chars)`);
          return c.json({ success: true, job_id: jobId, jd_length: trimmed.length });
        } catch (err: any) {
          logger?.error(`❌ [jd-update] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Dedup log: recent duplicate rejections ─────────────── */
    {
      path: "/api/dashboard/dedup-log",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "100");

          const result = await query(
            `SELECT d.*, j.company as matched_company, j.title as matched_title
             FROM dedup_log d
             LEFT JOIN jobs j ON d.matched_job_id = j.job_id
             ORDER BY d.created_at DESC
             LIMIT $1`,
            [limit],
          );

          const stats = await query(`
            SELECT reason, COUNT(*) as count
            FROM dedup_log
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY reason
            ORDER BY count DESC
          `);

          return c.json({
            entries: result.rows,
            total: result.rows.length,
            stats_7d: stats.rows,
          });
        } catch (err: any) {
          logger?.error(`❌ [dedup-log] Error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
    /* ── Excel/CSV import ───────────────────────────────────── */
    {
      path: "/api/dashboard/import-excel",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        logger?.info(`📥 [import-excel] Starting file import`);

        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          const contentType = c.req.header("content-type") || "";
          let rows: Record<string, any>[] = [];

          if (contentType.includes("multipart/form-data")) {
            const formData = await c.req.formData();
            const file = formData.get("file") as File | null;
            if (!file) {
              return c.json({ error: "No file uploaded. Include a 'file' field." }, 400);
            }
            const buffer = Buffer.from(await file.arrayBuffer());
            const XLSX = await import("xlsx");
            const workbook = XLSX.read(buffer, { type: "buffer" });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) {
              return c.json({ error: "Workbook has no sheets" }, 400);
            }
            rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
            logger?.info(`📥 [import-excel] Parsed ${rows.length} rows from sheet "${sheetName}"`);
          } else if (contentType.includes("application/json")) {
            const body = await c.req.json();
            rows = Array.isArray(body) ? body : body.jobs || [body];
            logger?.info(`📥 [import-excel] Received ${rows.length} jobs via JSON`);
          } else {
            return c.json({ error: "Unsupported content type. Use multipart/form-data (file upload) or application/json." }, 400);
          }

          if (rows.length === 0) {
            return c.json({ error: "No data rows found in file" }, 400);
          }

          // Parse all rows into structured objects first (fast, no DB)
          const parsed: Array<{
            company: string; title: string; location: string; postingUrl: string;
            jdText: string; compensation: string; remoteHybrid: string; source: string;
            jdHash: string; simhash: string; level: string; keywords: string[];
          }> = [];
          let skippedCount = 0;

          for (const row of rows) {
            const company = (row.Company || row.company || row.company_name || row.Organization || "").toString().trim();
            const title = (row.Title || row.title || row.job_title || row["Job Title"] || row.Role || row.role || "").toString().trim();
            const location = (row.Location || row.location || row.City || row.city || "").toString().trim();
            const postingUrl = (row.URL || row.url || row.posting_url || row["Posting URL"] || row.Link || row.link || row["Job URL"] || "").toString().trim();
            const jdText = (row["Job Description"] || row.Description || row.description || row.jd_text || row.JD || row.jd || "").toString().trim();
            const compensation = (row.Compensation || row.compensation || row.Salary || row.salary || row.Pay || "").toString().trim();
            const remoteHybrid = (row["Remote/Hybrid"] || row.remote_hybrid || row.Remote || row.remote || row["Work Type"] || "").toString().trim();
            const source = (row.Source || row.source || "excel-import").toString().trim();

            if (!company && !title) {
              skippedCount++;
              continue;
            }

            const hashInput = jdText || `${company}|${title}|${location}|${postingUrl}`;
            parsed.push({
              company, title, location, postingUrl, jdText, compensation, remoteHybrid, source,
              jdHash: computeHash(hashInput),
              simhash: computeSimhash(jdText),
              level: classifyLevel(title),
              keywords: extractKeywords(jdText),
            });
          }

          // Batch dedup: fetch all existing hashes in one query
          const allHashes = parsed.map(p => p.jdHash);
          const existingHashResult = await query(
            `SELECT jd_hash FROM jobs WHERE jd_hash = ANY($1)`,
            [allHashes],
          );
          const existingHashes = new Set(existingHashResult.rows.map((r: any) => r.jd_hash));

          // Batch dedup by company+title (recent 14 days)
          const companyTitlePairs = parsed
            .filter(p => p.company && p.title && !existingHashes.has(p.jdHash))
            .map(p => ({
              normCompany: normalizeText(p.company).replace(/\s/g, ""),
              normTitle: normalizeText(p.title).replace(/\s/g, ""),
              jdHash: p.jdHash,
            }));

          const existingByNameSet = new Set<string>();
          if (companyTitlePairs.length > 0) {
            // Build a batch lookup: unnest arrays for efficient matching
            const companies = companyTitlePairs.map(p => p.normCompany);
            const titles = companyTitlePairs.map(p => p.normTitle);
            const nameMatches = await query(
              `SELECT LOWER(REPLACE(company, ' ', '')) AS nc, LOWER(REPLACE(title, ' ', '')) AS nt
               FROM jobs
               WHERE LOWER(REPLACE(company, ' ', '')) = ANY($1)
               AND LOWER(REPLACE(title, ' ', '')) = ANY($2)
               AND date_ingested > NOW() - INTERVAL '14 days'`,
              [companies, titles],
            );
            for (const r of nameMatches.rows) {
              existingByNameSet.add(`${r.nc}||${r.nt}`);
            }
          }

          // Filter to non-duplicate rows
          let duplicateCount = 0;
          const toInsert = parsed.filter(p => {
            if (existingHashes.has(p.jdHash)) { duplicateCount++; return false; }
            if (p.company && p.title) {
              const key = `${normalizeText(p.company).replace(/\s/g, "")}||${normalizeText(p.title).replace(/\s/g, "")}`;
              if (existingByNameSet.has(key)) { duplicateCount++; return false; }
            }
            return true;
          });

          // Batch insert using multi-row VALUES (chunks of 50 to stay under param limits)
          const newJobIds: number[] = [];
          const CHUNK_SIZE = 50;
          const today = new Date().toISOString().split("T")[0];

          for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
            const chunk = toInsert.slice(i, i + CHUNK_SIZE);
            const values: any[] = [];
            const placeholders: string[] = [];

            for (let j = 0; j < chunk.length; j++) {
              const p = chunk[j];
              const offset = j * 16;
              placeholders.push(
                `($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8}, $${offset+9}, $${offset+10}, $${offset+11}, $${offset+12}, $${offset+13}, $${offset+14}, $${offset+15}, $${offset+16})`
              );
              values.push(
                p.source,
                `excel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                p.company,
                p.title,
                p.location,
                p.remoteHybrid || "Unknown",
                p.level,
                p.postingUrl,
                today,
                p.jdText,
                p.jdHash,
                p.simhash,
                JSON.stringify(p.keywords),
                p.postingUrl || null,
                "new",
                p.compensation,
              );
            }

            const insertResult = await query(
              `INSERT INTO jobs (source, source_message_id, company, title, location, remote_hybrid, level, posting_url, date_posted, jd_raw_text, jd_hash, simhash, keywords, url_canonical, status, compensation)
               VALUES ${placeholders.join(", ")}
               RETURNING job_id`,
              values,
            );
            for (const r of insertResult.rows) {
              newJobIds.push(r.job_id);
            }
            logger?.info(`📥 [import-excel] Inserted chunk ${Math.floor(i/CHUNK_SIZE)+1}: ${chunk.length} jobs`);
          }

          logger?.info(`📥 [import-excel] Done: ${newJobIds.length} new, ${duplicateCount} dupes, ${skippedCount} skipped`);

          // Fire-and-forget: score in background, then auto-generate packets
          if (newJobIds.length > 0) {
            scoreJobsTool.execute!({
              context: { jobIds: newJobIds, topN: newJobIds.length },
              mastra,
            } as any)
              .then((result: any) => {
                logger?.info(`✅ [import-excel] Background scoring complete: ${result.totalScored} scored`);
                // Auto-generate packets for the imported jobs that score well
                const autoGen = process.env.AUTO_GENERATE_AFTER_SCORE !== "false";
                if (autoGen) {
                  logger?.info(`🤖 [import-excel] Triggering auto-generation for recommended imports`);
                  autoGenerateInBackground({ mastra, jobIds: newJobIds, minScore: 60, maxAttempts: 2 });
                }
              })
              .catch((err: any) => logger?.error(`⚠️ [import-excel] Background scoring failed: ${err.message}`));
          }

          return c.json({
            success: true,
            imported: newJobIds.length,
            duplicates: duplicateCount,
            skipped: skippedCount,
            totalRows: rows.length,
            jobIds: newJobIds,
            scoring: "in_progress",
            message: `Imported ${newJobIds.length} jobs (${duplicateCount} duplicates, ${skippedCount} skipped). Scoring in background.`,
          });
        } catch (err: any) {
          logger?.error(`❌ [import-excel] Error: ${err.message}`);
          return c.json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5) }, 500);
        }
      },
    },
    // ── Cost Tracking Endpoints ────────────────────────────────────

    {
      path: "/api/dashboard/cost/job/:jobId",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const { getPacketCost, getStageCost } = await import("../resume-engine/cost-tracker");
        const jobId = parseInt(c.req.param("jobId"));
        if (isNaN(jobId)) return c.json({ error: "Invalid job_id" }, 400);

        const [packetCost, stageCosts] = await Promise.all([
          getPacketCost(jobId),
          getStageCost(jobId),
        ]);

        return c.json({
          job_id: jobId,
          cost: packetCost,
          stages: stageCosts,
        });
      },
    },
    {
      path: "/api/dashboard/cost/daily",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const { COST_QUERY_DAILY } = await import("../resume-engine/cost-tracker");
        const days = parseInt(c.req.query("days") || "30");
        try {
          const result = await query(COST_QUERY_DAILY, [days]);
          return c.json({ days: result.rows });
        } catch (err: any) {
          return c.json({ error: err.message }, 500);
        }
      },
    },
    {
      path: "/api/dashboard/cost/run/:runId",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const { getRunCost } = await import("../resume-engine/cost-tracker");
        const runId = c.req.param("runId");
        const runCost = await getRunCost(runId);
        return c.json({ run_id: runId, cost: runCost });
      },
    },
  ];
}
