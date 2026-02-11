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
import {
  normalizeText,
  computeHash,
  computeSimhash,
  classifyLevel,
  extractKeywords,
} from "./tools/jobPostingSchema";

let dbReady = false;

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
          const limit = parseInt(url.searchParams.get("limit") || "50");
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

          if (!filePath) {
            return c.json({ error: `No ${type} file available` }, 404);
          }

          // Resolve path: try relative first (new format), then absolute (old format)
          let resolvedPath = filePath.startsWith("/") ? filePath : workspacePath(filePath);
          if (!fs.existsSync(resolvedPath) && !filePath.startsWith("/")) {
            // Already tried relative → workspacePath, no other fallback
          } else if (!fs.existsSync(resolvedPath) && filePath.startsWith("/")) {
            // Old absolute path doesn't exist, try as relative from workspace root
            const asRelative = workspacePath(filePath.replace(/^\/app\//, "").replace(/^\/home\/user\/Job-Hunt\//, ""));
            if (fs.existsSync(asRelative)) {
              resolvedPath = asRelative;
            }
          }

          if (!fs.existsSync(resolvedPath)) {
            logger?.warn(`👁️ [dashboard] File not found at: ${resolvedPath} (original: ${filePath})`);
            return c.json({ error: `File not found on disk. The file may have been generated on a previous deployment. Try regenerating the packet.`, original_path: filePath }, 404);
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

          // Resolve path: try relative first (new format), then absolute (old format)
          let resolvedPath = filePath.startsWith("/") ? filePath : workspacePath(filePath);
          if (!fs.existsSync(resolvedPath) && filePath.startsWith("/")) {
            const asRelative = workspacePath(filePath.replace(/^\/app\//, "").replace(/^\/home\/user\/Job-Hunt\//, ""));
            if (fs.existsSync(asRelative)) {
              resolvedPath = asRelative;
            }
          }

          if (!fs.existsSync(resolvedPath)) {
            logger?.warn(`📥 [dashboard] File not found: ${resolvedPath} (original: ${filePath})`);
            return c.json({ error: "File not found on disk. Try regenerating the packet." }, 404);
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
    {
      path: "/api/dashboard/generate-packet/:jobId",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const jobId = parseInt(c.req.param("jobId"));
        logger?.info(`🔄 [generate-packet] Starting for job_id=${jobId}`);

        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          // Preflight: check OpenAI API key
          if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
            return c.json({
              error: "OpenAI API key not configured. Set AI_INTEGRATIONS_OPENAI_API_KEY in Railway environment variables (Settings > Variables).",
              phase: "preflight",
            }, 400);
          }

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

          // Phase 4: Build output files (DOCX, evidence JSON, verifier JSON)
          logger?.info(`📁 [generate-packet] Phase 4: Building output files...`);
          let buildResult: any;
          try {
            buildResult = await buildOutputTool.execute!({
              context: {
                job_id: jobId,
                company: job.company,
                title: job.title,
                resume: packetResult.resume,
                cover_letter: packetResult.cover_letter,
                evidenceMap: combinedEvidence,
                verifierResult: packetResult.final_report,
                scoringBreakdown: job.breakdown_json || {},
                totalScore: job.total_score || 0,
                skip_pdf: false,
              },
              mastra,
            } as any);
            logger?.info(`✅ [generate-packet] Phase 4 complete: ${buildResult?.files?.length || 0} files`);
          } catch (phase4Err: any) {
            logger?.error(`❌ [generate-packet] Phase 4 failed: ${phase4Err.message}`);
            return c.json({
              error: `Resume generated but failed to save files: ${phase4Err.message}`,
              phase: "build-output",
              hint: "The resume and cover letter were generated successfully by AI, but saving the DOCX files failed. This may be a server disk or LibreOffice issue.",
            }, 500);
          }

          // Update job status
          await query(
            "UPDATE jobs SET status = $1 WHERE job_id = $2",
            [packetResult.pass ? "generated" : "generated-unverified", jobId],
          );

          const resumeExp = packetResult.resume?.experience || [];
          logger?.info(`✅ [generate-packet] Done! pass=${packetResult.pass}, files=${buildResult?.files?.length || 0}`);

          return c.json({
            success: true,
            job_id: jobId,
            company: job.company,
            title: job.title,
            truth_pass: packetResult.pass,
            attempts_used: packetResult.attempts_used,
            evidence_count: combinedEvidence.length,
            files: buildResult?.files?.length || 0,
            output_dir: buildResult?.outputDir || "",
            resume_summary: packetResult.resume?.professional_summary || "",
            resume_roles: resumeExp.length,
            resume_bullets: resumeExp.reduce((s: number, e: any) => s + (e?.bullets?.length || 0), 0),
            ats_keywords: packetResult.resume?.ats_keywords_used || [],
            gap_notes: packetResult.resume?.gap_notes || [],
            cover_letter_words: packetResult.cover_letter?.word_count || 0,
          });
        } catch (err: any) {
          logger?.error(`❌ [generate-packet] Unhandled error: ${err.message}`);
          return c.json({ error: err.message, phase: "unknown", stack: err.stack?.split('\n').slice(0, 5) }, 500);
        }
      },
    },
    /* ── Re-score unscored jobs ─────────────────────────────── */
    {
      path: "/api/dashboard/rescore",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        try {
          if (!dbReady) { await initDatabase(); dbReady = true; }

          const unscoredResult = await query(
            `SELECT j.job_id FROM jobs j LEFT JOIN scores s ON j.job_id = s.job_id WHERE s.job_id IS NULL`
          );
          const unscoredIds = unscoredResult.rows.map((r: any) => Number(r.job_id));

          if (unscoredIds.length === 0) {
            return c.json({ success: true, message: "All jobs already scored", unscored: 0 });
          }

          logger?.info(`📊 [rescore] Scoring ${unscoredIds.length} unscored jobs in background...`);

          // Fire-and-forget
          scoreJobsTool.execute!({
            context: { jobIds: unscoredIds, topN: unscoredIds.length },
            mastra,
          } as any)
            .then((result: any) => logger?.info(`✅ [rescore] Done: ${result.totalScored} scored`))
            .catch((err: any) => logger?.error(`⚠️ [rescore] Failed: ${err.message}`));

          return c.json({ success: true, message: `Scoring ${unscoredIds.length} unscored jobs in background`, unscored: unscoredIds.length });
        } catch (err: any) {
          logger?.error(`❌ [rescore] Error: ${err.message}`);
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
