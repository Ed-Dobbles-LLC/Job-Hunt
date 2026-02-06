import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from "docx";
import { query } from "./db";

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "_");
}

async function buildResumeDocx(
  resumeData: any,
  inventory: any,
): Promise<Buffer> {
  const profile = inventory.profile;

  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: profile.name, bold: true, size: 32, font: "Calibri" }),
      ],
      alignment: AlignmentType.CENTER,
    }),
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `${profile.email} | ${profile.phone} | ${profile.location} | ${profile.linkedin}`,
          size: 20,
          font: "Calibri",
        }),
      ],
      alignment: AlignmentType.CENTER,
    }),
  );
  children.push(new Paragraph({ text: "" }));

  children.push(
    new Paragraph({
      text: "PROFESSIONAL SUMMARY",
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: "PROFESSIONAL SUMMARY", bold: true, size: 24, font: "Calibri" })],
    }),
  );
  children.push(
    new Paragraph({
      children: [new TextRun({ text: resumeData.summary, size: 22, font: "Calibri" })],
    }),
  );
  children.push(new Paragraph({ text: "" }));

  children.push(
    new Paragraph({
      children: [new TextRun({ text: "EXPERIENCE", bold: true, size: 24, font: "Calibri" })],
    }),
  );

  for (const exp of resumeData.experience) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${exp.title} | ${exp.employer}`,
            bold: true,
            size: 22,
            font: "Calibri",
          }),
        ],
      }),
    );
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${exp.location} | ${exp.start_date} – ${exp.end_date}`,
            italics: true,
            size: 20,
            font: "Calibri",
          }),
        ],
      }),
    );
    for (const bullet of exp.bullets) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `• ${bullet}`, size: 22, font: "Calibri" })],
          indent: { left: 360 },
        }),
      );
    }
    children.push(new Paragraph({ text: "" }));
  }

  children.push(
    new Paragraph({
      children: [new TextRun({ text: "SKILLS", bold: true, size: 24, font: "Calibri" })],
    }),
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: resumeData.skills.join(" | "), size: 22, font: "Calibri" }),
      ],
    }),
  );
  children.push(new Paragraph({ text: "" }));

  children.push(
    new Paragraph({
      children: [new TextRun({ text: "EDUCATION", bold: true, size: 24, font: "Calibri" })],
    }),
  );
  for (const edu of resumeData.education) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${edu.degree} — ${edu.institution} (${edu.year})`,
            size: 22,
            font: "Calibri",
          }),
        ],
      }),
    );
  }

  if (resumeData.certifications && resumeData.certifications.length > 0) {
    children.push(new Paragraph({ text: "" }));
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "CERTIFICATIONS", bold: true, size: 24, font: "Calibri" }),
        ],
      }),
    );
    for (const cert of resumeData.certifications) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `• ${cert}`, size: 22, font: "Calibri" })],
          indent: { left: 360 },
        }),
      );
    }
  }

  const doc = new Document({
    sections: [{ children }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

async function buildCoverLetterDocx(
  coverLetterText: string,
  company: string,
  title: string,
  inventory: any,
): Promise<Buffer> {
  const profile = inventory.profile;
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const paragraphs = coverLetterText
    .split("\n")
    .filter((p) => p.trim())
    .map(
      (p) =>
        new Paragraph({
          children: [new TextRun({ text: p.trim(), size: 22, font: "Calibri" })],
          spacing: { after: 200 },
        }),
    );

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: profile.name, bold: true, size: 24, font: "Calibri" }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `${profile.email} | ${profile.phone} | ${profile.location}`,
                size: 20,
                font: "Calibri",
              }),
            ],
          }),
          new Paragraph({ text: "" }),
          new Paragraph({
            children: [new TextRun({ text: today, size: 22, font: "Calibri" })],
          }),
          new Paragraph({ text: "" }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Re: ${title} at ${company}`,
                bold: true,
                size: 22,
                font: "Calibri",
              }),
            ],
          }),
          new Paragraph({ text: "" }),
          ...paragraphs,
        ],
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export const buildOutputTool = createTool({
  id: "build-output",
  description:
    "Builds the output folder structure with DOCX files (resume, cover letter), evidence map JSON, verifier JSON, and job details JSON for a single job.",
  inputSchema: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    resumeData: z.object({}).passthrough(),
    coverLetterText: z.string(),
    evidenceMap: z.array(z.object({
      claim_text: z.string(),
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
  }),
  outputSchema: z.object({
    success: z.boolean(),
    outputDir: z.string(),
    files: z.array(z.string()),
    truthPass: z.boolean(),
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

    const inventoryPath = workspacePath("experience_inventory.json");
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));

    const files: string[] = [];
    const truthPass = context.verifierResult?.overallPass ?? false;

    const resumeBuffer = await buildResumeDocx(context.resumeData, inventory);
    const resumePath = path.join(
      outputDir,
      `Resume_${companySafe}_${titleSafe}.docx`,
    );
    fs.writeFileSync(resumePath, resumeBuffer);
    files.push(resumePath);
    logger?.info(`📄 [buildOutput] Resume DOCX written`);

    const coverBuffer = await buildCoverLetterDocx(
      context.coverLetterText,
      context.company,
      context.title,
      inventory,
    );
    const coverPath = path.join(
      outputDir,
      `CoverLetter_${companySafe}_${titleSafe}.docx`,
    );
    fs.writeFileSync(coverPath, coverBuffer);
    files.push(coverPath);
    logger?.info(`📝 [buildOutput] Cover letter DOCX written`);

    const evidenceMapPath = path.join(
      outputDir,
      `EvidenceMap_${companySafe}_${titleSafe}.json`,
    );
    fs.writeFileSync(
      evidenceMapPath,
      JSON.stringify(context.evidenceMap, null, 2),
    );
    files.push(evidenceMapPath);

    const verifierPath = path.join(
      outputDir,
      `Verifier_${companySafe}_${titleSafe}.json`,
    );
    fs.writeFileSync(
      verifierPath,
      JSON.stringify(context.verifierResult, null, 2),
    );
    files.push(verifierPath);

    const jobPath = path.join(
      outputDir,
      `Job_${companySafe}_${titleSafe}.json`,
    );
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
        },
        null,
        2,
      ),
    );
    files.push(jobPath);

    const jobLookup = await query(
      `SELECT job_id FROM jobs WHERE company = $1 AND title = $2 ORDER BY job_id DESC LIMIT 1`,
      [context.company, context.title],
    );
    const actualJobId = jobLookup.rows?.[0]?.job_id || context.job_id;
    logger?.info(`🔍 [buildOutput] Resolved job_id: ${actualJobId} (input was ${context.job_id})`);

    await query(
      `INSERT INTO artifacts (job_id, resume_docx_path, cover_docx_path, evidence_map_path, verifier_json_path, prompt_version, model_used, truth_pass)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        actualJobId,
        resumePath,
        coverPath,
        evidenceMapPath,
        verifierPath,
        "v1",
        "gpt-5",
        truthPass,
      ],
    );

    for (const evidence of context.evidenceMap) {
      await query(
        `INSERT INTO evidence_map (job_id, claim_id, claim_text, evidence_quote, evidence_source_key, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          actualJobId,
          evidence.claim_text?.substring(0, 20),
          evidence.claim_text,
          evidence.evidence_quote,
          evidence.evidence_source_key,
          evidence.confidence,
        ],
      );
    }

    if (context.contactTargets) {
      for (let i = 0; i < context.contactTargets.length; i++) {
        const ct = context.contactTargets[i];
        await query(
          `INSERT INTO contacts (job_id, person_name, title, rank, rationale, message_draft)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            actualJobId,
            "NONE FOUND",
            ct.title,
            i + 1,
            ct.rationale,
            ct.message_draft || "",
          ],
        );
      }
    }

    logger?.info(
      `✅ [buildOutput] Output complete: ${files.length} files, truth_pass: ${truthPass}`,
    );

    return {
      success: true,
      outputDir,
      files,
      truthPass,
    };
  },
});
