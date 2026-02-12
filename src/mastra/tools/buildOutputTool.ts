import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { workspacePath, WORKSPACE_ROOT } from "./paths";
import { query } from "./db";
import { TailoredResumeSchema } from "./tailoredResumePrompt";
import { TailoredCoverLetterSchema } from "./tailoredCoverLetterPrompt";
import {
  renderResumeDocx,
  renderCoverLetterDocx,
  convertDocxToPdf,
  checkPagination,
} from "./docxRenderer";

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "_");
}

function loadInventory(): Record<string, any> {
  try {
    const inventoryPath = workspacePath("experience_inventory.json");
    return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  } catch (err: any) {
    console.error(`[buildOutput] Failed to load inventory: ${err.message}`);
    return { profile: { name: "Candidate" }, experience: [], education: [], skills: {}, certifications: [] };
  }
}

export const buildOutputTool = createTool({
  id: "build-output",
  description:
    "Builds the output folder structure with DOCX + PDF files (resume, cover letter), evidence map JSON, verifier JSON, and job details JSON. Uses deterministic DOCX templates with professional formatting, then converts to PDF via LibreOffice with pagination checks (1-2 pages max for resume, 1 page for cover letter).",
  inputSchema: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    resume: TailoredResumeSchema.describe("TailoredResume JSON from generate-verified-packet"),
    cover_letter: TailoredCoverLetterSchema.describe("TailoredCoverLetter JSON from generate-verified-packet"),
    evidenceMap: z.array(z.object({
      claim_text: z.string(),
      evidence_id: z.string().optional(),
      evidence_quote: z.string(),
      evidence_source_key: z.string(),
      confidence: z.number(),
    })),
    verifierResult: z.object({}).passthrough(),
    contactTargets: z.array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        message_draft: z.string().optional(),
      }),
    ).optional(),
    scoringBreakdown: z.record(z.string(), z.number()).optional(),
    totalScore: z.number().optional(),
    skip_pdf: z.boolean().optional().describe("Skip PDF conversion (default false)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    outputDir: z.string(),
    files: z.array(z.string()),
    truthPass: z.boolean(),
    resume_pagination: z.object({
      pageCount: z.number(),
      withinLimit: z.boolean(),
      maxPages: z.number(),
      warning: z.string().nullable(),
    }).optional(),
    cover_letter_pagination: z.object({
      pageCount: z.number(),
      withinLimit: z.boolean(),
      maxPages: z.number(),
      warning: z.string().nullable(),
    }).optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const today = new Date().toISOString().split("T")[0];
    const companySafe = sanitizeName(context.company);
    const titleSafe = sanitizeName(context.title);
    const outputDir = workspacePath(
      `output/${today}/${companySafe}/${titleSafe}`,
    );

    logger?.info(`📁 [buildOutput] Creating output at: ${outputDir}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const inventory = loadInventory();
    const profile = inventory.profile || {};
    const files: string[] = [];
    const vr = context.verifierResult as Record<string, unknown>;
    const truthPass = Boolean(vr?.pass ?? vr?.overallPass ?? false);

    logger?.info(`📄 [buildOutput] Rendering resume DOCX from TailoredResume JSON...`);
    const expEntries = context.resume?.experience || [];
    const totalBullets = expEntries.reduce((s: number, e: any) => s + (e?.bullets?.length || 0), 0);
    logger?.info(`📄 [buildOutput] Resume has ${expEntries.length} experience entries, ${totalBullets} bullets`);
    const resumeBuffer = await renderResumeDocx(context.resume, profile);
    const resumeDocxPath = path.join(outputDir, `Resume_${companySafe}_${titleSafe}.docx`);
    fs.writeFileSync(resumeDocxPath, resumeBuffer);
    files.push(resumeDocxPath);
    logger?.info(`✅ [buildOutput] Resume DOCX written: ${resumeDocxPath}`);

    logger?.info(`📝 [buildOutput] Rendering cover letter DOCX from TailoredCoverLetter JSON...`);
    logger?.info(`📝 [buildOutput] Cover letter: ${context.cover_letter?.word_count || 0} words, ${context.cover_letter?.value_claims?.length || 0} value claims`);
    const coverBuffer = await renderCoverLetterDocx(context.cover_letter, profile);
    const coverDocxPath = path.join(outputDir, `CoverLetter_${companySafe}_${titleSafe}.docx`);
    fs.writeFileSync(coverDocxPath, coverBuffer);
    files.push(coverDocxPath);
    logger?.info(`✅ [buildOutput] Cover letter DOCX written: ${coverDocxPath}`);

    let resumePagination;
    let coverLetterPagination;

    if (!context.skip_pdf) {
      logger?.info(`📄 [buildOutput] Converting resume DOCX → PDF via LibreOffice...`);
      try {
        const resumePdf = await convertDocxToPdf(resumeDocxPath, outputDir);
        files.push(resumePdf.pdfPath);
        resumePagination = checkPagination(resumePdf.pageCount, 2);
        logger?.info(`✅ [buildOutput] Resume PDF: ${resumePdf.pdfPath} (${resumePdf.pageCount} page(s))`);
        if (resumePagination.warning) {
          logger?.warn(`⚠️ [buildOutput] Resume pagination: ${resumePagination.warning}`);
        }
      } catch (err: any) {
        logger?.error(`⚠️ [buildOutput] Resume PDF conversion failed: ${err.message}`);
      }

      logger?.info(`📝 [buildOutput] Converting cover letter DOCX → PDF via LibreOffice...`);
      try {
        const coverPdf = await convertDocxToPdf(coverDocxPath, outputDir);
        files.push(coverPdf.pdfPath);
        coverLetterPagination = checkPagination(coverPdf.pageCount, 1);
        logger?.info(`✅ [buildOutput] Cover letter PDF: ${coverPdf.pdfPath} (${coverPdf.pageCount} page(s))`);
        if (coverLetterPagination.warning) {
          logger?.warn(`⚠️ [buildOutput] Cover letter pagination: ${coverLetterPagination.warning}`);
        }
      } catch (err: any) {
        logger?.error(`⚠️ [buildOutput] Cover letter PDF conversion failed: ${err.message}`);
      }
    } else {
      logger?.info(`⏩ [buildOutput] Skipping PDF conversion (skip_pdf=true)`);
    }

    const evidenceMapPath = path.join(outputDir, `EvidenceMap_${companySafe}_${titleSafe}.json`);
    fs.writeFileSync(evidenceMapPath, JSON.stringify(context.evidenceMap, null, 2));
    files.push(evidenceMapPath);

    const verifierPath = path.join(outputDir, `Verifier_${companySafe}_${titleSafe}.json`);
    fs.writeFileSync(verifierPath, JSON.stringify(context.verifierResult, null, 2));
    files.push(verifierPath);

    const jobPath = path.join(outputDir, `Job_${companySafe}_${titleSafe}.json`);
    fs.writeFileSync(
      jobPath,
      JSON.stringify(
        {
          job_id: context.job_id,
          company: context.company,
          title: context.title,
          total_score: context.totalScore,
          scoring_breakdown: context.scoringBreakdown,
          contacts: context.contactTargets || [],
          truth_pass: truthPass,
          resume_pagination: resumePagination || null,
          cover_letter_pagination: coverLetterPagination || null,
        },
        null,
        2,
      ),
    );
    files.push(jobPath);

    const actualJobId = Number(context.job_id);
    logger?.info(`🔍 [buildOutput] Using job_id: ${actualJobId}`);

    // Store relative paths in DB so they work across environments (dev vs Railway)
    const toRelative = (p: string) => path.relative(WORKSPACE_ROOT, p);

    // Delete any existing artifact for this job before inserting (avoid duplicates)
    await query(`DELETE FROM artifacts WHERE job_id = $1`, [actualJobId]);

    await query(
      `INSERT INTO artifacts (job_id, resume_docx_path, cover_docx_path, evidence_map_path, verifier_json_path, prompt_version, model_used, truth_pass)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        actualJobId,
        toRelative(resumeDocxPath),
        toRelative(coverDocxPath),
        toRelative(evidenceMapPath),
        toRelative(verifierPath),
        "v2",
        "gpt-4o",
        truthPass,
      ],
    );
    logger?.info(`💾 [buildOutput] Artifact record saved to DB for job_id=${actualJobId}`);

    for (const evidence of context.evidenceMap) {
      try {
        await query(
          `INSERT INTO evidence_map (job_id, claim_id, claim_text, evidence_quote, evidence_source_key, confidence)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            actualJobId,
            evidence.evidence_id || evidence.claim_text?.substring(0, 20),
            evidence.claim_text,
            evidence.evidence_quote,
            evidence.evidence_source_key,
            evidence.confidence,
          ],
        );
      } catch (err: any) {
        logger?.error(`⚠️ [buildOutput] Failed to save evidence: ${err.message}`);
      }
    }

    if (context.contactTargets) {
      for (let i = 0; i < context.contactTargets.length; i++) {
        const ct = context.contactTargets[i];
        try {
          await query(
            `INSERT INTO contacts (job_id, person_name, title, rank, rationale, message_draft)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [actualJobId, "NONE FOUND", ct.title, i + 1, ct.rationale, ct.message_draft || ""],
          );
        } catch (err: any) {
          logger?.error(`⚠️ [buildOutput] Failed to save contact: ${err.message}`);
        }
      }
    }

    logger?.info(`\n✅ [buildOutput] Output complete: ${files.length} files, truth_pass: ${truthPass}`);
    if (resumePagination) {
      logger?.info(`📊 [buildOutput] Resume: ${resumePagination.pageCount} page(s), within limit: ${resumePagination.withinLimit}`);
    }
    if (coverLetterPagination) {
      logger?.info(`📊 [buildOutput] Cover letter: ${coverLetterPagination.pageCount} page(s), within limit: ${coverLetterPagination.withinLimit}`);
    }

    return {
      success: true,
      outputDir,
      files,
      truthPass,
      resume_pagination: resumePagination,
      cover_letter_pagination: coverLetterPagination,
    };
  },
});
