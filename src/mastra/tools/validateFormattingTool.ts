import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import { workspacePath } from "./paths";
import { TailoredResumeSchema } from "./tailoredResumePrompt";
import { TailoredCoverLetterSchema } from "./tailoredCoverLetterPrompt";
import {
  renderResumeDocx,
  renderCoverLetterDocx,
} from "./docxRenderer";
import {
  validatePacketFormatting,
  type CombinedFormattingReport,
} from "./formattingValidator";

function loadProfile(): Record<string, any> {
  const inventoryPath = workspacePath("experience_inventory.json");
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  return inventory.profile || {};
}

export const validateFormattingTool = createTool({
  id: "validate-formatting",
  description:
    "Pre-PDF formatting validator that checks rendered DOCX documents for duplicate headings, placeholders/template artifacts, page count limits, missing contact info, and broken links. Returns a pass/fail report and blocks sending if critical violations exist. Should be called after document generation and before sending/publishing.",
  inputSchema: z.object({
    resume: TailoredResumeSchema.describe("TailoredResume JSON to render and validate"),
    cover_letter: TailoredCoverLetterSchema.describe("TailoredCoverLetter JSON to render and validate"),
    resume_page_count: z.number().optional().describe("Page count from PDF conversion (if available)"),
    cover_letter_page_count: z.number().optional().describe("Page count from PDF conversion (if available)"),
  }),
  outputSchema: z.object({
    pass: z.boolean(),
    blockSending: z.boolean(),
    totalChecks: z.number(),
    totalCritical: z.number(),
    totalWarnings: z.number(),
    totalViolations: z.number(),
    resumePass: z.boolean(),
    coverLetterPass: z.boolean(),
    violations: z.array(z.object({
      check: z.string(),
      severity: z.string(),
      message: z.string(),
      location: z.string(),
      documentType: z.string(),
    })),
    timestamp: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(`🔍 [validateFormatting] Starting pre-PDF formatting validation`);

    const rawProfile = loadProfile();
    const profile = {
      name: rawProfile.name || "Unknown",
      email: (rawProfile.email || "Ed@Dobbles.AI") as string | undefined,
      phone: rawProfile.phone as string | undefined,
      location: rawProfile.location as string | undefined,
      linkedin: rawProfile.linkedin as string | undefined,
    };
    logger?.info(`🔍 [validateFormatting] Profile: ${profile.name}`);

    logger?.info(`📄 [validateFormatting] Rendering resume DOCX for validation...`);
    const resumeBuffer = await renderResumeDocx(context.resume, profile);
    logger?.info(`📄 [validateFormatting] Resume DOCX rendered (${resumeBuffer.length} bytes)`);

    logger?.info(`📝 [validateFormatting] Rendering cover letter DOCX for validation...`);
    const coverLetterBuffer = await renderCoverLetterDocx(context.cover_letter, profile);
    logger?.info(`📝 [validateFormatting] Cover letter DOCX rendered (${coverLetterBuffer.length} bytes)`);

    logger?.info(`🔍 [validateFormatting] Running formatting checks...`);
    const report = await validatePacketFormatting(
      resumeBuffer,
      coverLetterBuffer,
      profile,
      context.resume_page_count,
      context.cover_letter_page_count,
    );

    const allViolations = [
      ...report.resumeReport.violations.map((v) => ({ ...v, documentType: "resume" })),
      ...report.coverLetterReport.violations.map((v) => ({ ...v, documentType: "cover_letter" })),
    ];

    logger?.info(`📊 [validateFormatting] Results: pass=${report.pass}, critical=${report.totalCritical}, warnings=${report.totalWarnings}`);

    if (report.totalCritical > 0) {
      logger?.warn(`🚫 [validateFormatting] BLOCKED: ${report.totalCritical} critical violation(s) found`);
      for (const v of allViolations.filter((v) => v.severity === "critical")) {
        logger?.warn(`  ❌ [${v.documentType}] ${v.check}: ${v.message}`);
      }
    }

    if (report.totalWarnings > 0) {
      for (const v of allViolations.filter((v) => v.severity === "warning")) {
        logger?.info(`  ⚠️ [${v.documentType}] ${v.check}: ${v.message}`);
      }
    }

    if (report.pass) {
      logger?.info(`✅ [validateFormatting] All checks passed – documents are ready`);
    }

    return {
      pass: report.pass,
      blockSending: report.blockSending,
      totalChecks: report.totalChecks,
      totalCritical: report.totalCritical,
      totalWarnings: report.totalWarnings,
      totalViolations: report.totalViolations,
      resumePass: report.resumeReport.pass,
      coverLetterPass: report.coverLetterReport.pass,
      violations: allViolations,
      timestamp: report.timestamp,
    };
  },
});
