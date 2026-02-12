import * as fs from "fs";
import * as crypto from "crypto";
import { query } from "./tools/db";
import { workspacePath, findPublicFile } from "./tools/paths";
import { parseResumeBuffer } from "./tools/resumeParserTool";
import { structureResume } from "./tools/resumeStructurerTool";
import {
  generateInterviewQuestions,
  processAnswers,
  type RoleContext,
} from "./tools/profileInterviewTool";
import type { ExperienceInventory, Gap } from "./tools/profileSchemas";

const MAX_INTERVIEW_ROUNDS = 4;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

let dbInitialized = false;
async function ensureProfileTable() {
  if (dbInitialized) return;
  await query(`
    CREATE TABLE IF NOT EXISTS profile_sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'parsing',
      raw_resume_text TEXT,
      resume_filename TEXT,
      resume_format TEXT,
      target_role TEXT DEFAULT '',
      interview_focus TEXT DEFAULT 'leadership',
      current_draft JSONB,
      gaps JSONB DEFAULT '[]'::jsonb,
      qa_history JSONB DEFAULT '[]'::jsonb,
      questions JSONB DEFAULT '[]'::jsonb,
      error_message TEXT,
      interview_round INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalized_at TIMESTAMPTZ
    )
  `);
  // Add columns if table already exists (idempotent migration)
  await query(`ALTER TABLE profile_sessions ADD COLUMN IF NOT EXISTS target_role TEXT DEFAULT ''`).catch(() => {});
  await query(`ALTER TABLE profile_sessions ADD COLUMN IF NOT EXISTS interview_focus TEXT DEFAULT 'leadership'`).catch(() => {});
  await query(`ALTER TABLE profile_sessions ADD COLUMN IF NOT EXISTS questions JSONB DEFAULT '[]'::jsonb`).catch(() => {});
  await query(`ALTER TABLE profile_sessions ADD COLUMN IF NOT EXISTS error_message TEXT`).catch(() => {});
  // Ensure app_settings table exists for inventory persistence
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  dbInitialized = true;
}

export function getProfileBuilderRoutes() {
  return [
    /* ── Debug: show what paths the server is trying ────────────── */
    {
      path: "/api/profile/debug-paths",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const resolved = findPublicFile("profile.html");
        return c.json({
          __dirname,
          cwd: process.cwd(),
          WORKSPACE_ROOT: workspacePath(),
          resolvedFile: resolved,
          exists: resolved ? fs.existsSync(resolved) : false,
        });
      },
    },

    /* ── Serve the profile builder UI ───────────────────────────── */
    {
      path: "/profile",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const found = findPublicFile("profile.html");
        if (!found) {
          return c.text("Profile builder page not found", 404);
        }
        const html = fs.readFileSync(found, "utf-8");
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },

    /* ── Upload resume & kick off parsing (returns immediately) ──── */
    {
      path: "/api/profile/upload",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        logger?.info("[profileBuilder] Upload request received");

        try {
          await ensureProfileTable();
          const body = await c.req.parseBody();
          const file = body["resume"];

          if (!file || typeof file === "string") {
            return c.json({ error: "No resume file provided. Send as multipart form field 'resume'." }, 400);
          }

          const arrayBuffer = await file.arrayBuffer();
          if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
            return c.json({ error: "File too large. Maximum size is 10 MB." }, 400);
          }

          const buffer = Buffer.from(arrayBuffer);
          const fileName = file.name || "resume.txt";
          const sessionId = crypto.randomUUID();
          const targetRole = typeof body["targetRole"] === "string" ? body["targetRole"] : "";
          const interviewFocus = typeof body["interviewFocus"] === "string" ? body["interviewFocus"] : "leadership";

          logger?.info(`[profileBuilder] Parsing resume: ${fileName} (${buffer.length} bytes), targetRole="${targetRole}", focus="${interviewFocus}"`);

          // 1. Extract raw text (fast — no LLM needed)
          const { rawText, format } = await parseResumeBuffer(buffer, fileName);
          if (!rawText || rawText.trim().length < 50) {
            return c.json({ error: "Could not extract meaningful text from the uploaded file. Please try a different format." }, 400);
          }

          logger?.info(`[profileBuilder] Extracted ${rawText.length} chars as ${format}`);

          // 2. Save session immediately with status "processing"
          await query(
            `INSERT INTO profile_sessions (session_id, status, raw_resume_text, resume_filename, resume_format, target_role, interview_focus, current_draft, gaps, qa_history, questions, interview_round)
             VALUES ($1, 'processing', $2, $3, $4, $5, $6, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`,
            [sessionId, rawText, fileName, format, targetRole, interviewFocus],
          );

          logger?.info(`[profileBuilder] Session ${sessionId} created, starting background processing`);

          // 3. Return immediately — UI will poll /api/profile/session/:id
          // 4. Background processing (non-blocking)
          (async () => {
            try {
              // Phase 1: Structure resume with LLM
              logger?.info(`[profileBuilder] [${sessionId}] Structuring resume...`);
              await query(
                "UPDATE profile_sessions SET status = 'structuring', updated_at = NOW() WHERE session_id = $1",
                [sessionId],
              );
              const { draft, gaps } = await structureResume(rawText, interviewFocus);

              // Phase 2: Generate interview questions
              logger?.info(`[profileBuilder] [${sessionId}] Generating questions...`);
              await query(
                "UPDATE profile_sessions SET status = 'generating_questions', current_draft = $1, gaps = $2, updated_at = NOW() WHERE session_id = $3",
                [JSON.stringify(draft), JSON.stringify(gaps), sessionId],
              );
              const questions = await generateInterviewQuestions(draft, gaps, [], { targetRole, interviewFocus });

              // Phase 3: Mark ready for interview
              await query(
                `UPDATE profile_sessions SET status = 'interviewing', current_draft = $1, gaps = $2, questions = $3, interview_round = 1, updated_at = NOW() WHERE session_id = $4`,
                [JSON.stringify(draft), JSON.stringify(gaps), JSON.stringify(questions), sessionId],
              );
              logger?.info(`[profileBuilder] [${sessionId}] Ready for interview (${gaps.length} gaps, ${questions.length} questions)`);
            } catch (err: any) {
              logger?.error(`[profileBuilder] [${sessionId}] Background processing failed: ${err.message}`);
              await query(
                "UPDATE profile_sessions SET status = 'error', error_message = $1, updated_at = NOW() WHERE session_id = $2",
                [err?.message || String(err), sessionId],
              ).catch(() => {});
            }
          })();

          return c.json({ sessionId, status: "processing" });
        } catch (err: any) {
          logger?.error(`[profileBuilder] Upload error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Get session state ──────────────────────────────────────── */
    {
      path: "/api/profile/session/:id",
      method: "GET" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const sessionId = c.req.param("id");
        try {
          const result = await query(
            "SELECT * FROM profile_sessions WHERE session_id = $1",
            [sessionId],
          );
          if (result.rows.length === 0) {
            return c.json({ error: "Session not found" }, 404);
          }
          const row = result.rows[0];
          return c.json({
            sessionId: row.session_id,
            status: row.status,
            draft: row.current_draft,
            gaps: row.gaps,
            questions: row.questions || [],
            qaHistory: row.qa_history,
            interviewRound: row.interview_round,
            resumeFilename: row.resume_filename,
            createdAt: row.created_at,
            errorMessage: row.error_message,
          });
        } catch (err: any) {
          logger?.error(`[profileBuilder] Session fetch error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Submit interview answers & get next questions ──────────── */
    {
      path: "/api/profile/interview/:id",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const sessionId = c.req.param("id");

        try {
          const result = await query(
            "SELECT * FROM profile_sessions WHERE session_id = $1",
            [sessionId],
          );
          if (result.rows.length === 0) {
            return c.json({ error: "Session not found" }, 404);
          }
          const session = result.rows[0];
          if (session.status !== "interviewing") {
            return c.json({ error: `Session is in '${session.status}' state, not 'interviewing'` }, 400);
          }

          const body = await c.req.json();
          const answers: Array<{ questionId: string; question: string; answer: string }> = body.answers || [];
          const skipped: Array<{ questionId: string; question: string; answer: string }> = body.skipped || [];
          if (answers.length === 0) {
            return c.json({ error: "No answers provided" }, 400);
          }

          const draft: ExperienceInventory = session.current_draft;
          const gaps: Gap[] = session.gaps;
          const qaHistory: Array<{ questionId: string; question: string; answer: string }> = session.qa_history || [];
          const round = session.interview_round || 1;
          const targetRole = session.target_role || "";
          const interviewFocus = session.interview_focus || "leadership";
          const roleContext = { targetRole, interviewFocus };

          logger?.info(`[profileBuilder] Processing ${answers.length} answers (${skipped.length} skipped) for session ${sessionId} (round ${round})`);

          // Process only real answers (not skipped ones)
          const { updatedDraft, remainingGaps, isComplete } = await processAnswers(draft, gaps, answers, roleContext);

          // Update Q&A history — include skipped questions so AI won't re-ask them
          const updatedQA = [...qaHistory, ...answers, ...skipped];
          const nextRound = round + 1;
          let nextQuestions: any[] = [];
          let newStatus = "interviewing";

          if (isComplete || nextRound > MAX_INTERVIEW_ROUNDS) {
            newStatus = "review";
            logger?.info(`[profileBuilder] Interview complete for session ${sessionId}`);
          } else {
            // Generate next round of questions (role-aware)
            const qaForLLM = updatedQA.map((qa) => ({ question: qa.question, answer: qa.answer }));
            nextQuestions = await generateInterviewQuestions(updatedDraft, remainingGaps, qaForLLM, roleContext);
            logger?.info(`[profileBuilder] Generated ${nextQuestions.length} questions for round ${nextRound}`);
          }

          // Save to DB
          await query(
            `UPDATE profile_sessions
             SET status = $1, current_draft = $2, gaps = $3, qa_history = $4, interview_round = $5, updated_at = NOW()
             WHERE session_id = $6`,
            [
              newStatus,
              JSON.stringify(updatedDraft),
              JSON.stringify(remainingGaps),
              JSON.stringify(updatedQA),
              nextRound,
              sessionId,
            ],
          );

          return c.json({
            sessionId,
            status: newStatus,
            draft: updatedDraft,
            gaps: remainingGaps,
            questions: nextQuestions,
            interviewRound: nextRound,
            isComplete: newStatus === "review",
          });
        } catch (err: any) {
          logger?.error(`[profileBuilder] Interview error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Skip interview and go straight to review ───────────────── */
    {
      path: "/api/profile/skip-interview/:id",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const sessionId = c.req.param("id");
        try {
          const result = await query(
            "SELECT * FROM profile_sessions WHERE session_id = $1",
            [sessionId],
          );
          if (result.rows.length === 0) {
            return c.json({ error: "Session not found" }, 404);
          }
          await query(
            "UPDATE profile_sessions SET status = 'review', updated_at = NOW() WHERE session_id = $1",
            [sessionId],
          );
          logger?.info(`[profileBuilder] Skipped interview for session ${sessionId}`);
          return c.json({ sessionId, status: "review", draft: result.rows[0].current_draft });
        } catch (err: any) {
          logger?.error(`[profileBuilder] Skip error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Finalize: save as experience_inventory.json ────────────── */
    {
      path: "/api/profile/finalize/:id",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const sessionId = c.req.param("id");
        try {
          const result = await query(
            "SELECT * FROM profile_sessions WHERE session_id = $1",
            [sessionId],
          );
          if (result.rows.length === 0) {
            return c.json({ error: "Session not found" }, 404);
          }
          const session = result.rows[0];
          if (session.status !== "review" && session.status !== "interviewing") {
            return c.json({ error: `Session is in '${session.status}' state. Must be 'review' or 'interviewing' to finalize.` }, 400);
          }

          let finalDraft: ExperienceInventory = session.current_draft;

          // Allow optional manual edits in the request body
          const body = await c.req.json().catch(() => ({}));
          if (body.edits) {
            // Deep merge edits into draft (shallow keys only for safety)
            finalDraft = { ...finalDraft, ...body.edits };
          }

          // Store inventory in DB (survives Railway redeploys)
          const inventoryJson = JSON.stringify(finalDraft, null, 2);
          await query(
            `INSERT INTO app_settings (key, value, updated_at) VALUES ('experience_inventory', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [inventoryJson],
          );
          logger?.info(`[profileBuilder] Saved inventory to DB for ${finalDraft.profile.name}`);

          // Also write to filesystem (best-effort, may not survive Railway redeploy)
          try {
            const inventoryPath = workspacePath("experience_inventory.json");
            if (fs.existsSync(inventoryPath)) {
              const backupPath = workspacePath("experience_inventory.backup.json");
              fs.copyFileSync(inventoryPath, backupPath);
            }
            fs.writeFileSync(inventoryPath, inventoryJson, "utf-8");
            logger?.info(`[profileBuilder] Wrote experience_inventory.json to disk`);
          } catch (diskErr: any) {
            logger?.warn(`[profileBuilder] Disk write failed (non-critical): ${diskErr.message}`);
          }

          // Mark session as finalized
          await query(
            "UPDATE profile_sessions SET status = 'finalized', finalized_at = NOW(), updated_at = NOW() WHERE session_id = $1",
            [sessionId],
          );

          return c.json({
            success: true,
            sessionId,
            status: "finalized",
            profile: finalDraft.profile,
            message: `Profile saved for ${finalDraft.profile.name}. The job match system will now use your profile.`,
          });
        } catch (err: any) {
          logger?.error(`[profileBuilder] Finalize error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },

    /* ── Get current experience_inventory.json ──────────────────── */
    {
      path: "/api/profile/current",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        // Check DB first (survives Railway redeploys)
        try {
          const dbResult = await query("SELECT value FROM app_settings WHERE key = 'experience_inventory'");
          if (dbResult.rows.length > 0 && dbResult.rows[0].value) {
            return c.json(JSON.parse(dbResult.rows[0].value));
          }
        } catch { /* fall through to filesystem */ }

        const inventoryPath = workspacePath("experience_inventory.json");
        if (!fs.existsSync(inventoryPath)) {
          return c.json({ error: "No profile found. Upload a resume to get started." }, 404);
        }
        const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
        return c.json(inventory);
      },
    },

    /* ── Delete a session ───────────────────────────────────────── */
    {
      path: "/api/profile/session/:id",
      method: "DELETE" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        const sessionId = c.req.param("id");
        try {
          await query("DELETE FROM profile_sessions WHERE session_id = $1", [sessionId]);
          logger?.info(`[profileBuilder] Deleted session ${sessionId}`);
          return c.json({ success: true });
        } catch (err: any) {
          logger?.error(`[profileBuilder] Delete error: ${err.message}`);
          return c.json({ error: err.message }, 500);
        }
      },
    },
  ];
}
