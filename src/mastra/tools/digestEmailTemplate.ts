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
           ${job.gapNotes.map((g) => `<div style="font-size: 12px; color: #78350f;">• ${escapeHtml(g)}</div>`).join("")}
         </div>`
      : "";

  return `
    <div style="margin: 16px 0; padding: 16px 20px; border: 1px solid #e5e7eb; border-radius: 8px; background: #ffffff;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div>
          <span style="font-weight: 700; color: #111827; font-size: 15px;">${companyEsc}</span>
          <span style="color: #9ca3af; margin: 0 6px;">·</span>
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
  <title>Daily Job Match Digest – ${dateEsc}</title>
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
                    Model: ${escapeHtml(modelUsed)} · Prompt: ${escapeHtml(promptVersion)}
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
