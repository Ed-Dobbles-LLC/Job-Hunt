import { query } from "./tools/db";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./tools/paths";

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
