/**
 * Auto-Packet Generation
 *
 * Automatically generates application packets for jobs that the scoring
 * system recommends (above a configurable threshold). This runs in the
 * background after scoring completes.
 *
 * Trigger points:
 * 1. After the workflow's score-and-shortlist step
 * 2. After Excel/CSV import + scoring
 * 3. After the score-jobs endpoint is called
 * 4. Via the /api/dashboard/auto-generate-packets endpoint
 */

import { query, initDatabase } from "../mastra/tools/db";
import { extractJDRequirementsTool } from "../mastra/tools/extractJDRequirementsTool";
import { buildOutputTool } from "../mastra/tools/buildOutputTool";
import { runPipeline } from "./pipeline";

// ── Config ───────────────────────────────────────────────────────

const DEFAULT_MIN_SCORE = 60;
const DEFAULT_TOP_N = 20;
const DEFAULT_MAX_ATTEMPTS = 2;

interface AutoGenerateConfig {
  /** Minimum score to auto-generate (default: 60) */
  minScore?: number;
  /** Maximum number of jobs to process (default: 20) */
  topN?: number;
  /** Maximum LLM attempts per job (default: 2) */
  maxAttempts?: number;
  /** Mastra instance for logging */
  mastra?: any;
  /** Optional specific job IDs to process (overrides query) */
  jobIds?: number[];
}

interface AutoGenerateResult {
  queued: number;
  succeeded: number;
  failed: number;
  skipped: number;
  jobs: Array<{
    job_id: number;
    company: string;
    title: string;
    score: number;
    status: "success" | "failed" | "skipped";
    pass?: boolean;
    error?: string;
  }>;
}

/**
 * Find recommended jobs that don't yet have packets and generate them.
 *
 * This is designed to be called fire-and-forget from scoring endpoints
 * so it doesn't block the HTTP response.
 */
export async function autoGeneratePackets(config: AutoGenerateConfig = {}): Promise<AutoGenerateResult> {
  const logger = config.mastra?.getLogger();
  const minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  const topN = config.topN ?? DEFAULT_TOP_N;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  logger?.info(`🤖 [auto-gen] Starting auto-generation (minScore=${minScore}, topN=${topN})`);

  const result: AutoGenerateResult = {
    queued: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    jobs: [],
  };

  try {
    await initDatabase();

    // Find eligible jobs
    let candidates: any[];

    if (config.jobIds && config.jobIds.length > 0) {
      // Process specific job IDs
      const jobResult = await query(
        `SELECT j.job_id, j.company, j.title, j.jd_raw_text, s.total_score
         FROM jobs j
         INNER JOIN scores s ON j.job_id = s.job_id
         LEFT JOIN artifacts a ON j.job_id = a.job_id
         WHERE j.job_id = ANY($1)
           AND a.job_id IS NULL
           AND LENGTH(COALESCE(j.jd_raw_text, '')) >= 100
         ORDER BY s.total_score DESC`,
        [config.jobIds],
      );
      candidates = jobResult.rows;
    } else {
      // Find top scored jobs without packets
      const jobResult = await query(
        `SELECT j.job_id, j.company, j.title, j.jd_raw_text, s.total_score
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
      candidates = jobResult.rows;
    }

    result.queued = candidates.length;
    logger?.info(`🤖 [auto-gen] Found ${candidates.length} eligible jobs`);

    if (candidates.length === 0) return result;

    // Process each job sequentially
    for (const job of candidates) {
      try {
        logger?.info(`📦 [auto-gen] Processing ${job.company} — ${job.title} (score: ${job.total_score})`);

        // Ensure JD requirements are extracted
        const reqCheck = await query(
          "SELECT jd_requirements FROM jobs WHERE job_id = $1",
          [job.job_id],
        );
        if (!reqCheck.rows[0]?.jd_requirements) {
          logger?.info(`📋 [auto-gen] Extracting JD requirements for job_id=${job.job_id}`);
          await extractJDRequirementsTool.execute!({
            context: {
              job_id: job.job_id,
              jd_text: job.jd_raw_text,
              company: job.company,
              title: job.title,
            },
            mastra: config.mastra,
          } as any);
        }

        // Run the 7-stage pipeline
        const pipelineResult = await runPipeline({
          job_id: job.job_id,
          company: job.company,
          title: job.title,
          max_attempts: maxAttempts,
          logger,
        });

        // Build output files
        const resumePointers = (pipelineResult.resume?.evidence_pointers || []).map((p: any) => ({
          claim_text: p.claim_text,
          evidence_id: p.source_hash,
          evidence_quote: p.evidence_quote,
          evidence_source_key: p.source_hash,
          confidence: p.confidence,
        }));
        const clPointers = (pipelineResult.cover_letter?.evidence_pointers || []).map((p: any) => ({
          claim_text: p.claim_text,
          evidence_id: p.source_hash,
          evidence_quote: p.evidence_quote,
          evidence_source_key: p.source_hash,
          confidence: p.confidence,
        }));
        const allEvidence = [...resumePointers, ...clPointers];

        await buildOutputTool.execute!({
          context: {
            job_id: job.job_id,
            company: job.company,
            title: job.title,
            resume: pipelineResult.resume,
            cover_letter: pipelineResult.cover_letter,
            evidenceMap: allEvidence,
            verifierResult: pipelineResult.final_report,
            scoringBreakdown: {},
            totalScore: job.total_score,
            skip_pdf: false,
          },
          mastra: config.mastra,
        } as any);

        // Store plaintext resume if available
        if (pipelineResult.plaintext_resume) {
          try {
            await query(
              `UPDATE artifacts SET plaintext_resume = $1 WHERE job_id = $2`,
              [pipelineResult.plaintext_resume, job.job_id],
            );
          } catch { /* column may not exist yet — non-fatal */ }
        }

        // Store recruiter review report if available
        if (pipelineResult.recruiter_review) {
          try {
            await query(
              `UPDATE artifacts SET reviewer_json = $1 WHERE job_id = $2`,
              [JSON.stringify(pipelineResult.recruiter_review, null, 2), job.job_id],
            );
          } catch { /* column may not exist yet — non-fatal */ }
        }

        // Store clarification questions if any
        if (pipelineResult.clarification_questions?.length > 0) {
          try {
            await query(
              `UPDATE scores SET breakdown_json = jsonb_set(
                 COALESCE(breakdown_json, '{}'::jsonb),
                 '{clarification_questions}',
                 $2::jsonb
               ) WHERE job_id = $1`,
              [job.job_id, JSON.stringify(pipelineResult.clarification_questions)],
            );
          } catch { /* non-fatal */ }
        }

        // Update status
        const status = pipelineResult.pass ? "generated" : "generated-unverified";
        await query("UPDATE jobs SET status = $1 WHERE job_id = $2", [status, job.job_id]);

        result.succeeded++;
        result.jobs.push({
          job_id: job.job_id,
          company: job.company,
          title: job.title,
          score: job.total_score,
          status: "success",
          pass: pipelineResult.pass,
        });

        logger?.info(`✅ [auto-gen] ${job.company} — ${job.title}: done (pass=${pipelineResult.pass})`);

      } catch (err: any) {
        result.failed++;
        result.jobs.push({
          job_id: job.job_id,
          company: job.company,
          title: job.title,
          score: job.total_score,
          status: "failed",
          error: err.message,
        });
        logger?.error(`❌ [auto-gen] ${job.company} — ${job.title}: ${err.message}`);
      }
    }

    logger?.info(`🏁 [auto-gen] Complete: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`);

  } catch (err: any) {
    logger?.error(`💥 [auto-gen] Fatal error: ${err.message}`);
  }

  return result;
}

/**
 * Fire-and-forget auto-generation that runs in the background.
 * Safe to call from HTTP handlers — will not block the response.
 */
export function autoGenerateInBackground(config: AutoGenerateConfig = {}): void {
  const logger = config.mastra?.getLogger();
  autoGeneratePackets(config).catch(err => {
    logger?.error(`💥 [auto-gen-bg] Background generation failed: ${err.message}`);
  });
}
