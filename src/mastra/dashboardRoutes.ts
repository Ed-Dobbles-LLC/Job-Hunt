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
import { renderResumeDocx, renderCoverLetterDocx } from "./tools/docxRenderer";
import {
  normalizeText,
  computeHash,
  computeSimhash,
  classifyLevel,
  extractKeywords,
} from "./tools/jobPostingSchema";

let dbReady = false;

// In-memory generation log — survives within a single deploy
interface GenLogEntry { ts: string; jobId: number; company: string; title: string; status: "running" | "success" | "error"; message: string; phase?: string; }
const generationLog: GenLogEntry[] = [];
function logGen(entry: Omit<GenLogEntry, "ts">) {
  generationLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (generationLog.length > 100) generationLog.length = 100;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Load experience inventory — checks DB first, then filesystem */
async function loadInventoryProfile(): Promise<Record<string, any>> {
  try {
    const dbResult = await query("SELECT value FROM app_settings WHERE key = 'experience_inventory'");
    if (dbResult.rows.length > 0 && dbResult.rows[0].value) {
      return JSON.parse(dbResult.rows[0].value);
    }
  } catch { /* fall through to filesystem */ }
  try {
    return JSON.parse(fs.readFileSync(workspacePath("experience_inventory.json"), "utf-8"));
  } catch {
    return { profile: { name: "Candidate" } };
  }
}

export function getDashboardRoutes() {
  return [
    {
      path: "/dashboard",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
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
            if (type === "evidence" || type === "verifier") {
              const jsonContent = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
              contentHtml = `<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:monospace;font-size:13px;line-height:1.6;">${escapeHtml(JSON.stringify(jsonContent, null, 2))}</pre>`;
            } else {
              const result = await mammoth.convertToHtml({ path: resolvedPath });
              contentHtml = result.value;
            }
          } else {
            // Serve from DB blob
            const blobCol = type === "resume" ? "resume_docx" : type === "cover" ? "cover_docx" : type === "evidence" ? "evidence_map_json" : "verifier_json";
            const blobRow = await query(`SELECT ${blobCol} FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1`, [jobId]);
            const blob = blobRow.rows[0]?.[blobCol];
            if (!blob) {
              return c.json({ error: `No ${type} data available. Try regenerating the packet.` }, 404);
            }
            if (type === "evidence" || type === "verifier") {
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
      <button class="toolbar-btn print" onclick="window.print()">Print / Save PDF</button>
      <a class="toolbar-btn" href="/api/dashboard/download/${jobId}/${type}">Download DOCX</a>
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
          let filePath = "";
          let contentType = "application/octet-stream";
          let filename = "";

          switch (type) {
            case "resume":
              filePath = row.resume_docx_path;
              contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
              filename = `resume_${jobId}.docx`;
              break;
            case "cover":
              filePath = row.cover_docx_path;
              contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
              filename = `cover_letter_${jobId}.docx`;
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
            const blobCol = type === "resume" ? "resume_docx" : type === "cover" ? "cover_docx" : type === "evidence" ? "evidence_map_json" : "verifier_json";
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
            const inv = await loadInventoryProfile();
            if (!inv.profile || inv.profile.name === "Candidate") {
              return c.json({
                error: "Experience inventory not found. Go to Profile Builder to upload and finalize your resume first.",
                phase: "preflight",
              }, 400);
            }
          } catch { /* check is best-effort */ }

          // Load job
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
          logGen({ jobId, company: job.company, title: job.title, status: "running", message: "Starting generation...", phase: "init" });

          if (!job.jd_raw_text || job.jd_raw_text.length < 100) {
            return c.json({
              error: `Job has insufficient JD text (${(job.jd_raw_text || '').length} chars, need 100+). The JD may not have been fully extracted from the email. Try re-running the workflow or manually adding job description text.`,
              phase: "validation",
            }, 400);
          }

          // Phase 1: Extract JD requirements if missing
          if (!job.jd_requirements) {
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
              return c.json({
                error: `Failed to extract JD requirements: ${phase1Err.message}`,
                phase: "extract-requirements",
                hint: phase1Err.message.includes("API key") || phase1Err.message.includes("401")
                  ? "Check your OpenAI API key in Railway environment variables."
                  : phase1Err.message.includes("rate") || phase1Err.message.includes("429")
                  ? "OpenAI rate limit hit. Wait a moment and try again."
                  : undefined,
              }, 500);
            }
          }

          // Phase 2: Generate verified packet (resume + cover letter + truth verification)
          logger?.info(`📄 [generate-packet] Phase 2: Generating verified packet...`);
          let packetResult: any;
          try {
            packetResult = await generateVerifiedPacketTool.execute!({
              context: {
                job_id: jobId,
                company: job.company,
                title: job.title,
                max_attempts: 2,
              },
              mastra,
            } as any);
            logger?.info(`✅ [generate-packet] Phase 2 complete: pass=${packetResult.pass}, attempts=${packetResult.attempts_used}`);
          } catch (phase2Err: any) {
            logger?.error(`❌ [generate-packet] Phase 2 failed: ${phase2Err.message}`);
            logGen({ jobId, company: job.company, title: job.title, status: "error", message: phase2Err.message, phase: "generate-packet" });
            return c.json({
              error: `Failed to generate resume/cover letter: ${phase2Err.message}`,
              phase: "generate-packet",
              hint: phase2Err.message.includes("API key") || phase2Err.message.includes("401")
                ? "Check your OpenAI API key in Railway environment variables."
                : phase2Err.message.includes("rate") || phase2Err.message.includes("429")
                ? "OpenAI rate limit hit. Wait a moment and try again."
                : phase2Err.message.includes("All") && phase2Err.message.includes("attempts failed")
                ? "The AI couldn't generate a verified resume after multiple attempts. Try again — results vary between runs."
                : undefined,
            }, 500);
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

          // Phase 4: Render DOCX and save to DB (primary) + filesystem (best-effort)
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
            logger?.info(`💾 [generate-packet] Artifacts saved to DB for job_id=${jobId}`);
          } catch (dbErr: any) {
            logger?.error(`❌ [generate-packet] DB save failed: ${dbErr.message}`);
            logGen({ jobId, company: job.company, title: job.title, status: "error", message: `DB save failed: ${dbErr.message}`, phase: "db-save" });
            return c.json({
              error: `Resume generated but failed to save to database: ${dbErr.message}`,
              phase: "db-save",
              hint: "The resume was generated successfully but couldn't be saved. This is a database error.",
            }, 500);
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

          return c.json({
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
          });
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          const errStack = err?.stack?.split('\n').slice(0, 8) || [];
          logger?.error(`❌ [generate-packet] Unhandled error: ${errMsg}\n${errStack.join('\n')}`);
          logGen({ jobId, company: "?", title: "?", status: "error", message: errMsg, phase: "unknown" });
          return c.json({ error: errMsg, phase: "unknown", stack: errStack }, 500);
        }
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
            .then((result: any) => logger?.info(`✅ [rescore] Done: ${result.totalScored} scored`))
            .catch((err: any) => logger?.error(`⚠️ [rescore] Failed: ${err.message}`));

          return c.json({ success: true, message: `Scoring ${jobIds.length} jobs in background`, count: jobIds.length });
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
                const packetResult = await generateVerifiedPacketTool.execute!({
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
            jdHash: string; simhash: number; level: string; keywords: string[];
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

          // Fire-and-forget: score in background so response returns immediately
          if (newJobIds.length > 0) {
            scoreJobsTool.execute!({
              context: { jobIds: newJobIds, topN: newJobIds.length },
              mastra,
            } as any)
              .then((result: any) => logger?.info(`✅ [import-excel] Background scoring complete: ${result.totalScored} scored`))
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
  ];
}
