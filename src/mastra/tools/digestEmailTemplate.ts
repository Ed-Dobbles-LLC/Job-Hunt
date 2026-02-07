import type { DailyBrief, DailyBriefJob, QuestionForEd } from "./dailyBriefTool";

export interface DigestJob {
  rank: number;
  company: string;
  title: string;
  score: number;
  truthPass: boolean;
  postingUrl?: string | null;
  location?: string | null;
  salaryRange?: string | null;
  roleShape?: string | null;
  topSkills?: string[];
  gapNotes?: string[];
}

export interface DigestStats {
  jobsFetched: number;
  jobsScored: number;
  jobsShortlisted: number;
  packetsGenerated: number;
  truthPassCount: number;
  truthFailCount: number;
}

export interface DigestData {
  date: string;
  stats: DigestStats;
  jobs: DigestJob[];
  runTimestamp: string;
  modelUsed: string;
  promptVersion: string;
}

function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function scoreColor(score: number): string {
  if (score >= 80) return "#16a34a";
  if (score >= 60) return "#ca8a04";
  return "#dc2626";
}

function scoreBgColor(score: number): string {
  if (score >= 80) return "#dcfce7";
  if (score >= 60) return "#fef9c3";
  return "#fef2f2";
}

function renderStatBox(label: string, value: number | string, color: string): string {
  return `
    <td style="padding: 8px 12px; text-align: center;">
      <div style="font-size: 28px; font-weight: 700; color: ${color}; line-height: 1.2;">${value}</div>
      <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px;">${label}</div>
    </td>`;
}

function renderJobRow(job: DigestJob): string {
  const sc = scoreColor(job.score);
  const scBg = scoreBgColor(job.score);
  const truthIcon = job.truthPass ? "&#9989;" : "&#10060;";
  const companyEsc = escapeHtml(job.company);
  const titleEsc = escapeHtml(job.title);
  const roleLink = job.postingUrl
    ? `<a href="${escapeHtml(job.postingUrl)}" style="color: #2563eb; text-decoration: none;">${titleEsc}</a>`
    : titleEsc;

  return `
    <tr style="border-bottom: 1px solid #f3f4f6;">
      <td style="padding: 12px 8px; text-align: center; font-weight: 600; color: #6b7280;">${job.rank}</td>
      <td style="padding: 12px 8px; font-weight: 600; color: #111827;">${companyEsc}</td>
      <td style="padding: 12px 8px;">${roleLink}</td>
      <td style="padding: 12px 8px; text-align: center;">
        <span style="display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 14px; color: ${sc}; background: ${scBg};">${Math.round(job.score)}</span>
      </td>
      <td style="padding: 12px 8px; text-align: center; font-size: 18px;">${truthIcon}</td>
    </tr>`;
}

function renderJobCard(job: DigestJob): string {
  const companyEsc = escapeHtml(job.company);
  const titleEsc = escapeHtml(job.title);
  const sc = scoreColor(job.score);

  const skillsHtml =
    job.topSkills && job.topSkills.length > 0
      ? job.topSkills
          .slice(0, 3)
          .map(
            (s) =>
              `<span style="display: inline-block; padding: 3px 10px; margin: 2px 4px 2px 0; border-radius: 10px; background: #eff6ff; color: #1d4ed8; font-size: 12px;">${escapeHtml(s)}</span>`,
          )
          .join("")
      : '<span style="color: #9ca3af; font-size: 12px;">No skill data</span>';

  const locationHtml = job.location
    ? `<span style="color: #4b5563;">${escapeHtml(job.location)}</span>`
    : "";

  const salaryHtml = job.salaryRange
    ? `<span style="color: #059669; font-weight: 600;">${escapeHtml(job.salaryRange)}</span>`
    : "";

  const roleShapeHtml = job.roleShape
    ? `<span style="display: inline-block; padding: 2px 8px; border-radius: 8px; background: #f3e8ff; color: #7c3aed; font-size: 11px; text-transform: uppercase;">${escapeHtml(job.roleShape)}</span>`
    : "";

  const gapHtml =
    job.gapNotes && job.gapNotes.length > 0
      ? `<div style="margin-top: 8px; padding: 8px 12px; background: #fefce8; border-left: 3px solid #eab308; border-radius: 4px;">
           <div style="font-size: 11px; color: #92400e; font-weight: 600; margin-bottom: 4px;">GAPS</div>
           ${job.gapNotes.map((g) => `<div style="font-size: 12px; color: #78350f;">&#8226; ${escapeHtml(g)}</div>`).join("")}
         </div>`
      : "";

  return `
    <div style="margin: 16px 0; padding: 16px 20px; border: 1px solid #e5e7eb; border-radius: 8px; background: #ffffff;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div>
          <span style="font-weight: 700; color: #111827; font-size: 15px;">${companyEsc}</span>
          <span style="color: #9ca3af; margin: 0 6px;">&#183;</span>
          <span style="color: #374151; font-size: 14px;">${titleEsc}</span>
        </div>
        <span style="font-weight: 700; color: ${sc}; font-size: 16px;">${Math.round(job.score)}</span>
      </div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="font-size: 12px; padding: 4px 0;">
          ${[locationHtml, salaryHtml, roleShapeHtml].filter(Boolean).join(' <span style="color: #d1d5db;">|</span> ')}
        </td>
      </tr></table>
      <div style="margin-top: 8px;">${skillsHtml}</div>
      ${gapHtml}
    </div>`;
}

export function renderDigestEmail(data: DigestData): string {
  const { date, stats, jobs, runTimestamp, modelUsed, promptVersion } = data;
  const dateEsc = escapeHtml(date);

  const hasJobs = jobs.length > 0;

  const statsRow = `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 20px 0; background: #f9fafb; border-radius: 8px;">
      <tr>
        ${renderStatBox("Fetched", stats.jobsFetched, "#374151")}
        ${renderStatBox("Scored", stats.jobsScored, "#374151")}
        ${renderStatBox("Shortlisted", stats.jobsShortlisted, "#2563eb")}
        ${renderStatBox("Packets", stats.packetsGenerated, "#7c3aed")}
        ${renderStatBox("Pass", stats.truthPassCount, "#16a34a")}
        ${renderStatBox("Fail", stats.truthFailCount, stats.truthFailCount > 0 ? "#dc2626" : "#16a34a")}
      </tr>
    </table>`;

  const jobTable = hasJobs
    ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; margin-top: 12px;">
      <thead>
        <tr style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;">
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">#</th>
          <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Company</th>
          <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Role</th>
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Score</th>
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Truth</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(renderJobRow).join("")}
      </tbody>
    </table>`
    : "";

  const jobCards = hasJobs
    ? `<div style="margin-top: 24px;">
        <h2 style="font-size: 16px; color: #111827; margin: 0 0 12px 0; font-weight: 700;">Job Details</h2>
        ${jobs.map(renderJobCard).join("")}
      </div>`
    : "";

  const emptyState = !hasJobs
    ? `<div style="padding: 40px 20px; text-align: center; color: #6b7280;">
        <div style="font-size: 48px; margin-bottom: 12px;">&#128270;</div>
        <h2 style="font-size: 18px; color: #374151; margin: 0 0 8px 0;">No matches today</h2>
        <p style="font-size: 14px; margin: 0;">No job postings met the shortlist criteria on ${dateEsc}. The system will try again tomorrow.</p>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Job Match Digest &ndash; ${dateEsc}</title>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table cellpadding="0" cellspacing="0" border="0" width="640" style="max-width: 640px; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 24px 32px; background: linear-gradient(135deg, #1e3a5f, #2563eb); color: #ffffff;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Daily Job Match Digest</h1>
              <p style="margin: 6px 0 0 0; font-size: 14px; color: #bfdbfe;">${dateEsc}</p>
            </td>
          </tr>

          <!-- Stats -->
          <tr>
            <td style="padding: 0 32px;">${statsRow}</td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              ${hasJobs ? `<h2 style="font-size: 16px; color: #111827; margin: 0 0 8px 0; font-weight: 700;">Shortlisted Jobs</h2>` : ""}
              ${jobTable}
              ${jobCards}
              ${emptyState}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 16px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size: 11px; color: #9ca3af;">
                    Run: ${escapeHtml(runTimestamp)}<br>
                    Model: ${escapeHtml(modelUsed)} &#183; Prompt: ${escapeHtml(promptVersion)}
                  </td>
                  <td style="font-size: 11px; color: #9ca3af; text-align: right;">
                    Automated by Job Match System
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function priorityColor(priority: string): string {
  if (priority === "high") return "#dc2626";
  if (priority === "medium") return "#ca8a04";
  return "#6b7280";
}

function priorityBg(priority: string): string {
  if (priority === "high") return "#fef2f2";
  if (priority === "medium") return "#fef9c3";
  return "#f9fafb";
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    missing_company_info: "Missing Info",
    ambiguous_requirement: "Unclear Requirement",
    salary_unknown: "Salary Unknown",
    contact_not_found: "No Contact Found",
    gap_in_experience: "Experience Gap",
    application_decision: "Decision Needed",
    other: "Other",
  };
  return labels[category] || category;
}

function renderBriefJobCard(job: DailyBriefJob): string {
  const companyEsc = escapeHtml(job.company);
  const titleEsc = escapeHtml(job.title);
  const sc = scoreColor(job.score);
  const scBg = scoreBgColor(job.score);
  const truthIcon = job.truth_pass ? "&#9989;" : "&#10060;";

  const postingLink = job.posting_url
    ? `<a href="${escapeHtml(job.posting_url)}" style="color: #2563eb; text-decoration: none; font-size: 12px;">View Posting &#8594;</a>`
    : "";

  const locationHtml = job.location
    ? `<span style="color: #4b5563; font-size: 12px;">${escapeHtml(job.location)}</span>`
    : "";

  const salaryHtml = job.salary_range
    ? `<span style="color: #059669; font-weight: 600; font-size: 12px;">${escapeHtml(job.salary_range)}</span>`
    : "";

  const roleShapeHtml = job.role_shape
    ? `<span style="display: inline-block; padding: 2px 8px; border-radius: 8px; background: #f3e8ff; color: #7c3aed; font-size: 11px; text-transform: uppercase;">${escapeHtml(job.role_shape)}</span>`
    : "";

  const skillsHtml =
    job.top_skills.length > 0
      ? job.top_skills
          .slice(0, 5)
          .map(
            (s) =>
              `<span style="display: inline-block; padding: 3px 10px; margin: 2px 4px 2px 0; border-radius: 10px; background: #eff6ff; color: #1d4ed8; font-size: 12px;">${escapeHtml(s)}</span>`,
          )
          .join("")
      : "";

  const gapHtml =
    job.gap_notes.length > 0
      ? `<div style="margin-top: 8px; padding: 8px 12px; background: #fefce8; border-left: 3px solid #eab308; border-radius: 4px;">
           <div style="font-size: 11px; color: #92400e; font-weight: 600; margin-bottom: 4px;">GAPS</div>
           ${job.gap_notes.slice(0, 3).map((g) => `<div style="font-size: 12px; color: #78350f;">&#8226; ${escapeHtml(g)}</div>`).join("")}
         </div>`
      : "";

  const fileLinks: string[] = [];
  if (job.file_paths.resume_pdf) fileLinks.push("Resume PDF");
  else if (job.file_paths.resume_docx) fileLinks.push("Resume DOCX");
  if (job.file_paths.cover_letter_pdf) fileLinks.push("Cover Letter PDF");
  else if (job.file_paths.cover_letter_docx) fileLinks.push("Cover Letter DOCX");
  if (job.file_paths.evidence_map) fileLinks.push("Evidence Map");
  if (job.file_paths.job_report) fileLinks.push("Report");

  const filesHtml =
    fileLinks.length > 0
      ? `<div style="margin-top: 8px; padding: 8px 12px; background: #f0fdf4; border-left: 3px solid #22c55e; border-radius: 4px;">
           <div style="font-size: 11px; color: #166534; font-weight: 600; margin-bottom: 4px;">FILES READY</div>
           <div style="font-size: 12px; color: #15803d;">${fileLinks.join(" &#183; ")}</div>
         </div>`
      : "";

  const namedContacts = job.outreach_targets.filter(
    (t) => t.person_name && t.person_name !== "NONE FOUND",
  );
  const contactsHtml =
    namedContacts.length > 0
      ? `<div style="margin-top: 8px; padding: 8px 12px; background: #eff6ff; border-left: 3px solid #3b82f6; border-radius: 4px;">
           <div style="font-size: 11px; color: #1e40af; font-weight: 600; margin-bottom: 4px;">OUTREACH TARGETS</div>
           ${namedContacts
             .slice(0, 3)
             .map(
               (c) =>
                 `<div style="font-size: 12px; color: #1e3a8a; margin-bottom: 2px;">
                    <strong>${escapeHtml(c.person_name)}</strong> &#8212; ${escapeHtml(c.title)}
                    ${c.message_warm ? `<div style="font-size: 11px; color: #6b7280; margin-top: 2px; font-style: italic;">&#8220;${escapeHtml(c.message_warm.substring(0, 80))}...&#8221;</div>` : ""}
                  </div>`,
             )
             .join("")}
         </div>`
      : job.outreach_targets.length > 0
        ? `<div style="margin-top: 8px; padding: 8px 12px; background: #fff7ed; border-left: 3px solid #f97316; border-radius: 4px;">
             <div style="font-size: 11px; color: #9a3412; font-weight: 600;">No named contacts found &#8212; manual search recommended</div>
           </div>`
        : "";

  return `
    <div style="margin: 16px 0; padding: 16px 20px; border: 1px solid #e5e7eb; border-radius: 8px; background: #ffffff;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td>
            <span style="font-weight: 700; color: #111827; font-size: 15px;">${companyEsc}</span>
            <span style="color: #9ca3af; margin: 0 6px;">&#183;</span>
            <span style="color: #374151; font-size: 14px;">${titleEsc}</span>
          </td>
          <td style="text-align: right;">
            <span style="display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 14px; color: ${sc}; background: ${scBg};">${Math.round(job.score)}</span>
            <span style="margin-left: 8px; font-size: 16px;">${truthIcon}</span>
          </td>
        </tr>
      </table>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top: 4px;">
        <tr>
          <td style="font-size: 12px; padding: 4px 0;">
            ${[locationHtml, salaryHtml, roleShapeHtml, postingLink].filter(Boolean).join(' <span style="color: #d1d5db;">|</span> ')}
          </td>
        </tr>
      </table>
      ${skillsHtml ? `<div style="margin-top: 8px;">${skillsHtml}</div>` : ""}
      ${gapHtml}
      ${filesHtml}
      ${contactsHtml}
    </div>`;
}

function renderQuestionsSection(questions: QuestionForEd[]): string {
  if (questions.length === 0) return "";

  const highPriority = questions.filter((q) => q.priority === "high");
  const otherPriority = questions.filter((q) => q.priority !== "high");
  const sorted = [...highPriority, ...otherPriority];

  const questionCards = sorted
    .map(
      (q) => `
    <div style="margin: 8px 0; padding: 12px 16px; border-left: 4px solid ${priorityColor(q.priority)}; background: ${priorityBg(q.priority)}; border-radius: 4px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td>
            <span style="display: inline-block; padding: 2px 8px; border-radius: 8px; background: ${priorityColor(q.priority)}; color: #ffffff; font-size: 10px; font-weight: 700; text-transform: uppercase; margin-right: 8px;">${escapeHtml(q.priority)}</span>
            <span style="display: inline-block; padding: 2px 8px; border-radius: 8px; background: #e5e7eb; color: #374151; font-size: 10px; text-transform: uppercase;">${categoryLabel(q.category)}</span>
          </td>
          <td style="text-align: right; font-size: 11px; color: #6b7280;">
            ${escapeHtml(q.company)}
          </td>
        </tr>
      </table>
      <div style="font-size: 13px; color: #111827; font-weight: 600; margin-top: 6px;">${escapeHtml(q.question)}</div>
      <div style="font-size: 12px; color: #4b5563; margin-top: 4px;">${escapeHtml(q.context)}</div>
    </div>`,
    )
    .join("");

  return `
    <div style="margin-top: 24px;">
      <h2 style="font-size: 16px; color: #111827; margin: 0 0 12px 0; font-weight: 700;">&#10067; Questions for Ed</h2>
      <p style="font-size: 12px; color: #6b7280; margin: 0 0 12px 0;">
        The system identified ${questions.length} item${questions.length !== 1 ? "s" : ""} that need${questions.length === 1 ? "s" : ""} your input.
        ${highPriority.length > 0 ? `<strong style="color: #dc2626;">${highPriority.length} high priority.</strong>` : ""}
      </p>
      ${questionCards}
    </div>`;
}

function renderStorageLayout(storageRoot: string, matches: DailyBriefJob[]): string {
  if (matches.length === 0) return "";

  const treeLines = matches
    .filter((m) => Object.values(m.file_paths).some(Boolean))
    .slice(0, 5)
    .map((m) => {
      const files: string[] = [];
      if (m.file_paths.resume_pdf || m.file_paths.resume_docx) files.push("resume.*");
      if (m.file_paths.cover_letter_pdf || m.file_paths.cover_letter_docx) files.push("coverletter.*");
      if (m.file_paths.evidence_map || m.file_paths.job_report) files.push("report.json");
      return `&#9492;&#9472; ${escapeHtml(m.company)}/${escapeHtml(m.title)}/ [${files.join(", ")}]`;
    })
    .join("<br>");

  return `
    <div style="margin-top: 24px; padding: 12px 16px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
      <div style="font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; margin-bottom: 8px;">Storage Layout</div>
      <div style="font-family: 'Courier New', monospace; font-size: 12px; color: #374151; line-height: 1.6;">
        ${escapeHtml(storageRoot)}/<br>
        ${treeLines}
      </div>
    </div>`;
}

export function renderDailyBriefEmail(brief: DailyBrief): string {
  const dateEsc = escapeHtml(brief.date);
  const { summary } = brief;
  const hasMatches = brief.top_matches.length > 0;

  const statsRow = `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 20px 0; background: #f9fafb; border-radius: 8px;">
      <tr>
        ${renderStatBox("Fetched", summary.jobs_fetched, "#374151")}
        ${renderStatBox("Scored", summary.jobs_scored, "#374151")}
        ${renderStatBox("Shortlisted", summary.jobs_shortlisted, "#2563eb")}
        ${renderStatBox("Packets", summary.packets_generated, "#7c3aed")}
        ${renderStatBox("Pass", summary.truth_pass_count, "#16a34a")}
        ${renderStatBox("Fail", summary.truth_fail_count, summary.truth_fail_count > 0 ? "#dc2626" : "#16a34a")}
      </tr>
      <tr>
        <td colspan="6" style="padding: 4px 12px 8px; text-align: center;">
          <span style="font-size: 12px; color: #6b7280;">Top: <strong style="color: ${scoreColor(summary.top_score)};">${Math.round(summary.top_score)}</strong> &nbsp;&#183;&nbsp; Avg: <strong style="color: ${scoreColor(summary.avg_score)};">${Math.round(summary.avg_score)}</strong></span>
        </td>
      </tr>
    </table>`;

  const rankTable = hasMatches
    ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; margin-top: 12px;">
      <thead>
        <tr style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;">
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">#</th>
          <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Company</th>
          <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Role</th>
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Score</th>
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Truth</th>
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Files</th>
          <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Contacts</th>
        </tr>
      </thead>
      <tbody>
        ${brief.top_matches
          .map((m) => {
            const sc = scoreColor(m.score);
            const scBg = scoreBgColor(m.score);
            const truthIcon = m.truth_pass ? "&#9989;" : "&#10060;";
            const fileCount = Object.values(m.file_paths).filter(Boolean).length;
            const contactCount = m.outreach_targets.filter((t) => t.person_name && t.person_name !== "NONE FOUND").length;
            const titleLink = m.posting_url
              ? `<a href="${escapeHtml(m.posting_url)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(m.title)}</a>`
              : escapeHtml(m.title);

            return `
            <tr style="border-bottom: 1px solid #f3f4f6;">
              <td style="padding: 12px 8px; text-align: center; font-weight: 600; color: #6b7280;">${m.rank}</td>
              <td style="padding: 12px 8px; font-weight: 600; color: #111827;">${escapeHtml(m.company)}</td>
              <td style="padding: 12px 8px;">${titleLink}</td>
              <td style="padding: 12px 8px; text-align: center;">
                <span style="display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 14px; color: ${sc}; background: ${scBg};">${Math.round(m.score)}</span>
              </td>
              <td style="padding: 12px 8px; text-align: center; font-size: 18px;">${truthIcon}</td>
              <td style="padding: 12px 8px; text-align: center; font-size: 12px; color: #374151;">${fileCount > 0 ? `${fileCount} &#128196;` : "&#8212;"}</td>
              <td style="padding: 12px 8px; text-align: center; font-size: 12px; color: #374151;">${contactCount > 0 ? `${contactCount} &#128100;` : "&#8212;"}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`
    : "";

  const jobDetailCards = hasMatches
    ? `<div style="margin-top: 24px;">
        <h2 style="font-size: 16px; color: #111827; margin: 0 0 12px 0; font-weight: 700;">Match Details</h2>
        ${brief.top_matches.map(renderBriefJobCard).join("")}
      </div>`
    : "";

  const questionsSection = renderQuestionsSection(brief.questions_for_ed);

  const storageSection = renderStorageLayout(brief.storage_root, brief.top_matches);

  const emptyState = !hasMatches
    ? `<div style="padding: 40px 20px; text-align: center; color: #6b7280;">
        <div style="font-size: 48px; margin-bottom: 12px;">&#128270;</div>
        <h2 style="font-size: 18px; color: #374151; margin: 0 0 8px 0;">No matches today</h2>
        <p style="font-size: 14px; margin: 0;">No job postings met the shortlist criteria on ${dateEsc}. The system will try again tomorrow.</p>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Brief &ndash; ${dateEsc}</title>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table cellpadding="0" cellspacing="0" border="0" width="680" style="max-width: 680px; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 24px 32px; background: linear-gradient(135deg, #1e3a5f, #2563eb); color: #ffffff;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Daily Brief</h1>
              <p style="margin: 6px 0 0 0; font-size: 14px; color: #bfdbfe;">${dateEsc} &#183; ${brief.top_matches.length} match${brief.top_matches.length !== 1 ? "es" : ""} &#183; ${brief.questions_for_ed.length} question${brief.questions_for_ed.length !== 1 ? "s" : ""}</p>
            </td>
          </tr>

          <!-- Stats -->
          <tr>
            <td style="padding: 0 32px;">${statsRow}</td>
          </tr>

          <!-- Ranked Table -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              ${hasMatches ? `<h2 style="font-size: 16px; color: #111827; margin: 0 0 8px 0; font-weight: 700;">Top Matches</h2>` : ""}
              ${rankTable}
              ${emptyState}
            </td>
          </tr>

          <!-- Job Detail Cards -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              ${jobDetailCards}
            </td>
          </tr>

          <!-- Questions for Ed -->
          ${brief.questions_for_ed.length > 0 ? `<tr><td style="padding: 0 32px 24px 32px;">${questionsSection}</td></tr>` : ""}

          <!-- Storage Layout -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              ${storageSection}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 16px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size: 11px; color: #9ca3af;">
                    Generated: ${escapeHtml(brief.generated_at)}<br>
                    Model: ${escapeHtml(brief.model_used)} &#183; Prompt: ${escapeHtml(brief.prompt_version)}
                  </td>
                  <td style="font-size: 11px; color: #9ca3af; text-align: right;">
                    Automated by Job Match System
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export { escapeHtml, scoreColor, scoreBgColor };
