/**
 * Plaintext Resume Renderer
 *
 * Renders a TailoredResume into ATS-safe plaintext format. ATS (Applicant
 * Tracking Systems) often strip formatting, so this renderer produces a
 * document that reads cleanly even when all formatting is lost.
 *
 * Rules:
 * - ALL CAPS section headings, no decorators
 * - Exact section order: EXECUTIVE SUMMARY, CORE COMPETENCIES,
 *   PROFESSIONAL EXPERIENCE, TOOLS & PLATFORMS, EDUCATION, CERTIFICATIONS
 * - No tables, no columns, no special characters
 * - Bullet points use simple "- " prefix
 * - Each role: "EMPLOYER | TITLE | LOCATION\nSTART_DATE - END_DATE"
 * - 80-character line width maximum (soft wrap)
 * - Double newline between sections
 * - Single newline between roles
 */

import type { TailoredResume } from "../../mastra/tools/tailoredResumePrompt";

const MAX_LINE_WIDTH = 80;

// ── Text Utilities ───────────────────────────────────────────────

/**
 * Soft-wraps a string at the given line width, breaking at word
 * boundaries. Preserves leading indentation on continuation lines
 * when an indent string is provided.
 */
function softWrap(text: string, maxWidth: number, continuationIndent = ""): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  const lines: string[] = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + " " + word;

    if (testLine.length <= maxWidth) {
      currentLine = testLine;
    } else {
      lines.push(currentLine);
      currentLine = continuationIndent + word;
    }
  }
  lines.push(currentLine);

  return lines.join("\n");
}

/**
 * Wraps a bullet point ("- " prefix) to the max width, with a 2-char
 * continuation indent so wrapped lines align under the text, not the dash.
 */
function wrapBullet(text: string): string {
  const prefix = "- ";
  const fullText = prefix + text;
  return softWrap(fullText, MAX_LINE_WIDTH, "  ");
}

/**
 * Strips any characters that could trip up an ATS parser. Keeps only
 * standard ASCII printable characters, newlines, and common punctuation.
 */
function sanitize(text: string): string {
  // Replace smart quotes, em/en dashes, and other common Unicode with ASCII equivalents
  return text
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2026]/g, "...")
    .replace(/[\u00A0]/g, " ")
    .replace(/[\u2022\u25CF\u25CB\u25A0\u25AA]/g, "-");
}

// ── Section Renderers ────────────────────────────────────────────

function renderHeader(resume: TailoredResume, candidateName?: string): string {
  const parts: string[] = [];

  if (candidateName) {
    parts.push(candidateName.toUpperCase());
  }

  if (resume.executive_headline) {
    parts.push(resume.executive_headline);
  }

  return parts.join("\n");
}

function renderExecutiveSummary(resume: TailoredResume): string {
  const lines: string[] = [];
  lines.push("EXECUTIVE SUMMARY");
  lines.push("");
  lines.push(softWrap(resume.professional_summary, MAX_LINE_WIDTH));
  return lines.join("\n");
}

function renderCoreCompetencies(resume: TailoredResume): string | null {
  const competencies = resume.core_competencies;
  if (!competencies || competencies.length === 0) return null;

  const lines: string[] = [];
  lines.push("CORE COMPETENCIES");
  lines.push("");

  // Render as a simple wrapped list separated by " | "
  const joined = competencies.join(" | ");
  lines.push(softWrap(joined, MAX_LINE_WIDTH));

  return lines.join("\n");
}

function renderProfessionalExperience(resume: TailoredResume): string {
  const lines: string[] = [];
  lines.push("PROFESSIONAL EXPERIENCE");

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];

    // Single newline between roles
    lines.push("");

    // Role header: EMPLOYER | TITLE | LOCATION
    const roleLine = [exp.employer, exp.title, exp.location]
      .filter(Boolean)
      .join(" | ");
    lines.push(softWrap(roleLine, MAX_LINE_WIDTH));

    // Date line: START_DATE - END_DATE
    const dateLine = `${exp.start_date} - ${exp.end_date}`;
    lines.push(dateLine);

    // Scope line if present
    if (exp.scope_line) {
      lines.push(softWrap(exp.scope_line, MAX_LINE_WIDTH));
    }

    // Bullets
    for (const bullet of exp.bullets) {
      lines.push(wrapBullet(bullet.text));
    }
  }

  return lines.join("\n");
}

function renderToolsAndPlatforms(resume: TailoredResume): string | null {
  const tools = resume.skills?.tools_and_platforms;
  if (!tools || tools.length === 0) return null;

  const lines: string[] = [];
  lines.push("TOOLS & PLATFORMS");
  lines.push("");

  const joined = tools.join(", ");
  lines.push(softWrap(joined, MAX_LINE_WIDTH));

  return lines.join("\n");
}

function renderEducation(resume: TailoredResume): string {
  const lines: string[] = [];
  lines.push("EDUCATION");

  for (const edu of resume.education) {
    lines.push("");
    const eduLine = [edu.institution, edu.degree, edu.year]
      .filter(Boolean)
      .join(" | ");
    lines.push(softWrap(eduLine, MAX_LINE_WIDTH));
  }

  return lines.join("\n");
}

function renderCertifications(resume: TailoredResume): string | null {
  const certs = resume.certifications;
  if (!certs || certs.length === 0) return null;

  const lines: string[] = [];
  lines.push("CERTIFICATIONS");

  for (const cert of certs) {
    lines.push("");
    const certLine = cert.year ? `${cert.name} (${cert.year})` : cert.name;
    lines.push(softWrap(certLine, MAX_LINE_WIDTH));
  }

  return lines.join("\n");
}

// ── Main Renderer ────────────────────────────────────────────────

/**
 * Renders a TailoredResume to ATS-safe plaintext format.
 *
 * Sections appear in this exact order:
 * 1. Header (candidate name + executive headline)
 * 2. EXECUTIVE SUMMARY
 * 3. CORE COMPETENCIES (if present)
 * 4. PROFESSIONAL EXPERIENCE
 * 5. TOOLS & PLATFORMS (if present)
 * 6. EDUCATION
 * 7. CERTIFICATIONS (if present)
 *
 * Sections are separated by double newlines. The output uses only
 * ASCII-safe characters and simple "- " bullet prefixes.
 *
 * @param resume  The TailoredResume object to render
 * @param candidateName  Optional candidate name for the header
 * @returns  The plaintext resume string
 */
export function renderPlaintext(resume: TailoredResume, candidateName?: string): string {
  const sections: string[] = [];

  // Header (name + headline)
  const header = renderHeader(resume, candidateName);
  if (header) {
    sections.push(header);
  }

  // Mandatory sections
  sections.push(renderExecutiveSummary(resume));

  // Optional: Core Competencies
  const coreComp = renderCoreCompetencies(resume);
  if (coreComp) {
    sections.push(coreComp);
  }

  // Mandatory: Professional Experience
  sections.push(renderProfessionalExperience(resume));

  // Optional: Tools & Platforms
  const tools = renderToolsAndPlatforms(resume);
  if (tools) {
    sections.push(tools);
  }

  // Mandatory: Education
  sections.push(renderEducation(resume));

  // Optional: Certifications
  const certs = renderCertifications(resume);
  if (certs) {
    sections.push(certs);
  }

  // Join sections with double newlines and sanitize the output
  const raw = sections.join("\n\n");
  return sanitize(raw);
}
