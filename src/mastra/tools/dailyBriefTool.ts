import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";
import { query } from "./db";

const OutreachTargetBriefSchema = z.object({
  person_name: z.string(),
  title: z.string(),
  role_category: z.string(),
  confidence: z.number(),
  outreach_angle: z.string(),
  linkedin_search_query: z.string(),
  message_warm: z.string().optional(),
  message_cold: z.string().optional(),
});

const FilePaths = z.object({
  resume_docx: z.string().optional(),
  resume_pdf: z.string().optional(),
  cover_letter_docx: z.string().optional(),
  cover_letter_pdf: z.string().optional(),
  evidence_map: z.string().optional(),
  verifier_report: z.string().optional(),
  job_report: z.string().optional(),
});

const QuestionForEdSchema = z.object({
  category: z.enum([
    "missing_company_info",
    "ambiguous_requirement",
    "salary_unknown",
    "contact_not_found",
    "gap_in_experience",
    "application_decision",
    "other",
  ]),
  question: z.string(),
  context: z.string(),
  job_id: z.number(),
  company: z.string(),
  priority: z.enum(["high", "medium", "low"]),
});

const DailyBriefJobSchema = z.object({
  rank: z.number(),
  job_id: z.number(),
  company: z.string(),
  title: z.string(),
  location: z.string().optional(),
  posting_url: z.string().optional(),
  score: z.number(),
  score_breakdown: z.record(z.string(), z.number()).optional(),
  role_shape: z.string().optional(),
  truth_pass: z.boolean(),
  top_skills: z.array(z.string()),
  gap_notes: z.array(z.string()),
  file_paths: FilePaths,
  outreach_targets: z.array(OutreachTargetBriefSchema),
  salary_range: z.string().optional(),
});

export const DailyBriefSchema = z.object({
  date: z.string(),
  generated_at: z.string(),
  storage_root: z.string(),
  summary: z.object({
    jobs_fetched: z.number(),
    jobs_scored: z.number(),
    jobs_shortlisted: z.number(),
    packets_generated: z.number(),
    truth_pass_count: z.number(),
    truth_fail_count: z.number(),
    top_score: z.number(),
    avg_score: z.number(),
  }),
  top_matches: z.array(DailyBriefJobSchema),
  questions_for_ed: z.array(QuestionForEdSchema),
  model_used: z.string(),
  prompt_version: z.string(),
});

export type DailyBrief = z.infer<typeof DailyBriefSchema>;
export type DailyBriefJob = z.infer<typeof DailyBriefJobSchema>;
export type QuestionForEd = z.infer<typeof QuestionForEdSchema>;

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "_");
}

export function buildStoragePath(date: string, company: string, role: string): string {
  const companySafe = sanitizeName(company);
  const roleSafe = sanitizeName(role);
  return `output/${date}/${companySafe}/${roleSafe}`;
}

export function discoverFilePaths(
  date: string,
  company: string,
  title: string,
): z.infer<typeof FilePaths> {
  const storageDir = workspacePath(buildStoragePath(date, company, title));
  const companySafe = sanitizeName(company);
  const titleSafe = sanitizeName(title);
  const result: z.infer<typeof FilePaths> = {};

  const candidates = [
    { key: "resume_docx" as const, pattern: `Resume_${companySafe}_${titleSafe}.docx` },
    { key: "resume_pdf" as const, pattern: `Resume_${companySafe}_${titleSafe}.pdf` },
    { key: "cover_letter_docx" as const, pattern: `CoverLetter_${companySafe}_${titleSafe}.docx` },
    { key: "cover_letter_pdf" as const, pattern: `CoverLetter_${companySafe}_${titleSafe}.pdf` },
    { key: "evidence_map" as const, pattern: `EvidenceMap_${companySafe}_${titleSafe}.json` },
    { key: "verifier_report" as const, pattern: `Verifier_${companySafe}_${titleSafe}.json` },
    { key: "job_report" as const, pattern: `Job_${companySafe}_${titleSafe}.json` },
  ];

  for (const { key, pattern } of candidates) {
    const filePath = path.join(storageDir, pattern);
    if (fs.existsSync(filePath)) {
      result[key] = filePath;
    }
  }

  return result;
}

export function generateQuestionsForEd(
  jobId: number,
  company: string,
  title: string,
  matchReport: Record<string, any> | null,
  requirements: Record<string, any> | null,
  contacts: any[],
  truthPass: boolean | null,
): QuestionForEd[] {
  const questions: QuestionForEd[] = [];

  if (matchReport?.gap_notes?.length) {
    for (const gap of matchReport.gap_notes.slice(0, 2)) {
      questions.push({
        category: "gap_in_experience",
        question: `Should we address this gap in the application, or is it acceptable to proceed without it?`,
        context: `Gap identified: ${gap}`,
        job_id: jobId,
        company,
        priority: "medium",
      });
    }
  }

  const hasNoContacts = contacts.length === 0 || contacts.every(
    (c) => !c.person_name || c.person_name === "NONE FOUND",
  );
  if (hasNoContacts) {
    questions.push({
      category: "contact_not_found",
      question: `No outreach contacts found for ${company}. Do you know anyone there, or should we skip outreach?`,
      context: `Role: ${title}. Web search found no named contacts at this company.`,
      job_id: jobId,
      company,
      priority: "high",
    });
  }

  if (!matchReport?.salary_range) {
    questions.push({
      category: "salary_unknown",
      question: `Salary not listed for this role. What's your minimum acceptable compensation?`,
      context: `Role: ${title} at ${company}. No salary information found in posting or enrichment.`,
      job_id: jobId,
      company,
      priority: "low",
    });
  }

  if (requirements?.red_flags?.length) {
    const flags = requirements.red_flags
      .filter((f: any) => (f.confidence ?? 1) >= 0.7)
      .slice(0, 2);
    for (const flag of flags) {
      const flagText = typeof flag === "string" ? flag : flag.text;
      questions.push({
        category: "application_decision",
        question: `This role has a potential concern. Should we still proceed with the application?`,
        context: `Red flag: ${flagText}`,
        job_id: jobId,
        company,
        priority: "high",
      });
    }
  }

  if (truthPass === false) {
    questions.push({
      category: "other",
      question: `The application packet failed truthfulness verification. Should we regenerate it or proceed with manual review?`,
      context: `Automated verification found issues with the generated resume/cover letter for ${title} at ${company}.`,
      job_id: jobId,
      company,
      priority: "high",
    });
  }

  return questions;
}

export const assembleDailyBriefTool = createTool({
  id: "assemble-daily-brief",
  description:
    "Assembles the complete DailyBrief JSON by aggregating today's job matches, scores, file paths (in /YYYY-MM-DD/company_role/ layout), outreach targets, LinkedIn messages, and Questions for Ed. Saves the brief to disk and returns the full structured data for email/Notion/Slack delivery.",
  inputSchema: z.object({
    dateOverride: z
      .string()
      .optional()
      .describe("Override date (YYYY-MM-DD format). Defaults to today."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    brief: DailyBriefSchema.optional(),
    briefPath: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const today = context.dateOverride || new Date().toISOString().split("T")[0];

    logger?.info(`📋 [assembleDailyBrief] Starting brief assembly for ${today}`);

    try {
      const fetchedResult = await query(
        `SELECT COUNT(*) as count FROM jobs WHERE date_ingested::date = $1`,
        [today],
      );
      const jobsFetched = parseInt(fetchedResult.rows[0]?.count || "0");

      const scoredResult = await query(
        `SELECT COUNT(*) as count FROM scores s
         JOIN jobs j ON s.job_id = j.job_id
         WHERE j.date_ingested::date = $1`,
        [today],
      );
      const jobsScored = parseInt(scoredResult.rows[0]?.count || "0");

      logger?.info(
        `📊 [assembleDailyBrief] Found ${jobsFetched} fetched, ${jobsScored} scored jobs`,
      );

      const jobsResult = await query(
        `SELECT j.job_id, j.company, j.title, j.posting_url, j.location,
                j.jd_requirements,
                s.total_score, s.breakdown_json, s.match_report,
                a.truth_pass, a.resume_docx_path, a.cover_docx_path,
                a.evidence_map_path, a.verifier_json_path
         FROM jobs j
         JOIN scores s ON j.job_id = s.job_id
         LEFT JOIN artifacts a ON j.job_id = a.job_id
         WHERE j.date_ingested::date = $1
         ORDER BY s.total_score DESC`,
        [today],
      );

      const topMatches: DailyBriefJob[] = [];
      const allQuestions: QuestionForEd[] = [];
      let truthPassCount = 0;
      let truthFailCount = 0;
      let packetsGenerated = 0;
      let totalScore = 0;
      let topScore = 0;

      for (let i = 0; i < jobsResult.rows.length; i++) {
        const row = jobsResult.rows[i];
        const score = row.total_score || 0;
        totalScore += score;
        if (score > topScore) topScore = score;

        const matchReport =
          typeof row.match_report === "string"
            ? JSON.parse(row.match_report)
            : row.match_report || {};

        const breakdown =
          typeof row.breakdown_json === "string"
            ? JSON.parse(row.breakdown_json)
            : row.breakdown_json || {};

        const requirements =
          typeof row.jd_requirements === "string"
            ? JSON.parse(row.jd_requirements)
            : row.jd_requirements || {};

        if (row.truth_pass !== null && row.truth_pass !== undefined) {
          packetsGenerated++;
          if (row.truth_pass) truthPassCount++;
          else truthFailCount++;
        }

        let topSkills: string[] = [];
        if (matchReport.top_matching_skills) {
          topSkills = matchReport.top_matching_skills.slice(0, 5);
        } else if (breakdown.skill_match_details) {
          topSkills = Object.keys(breakdown.skill_match_details).slice(0, 5);
        }

        let gapNotes: string[] = [];
        if (matchReport.gap_notes) {
          gapNotes = matchReport.gap_notes.slice(0, 5);
        } else if (breakdown.gap_notes) {
          gapNotes = breakdown.gap_notes.slice(0, 5);
        }

        const filePaths = discoverFilePaths(today, row.company || "", row.title || "");

        const contactsResult = await query(
          `SELECT person_name, title, rank, rationale, message_draft, linkedin_url
           FROM contacts WHERE job_id = $1 ORDER BY rank ASC`,
          [row.job_id],
        );

        const outreachTargets = contactsResult.rows.map((c: any) => {
          let warmMsg = "";
          let coldMsg = "";
          if (c.message_draft) {
            try {
              const parsed = JSON.parse(c.message_draft);
              warmMsg = parsed.warm?.text || "";
              coldMsg = parsed.cold?.text || "";
            } catch {
              warmMsg = c.message_draft;
            }
          }

          return {
            person_name: c.person_name || "",
            title: c.title || "",
            role_category: "unknown",
            confidence: 0.5,
            outreach_angle: c.rationale || "",
            linkedin_search_query: c.linkedin_url || "",
            message_warm: warmMsg || undefined,
            message_cold: coldMsg || undefined,
          };
        });

        const jobQuestions = generateQuestionsForEd(
          row.job_id,
          row.company || "",
          row.title || "",
          matchReport,
          requirements,
          contactsResult.rows,
          row.truth_pass,
        );
        allQuestions.push(...jobQuestions);

        topMatches.push({
          rank: i + 1,
          job_id: row.job_id,
          company: row.company || "Unknown",
          title: row.title || "Unknown",
          location: row.location || undefined,
          posting_url: row.posting_url || undefined,
          score,
          score_breakdown: breakdown || undefined,
          role_shape: matchReport.role_shape || breakdown.role_shape || undefined,
          truth_pass: row.truth_pass ?? false,
          top_skills: topSkills,
          gap_notes: gapNotes,
          file_paths: filePaths,
          outreach_targets: outreachTargets,
          salary_range: matchReport.salary_range || breakdown.salary_range || undefined,
        });
      }

      const avgScore =
        jobsResult.rows.length > 0
          ? Math.round((totalScore / jobsResult.rows.length) * 10) / 10
          : 0;

      const brief: DailyBrief = {
        date: today,
        generated_at: new Date().toISOString(),
        storage_root: workspacePath(`output/${today}`),
        summary: {
          jobs_fetched: jobsFetched,
          jobs_scored: jobsScored,
          jobs_shortlisted: jobsResult.rows.length,
          packets_generated: packetsGenerated,
          truth_pass_count: truthPassCount,
          truth_fail_count: truthFailCount,
          top_score: topScore,
          avg_score: avgScore,
        },
        top_matches: topMatches,
        questions_for_ed: allQuestions,
        model_used: "gpt-4o",
        prompt_version: "v2",
      };

      const briefDir = workspacePath(`output/${today}`);
      fs.mkdirSync(briefDir, { recursive: true });
      const briefPath = path.join(briefDir, "daily_brief.json");
      fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));

      logger?.info(
        `💾 [assembleDailyBrief] Brief saved to ${briefPath}`,
      );
      logger?.info(
        `📊 [assembleDailyBrief] Summary: ${topMatches.length} matches, ${allQuestions.length} questions, top_score=${topScore}, avg=${avgScore}`,
      );
      logger?.info(
        `✅ [assembleDailyBrief] Brief assembly complete`,
      );

      return {
        success: true,
        brief,
        briefPath,
      };
    } catch (err: any) {
      logger?.error(`❌ [assembleDailyBrief] Error: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  },
});
