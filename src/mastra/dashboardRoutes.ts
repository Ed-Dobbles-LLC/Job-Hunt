import { query } from "./tools/db";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./tools/paths";
import mammoth from "mammoth";

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getDashboardRoutes() {
  return [
    {
      path: "/dashboard",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const htmlPath = path.join(__dirname, "public", "index.html");
        let html = "";
        if (fs.existsSync(htmlPath)) {
          html = fs.readFileSync(htmlPath, "utf-8");
        } else {
          const altPath = workspacePath("src/mastra/public/index.html");
          if (fs.existsSync(altPath)) {
            html = fs.readFileSync(altPath, "utf-8");
          } else {
            return c.text("Dashboard not found", 404);
          }
        }
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
          return c.json({ error: err.message }, 500);
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
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = (page - 1) * limit;

          const result = await query(`
            SELECT j.job_id, j.company, j.title, j.location, j.remote_hybrid,
                   j.posting_url, j.status, j.date_ingested, j.compensation,
                   j.user_action,
                   s.total_score,
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
            "SELECT * FROM artifacts WHERE job_id = $1 ORDER BY created_ts DESC LIMIT 1",
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
        logger?.info("🚀 [dashboard] Triggering workflow");
        try {
          const resp = await fetch("http://localhost:5000/api/workflows/job-match-workflow/start-async", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inputData: {} }),
          });
          const data = await resp.json();
          logger?.info(`🚀 [dashboard] Workflow triggered: ${JSON.stringify(data)}`);
          return c.json({ success: true, ...data });
        } catch (err: any) {
          logger?.error(`❌ [dashboard] Trigger error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
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

          if (!filePath) {
            return c.json({ error: `No ${type} file available` }, 404);
          }

          const resolvedPath = filePath.startsWith("/") ? filePath : workspacePath(filePath);

          if (!fs.existsSync(resolvedPath)) {
            return c.json({ error: "File not found on disk" }, 404);
          }

          let contentHtml = "";

          if (type === "evidence" || type === "verifier") {
            const jsonContent = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
            contentHtml = `<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:monospace;font-size:13px;line-height:1.6;">${escapeHtml(JSON.stringify(jsonContent, null, 2))}</pre>`;
          } else {
            const result = await mammoth.convertToHtml({ path: resolvedPath });
            contentHtml = result.value;
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

          if (!filePath) {
            return c.json({ error: `No ${type} file available` }, 404);
          }

          const resolvedPath = filePath.startsWith("/") ? filePath : workspacePath(filePath);

          if (!fs.existsSync(resolvedPath)) {
            logger?.warn(`📥 [dashboard] File not found: ${resolvedPath}`);
            return c.json({ error: "File not found on disk" }, 404);
          }

          const fileBuffer = fs.readFileSync(resolvedPath);
          return new Response(fileBuffer, {
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
  ];
}
