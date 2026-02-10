import * as fs from "fs";
import * as crypto from "crypto";
import { query } from "./tools/db";
import { workspacePath, findPublicFile } from "./tools/paths";
import { parseResumeBuffer } from "./tools/resumeParserTool";
import { structureResume } from "./tools/resumeStructurerTool";
import {
  generateInterviewQuestions,
  processAnswers,
} from "./tools/profileInterviewTool";
import type { ExperienceInventory, Gap } from "./tools/profileSchemas";

const MAX_INTERVIEW_ROUNDS = 4;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function getProfileBuilderRoutes() {
  return [
    /* ── Debug: show what paths the server is trying ────────────── */
    {
      path: "/api/profile/debug-paths",
      method: "GET" as const,
      createHandler: async () => async (c: any) => {
        const path = await import("path");
        const candidates = [
          { label: "__dirname", value: __dirname },
          { label: "process.cwd()", value: process.cwd() },
          { label: "WORKSPACE_ROOT", value: workspacePath() },
          { label: "__dirname/public/profile.html", value: path.join(__dirname, "public", "profile.html"), exists: fs.existsSync(path.join(__dirname, "public", "profile.html")) },
          { label: "workspacePath(src/mastra/public/profile.html)", value: workspacePath("src", "mastra", "public", "profile.html"), exists: fs.existsSync(workspacePath("src", "mastra", "public", "profile.html")) },
          { label: "cwd/src/mastra/public/profile.html", value: path.join(process.cwd(), "src", "mastra", "public", "profile.html"), exists: fs.existsSync(path.join(process.cwd(), "src", "mastra", "public", "profile.html")) },
        ];
        return c.json({ candidates });
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

    /* ── Upload resume & kick off parsing ───────────────────────── */
    {
      path: "/api/profile/upload",
      method: "POST" as const,
      createHandler: async ({ mastra }: any) => async (c: any) => {
        const logger = mastra.getLogger();
        logger?.info("[profileBuilder] Upload request received");

        try {
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

          logger?.info(`[profileBuilder] Parsing resume: ${fileName} (${buffer.length} bytes)`);

          // 1. Extract raw text
          const { rawText, format } = await parseResumeBuffer(buffer, fileName);
          if (!rawText || rawText.trim().length < 50) {
            return c.json({ error: "Could not extract meaningful text from the uploaded file. Please try a different format." }, 400);
          }

          logger?.info(`[profileBuilder] Extracted ${rawText.length} chars as ${format}`);

          // 2. Structure with LLM
          logger?.info("[profileBuilder] Structuring resume with LLM...");
          const { draft, gaps } = await structureResume(rawText);

          // 3. Generate first round of questions
          const questions = await generateInterviewQuestions(draft, gaps, []);

          // 4. Save session to DB
          await query(
            `INSERT INTO profile_sessions (session_id, status, raw_resume_text, resume_filename, resume_format, current_draft, gaps, qa_history, interview_round)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, 1)`,
            [
              sessionId,
              "interviewing",
              rawText,
              fileName,
              format,
              JSON.stringify(draft),
              JSON.stringify(gaps),
            ],
          );

          logger?.info(`[profileBuilder] Session ${sessionId} created with ${gaps.length} gaps`);

          return c.json({
            sessionId,
            status: "interviewing",
            draft,
            gaps,
            questions,
            interviewRound: 1,
          });
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
            qaHistory: row.qa_history,
            interviewRound: row.interview_round,
            resumeFilename: row.resume_filename,
            createdAt: row.created_at,
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
          if (answers.length === 0) {
            return c.json({ error: "No answers provided" }, 400);
          }

          const draft: ExperienceInventory = session.current_draft;
          const gaps: Gap[] = session.gaps;
          const qaHistory: Array<{ questionId: string; question: string; answer: string }> = session.qa_history || [];
          const round = session.interview_round || 1;

          logger?.info(`[profileBuilder] Processing ${answers.length} answers for session ${sessionId} (round ${round})`);

          // Process answers
          const { updatedDraft, remainingGaps, isComplete } = await processAnswers(draft, gaps, answers);

          // Update Q&A history
          const updatedQA = [...qaHistory, ...answers];
          const nextRound = round + 1;
          let nextQuestions: any[] = [];
          let newStatus = "interviewing";

          if (isComplete || nextRound > MAX_INTERVIEW_ROUNDS) {
            newStatus = "review";
            logger?.info(`[profileBuilder] Interview complete for session ${sessionId}`);
          } else {
            // Generate next round of questions
            const qaForLLM = updatedQA.map((qa) => ({ question: qa.question, answer: qa.answer }));
            nextQuestions = await generateInterviewQuestions(updatedDraft, remainingGaps, qaForLLM);
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

          // Backup existing inventory
          const inventoryPath = workspacePath("experience_inventory.json");
          if (fs.existsSync(inventoryPath)) {
            const backupPath = workspacePath("experience_inventory.backup.json");
            fs.copyFileSync(inventoryPath, backupPath);
            logger?.info(`[profileBuilder] Backed up existing inventory to ${backupPath}`);
          }

          // Write the new inventory
          fs.writeFileSync(inventoryPath, JSON.stringify(finalDraft, null, 2), "utf-8");
          logger?.info(`[profileBuilder] Wrote experience_inventory.json for ${finalDraft.profile.name}`);

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
