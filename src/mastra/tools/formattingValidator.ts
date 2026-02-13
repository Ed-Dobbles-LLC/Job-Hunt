import JSZip from "jszip";
import type { TailoredResume } from "./tailoredResumePrompt";
import type { TailoredCoverLetter } from "./tailoredCoverLetterPrompt";

export type ViolationSeverity = "critical" | "warning";

export interface FormattingViolation {
  check: string;
  severity: ViolationSeverity;
  message: string;
  location: string;
  details?: string;
}

export interface FormattingReport {
  pass: boolean;
  checksRun: number;
  criticalCount: number;
  warningCount: number;
  violations: FormattingViolation[];
  documentType: "resume" | "cover_letter";
  timestamp: string;
}

const PLACEHOLDER_PATTERNS: { regex: RegExp; label: string }[] = [
  { regex: /\{\{\s*[\w.]+\s*\}\}/g, label: "Mustache template variable ({{ }})" },
  { regex: /\$\{\s*[\w.]+\s*\}/g, label: "Template literal variable (${ })" },
  { regex: /\[INSERT\b/gi, label: "[INSERT...] placeholder" },
  { regex: /\[YOUR\b/gi, label: "[YOUR...] placeholder" },
  { regex: /\[COMPANY\b/gi, label: "[COMPANY...] placeholder" },
  { regex: /\[NAME\b/gi, label: "[NAME...] placeholder" },
  { regex: /\[DATE\b/gi, label: "[DATE...] placeholder" },
  { regex: /\[POSITION\b/gi, label: "[POSITION...] placeholder" },
  { regex: /\[ROLE\b/gi, label: "[ROLE...] placeholder" },
  { regex: /lorem\s+ipsum/gi, label: "Lorem ipsum text" },
  { regex: /dolor\s+sit\s+amet/gi, label: "Lorem ipsum continuation" },
  { regex: /\[object\s+Object\]/g, label: "[object Object] rendering bug" },
  { regex: /undefined/g, label: "'undefined' text" },
  { regex: /null(?=[^a-zA-Z])/g, label: "'null' text" },
  { regex: /TODO\b/g, label: "TODO marker" },
  { regex: /FIXME\b/g, label: "FIXME marker" },
  { regex: /XXX\b/g, label: "XXX marker" },
  { regex: /example\.com/gi, label: "Placeholder domain (example.com)" },
  { regex: /test\.com/gi, label: "Placeholder domain (test.com)" },
  { regex: /placeholder\.com/gi, label: "Placeholder domain" },
  { regex: /sample@/gi, label: "Sample email prefix" },
  { regex: /\bN\/A\b/gi, label: "N/A placeholder" },
  { regex: /\bTBD\b/g, label: "TBD placeholder" },
];

// Each entry is an array of acceptable variants for the section heading.
// The DOCX renderer may use "Executive Summary" or "Professional Summary",
// "Professional Experience" or "Experience", etc.
const RESUME_REQUIRED_SECTIONS: { label: string; variants: string[] }[] = [
  { label: "SUMMARY", variants: ["PROFESSIONAL SUMMARY", "EXECUTIVE SUMMARY"] },
  { label: "EXPERIENCE", variants: ["EXPERIENCE", "PROFESSIONAL EXPERIENCE"] },
  { label: "SKILLS", variants: ["SKILLS", "ENTERPRISE CAPABILITIES", "TOOLS & PLATFORMS", "CORE COMPETENCIES"] },
  { label: "EDUCATION", variants: ["EDUCATION"] },
];

async function extractDocxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = zip.file("word/document.xml");
  if (!docXml) {
    throw new Error("Invalid DOCX: word/document.xml not found");
  }
  return await docXml.async("string");
}

function extractPlainText(xml: string): string {
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function findAllTextRuns(xml: string): string[] {
  const matches = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  return matches.map((m) => m.replace(/<[^>]+>/g, ""));
}

export function checkDuplicateHeadings(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const headingTexts = findAllTextRuns(xml);

  const headingCandidates = headingTexts.filter((t) => {
    const trimmed = t.trim();
    return trimmed.length > 0 && trimmed === trimmed.toUpperCase() && trimmed.length > 2 && /^[A-Z\s&]+$/.test(trimmed);
  });

  const counts = new Map<string, number>();
  for (const h of headingCandidates) {
    const key = h.trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  for (const [heading, count] of counts) {
    if (count > 1) {
      violations.push({
        check: "DUPLICATE_HEADING",
        severity: "critical",
        message: `Heading "${heading}" appears ${count} times`,
        location: "document",
        details: `Section heading "${heading}" is duplicated. Each section heading should appear exactly once.`,
      });
    }
  }

  return violations;
}

export function checkPlaceholders(
  xml: string,
  allowlist: string[] = [],
): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);
  const normalizedAllowlist = allowlist.map((a) => a.toLowerCase());

  for (const { regex, label } of PLACEHOLDER_PATTERNS) {
    regex.lastIndex = 0;
    const matches = plainText.match(regex) || [];
    for (const match of matches) {
      const matchLower = match.toLowerCase();
      const isAllowlisted = normalizedAllowlist.some(
        (a) => a.includes(matchLower) || matchLower.includes(a),
      );

      if (!isAllowlisted) {
        violations.push({
          check: "PLACEHOLDER",
          severity: "critical",
          message: `Found placeholder: "${match}" (${label})`,
          location: "document",
          details: `Placeholder or template artifact "${match}" must be replaced with actual content before sending.`,
        });
      }
    }
  }

  return violations;
}

export function checkPageCount(
  pageCount: number,
  maxPages: number,
  documentType: string,
): FormattingViolation[] {
  const violations: FormattingViolation[] = [];

  if (pageCount > maxPages) {
    violations.push({
      check: "PAGE_COUNT",
      severity: "critical",
      message: `${documentType} is ${pageCount} page(s) (max ${maxPages})`,
      location: "document",
      details: `Reduce content to fit within ${maxPages} page(s). Current length: ${pageCount} page(s).`,
    });
  }

  return violations;
}

export function checkMissingContactInfo(
  xml: string,
  profile: {
    name?: string;
    email?: string;
    phone?: string;
    location?: string;
  },
): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);
  const textLower = plainText.toLowerCase();

  if (profile.name) {
    const nameLower = profile.name.toLowerCase();
    if (!textLower.includes(nameLower)) {
      violations.push({
        check: "MISSING_CONTACT",
        severity: "critical",
        message: `Candidate name "${profile.name}" not found in document`,
        location: "header",
        details: "The candidate's name must appear in the document header.",
      });
    }
  }

  if (profile.email) {
    const emailLower = profile.email.toLowerCase();
    if (!textLower.includes(emailLower)) {
      violations.push({
        check: "MISSING_CONTACT",
        severity: "warning",
        message: `Email "${profile.email}" not found in document`,
        location: "header",
        details: "The candidate's email should appear in the contact information section.",
      });
    }
  }

  if (profile.phone) {
    const phoneDigits = profile.phone.replace(/\D/g, "");
    const textDigits = plainText.replace(/\D/g, "");
    if (phoneDigits.length >= 7 && !textDigits.includes(phoneDigits)) {
      violations.push({
        check: "MISSING_CONTACT",
        severity: "warning",
        message: `Phone "${profile.phone}" not found in document`,
        location: "header",
        details: "The candidate's phone number should appear in the contact information section.",
      });
    }
  }

  if (profile.location) {
    const locLower = profile.location.toLowerCase().split(",")[0].trim();
    if (locLower.length > 2 && !textLower.includes(locLower)) {
      violations.push({
        check: "MISSING_CONTACT",
        severity: "warning",
        message: `Location "${profile.location}" not found in document`,
        location: "header",
        details: "The candidate's location should appear in the contact information section.",
      });
    }
  }

  return violations;
}

export function checkBrokenLinks(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];

  const linkMatches = xml.match(/<w:hyperlink[^>]*>/g) || [];
  const relIdPattern = /r:id="([^"]*)"/;

  const relsXml = xml;
  for (const link of linkMatches) {
    const relMatch = link.match(relIdPattern);
    if (relMatch && !relMatch[1]) {
      violations.push({
        check: "BROKEN_LINK",
        severity: "warning",
        message: "Hyperlink with empty relationship ID found",
        location: "document",
        details: "A hyperlink element references an empty or missing relationship.",
      });
    }
  }

  const plainText = extractPlainText(xml);
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  const urls = plainText.match(urlPattern) || [];

  const brokenPatterns = [
    /https?:\/\/$/,
    /https?:\/\/\s/,
    /https?:\/\/[^/]*\.\./,
    /https?:\/\/localhost/,
    /https?:\/\/127\.0\.0\.1/,
    /https?:\/\/0\.0\.0\.0/,
    /https?:\/\/example\.com/i,
    /https?:\/\/test\.com/i,
  ];

  for (const url of urls) {
    for (const bp of brokenPatterns) {
      if (bp.test(url)) {
        violations.push({
          check: "BROKEN_LINK",
          severity: "warning",
          message: `Potentially broken or placeholder URL: "${url}"`,
          location: "document",
          details: `URL "${url}" appears to be a placeholder, localhost reference, or malformed link.`,
        });
        break;
      }
    }
  }

  return violations;
}

export function checkResumeSections(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const textRuns = findAllTextRuns(xml);
  const allText = textRuns.join(" ").toUpperCase();

  for (const section of RESUME_REQUIRED_SECTIONS) {
    const found = section.variants.some((v) => allText.includes(v));
    if (!found) {
      violations.push({
        check: "MISSING_SECTION",
        severity: "critical",
        message: `Required section "${section.label}" not found`,
        location: "document",
        details: `The ${section.label} section is required in a resume. Ensure it is present with the correct heading (accepted: ${section.variants.join(", ")}).`,
      });
    }
  }

  return violations;
}

// ── Executive Quality Checks ──────────────────────────────────────

const FILLER_PHRASES: { regex: RegExp; label: string }[] = [
  { regex: /\bserving as\b/gi, label: '"serving as…"' },
  { regex: /\bknown for\b/gi, label: '"known for…"' },
  { regex: /\bresponsible for\b/gi, label: '"responsible for…"' },
  { regex: /\bplayed a key role\b/gi, label: '"played a key role…"' },
  { regex: /\bcore member of\b/gi, label: '"core member of…"' },
  { regex: /\bserved as\b/gi, label: '"served as…"' },
  { regex: /\btasked with\b/gi, label: '"tasked with…"' },
  { regex: /\bin charge of\b/gi, label: '"in charge of…"' },
  { regex: /\bcareer defined by\b/gi, label: '"career defined by…"' },
  { regex: /\bdistinctly technical for an executive\b/gi, label: '"distinctly technical for an executive…"' },
  { regex: /\bpositioned analytics as a revenue driver\b/gi, label: '"positioned analytics as a revenue driver"' },
  { regex: /\btransforming analytics into strategic growth engines\b/gi, label: '"transforming analytics into strategic growth engines"' },
];

const PASSIVE_PHRASES: { regex: RegExp; label: string }[] = [
  { regex: /\bwas responsible for\b/gi, label: '"was responsible for…"' },
  { regex: /\bwas tasked with\b/gi, label: '"was tasked with…"' },
  { regex: /\bwas involved in\b/gi, label: '"was involved in…"' },
  { regex: /\bwas charged with\b/gi, label: '"was charged with…"' },
  { regex: /\bwas instrumental in\b/gi, label: '"was instrumental in…"' },
  { regex: /\bhelped\s+\w+/gi, label: '"helped…" (hedging)' },
  { regex: /\bassisted\s+(?:in|with)/gi, label: '"assisted in/with…" (hedging)' },
  { regex: /\bcontributed to\b/gi, label: '"contributed to…" (hedging)' },
];

/**
 * Check for filler phrases that should be replaced with action-first phrasing.
 */
export function checkFillerPhrases(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);

  for (const { regex, label } of FILLER_PHRASES) {
    regex.lastIndex = 0;
    const matches = plainText.match(regex) || [];
    if (matches.length > 0) {
      violations.push({
        check: "FILLER_PHRASE",
        severity: "warning",
        message: `Found filler phrase ${label} (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
        location: "document",
        details: `Replace ${label} with action-first phrasing. Executive resumes should lead with verbs: Architected, Launched, Built, etc.`,
      });
    }
  }

  return violations;
}

/**
 * Check bullet word count — target 18-22 words max, warn if >22.
 * Bullets are identified by "• " prefix in the document text.
 */
export function checkBulletLength(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);

  const bulletPattern = /•\s+([^•]+)/g;
  let match: RegExpExecArray | null;
  let bulletIndex = 0;

  while ((match = bulletPattern.exec(plainText)) !== null) {
    bulletIndex++;
    const bulletText = match[1].trim();
    const wordCount = bulletText.split(/\s+/).filter(w => w.length > 0).length;

    if (wordCount > 22) {
      violations.push({
        check: "BULLET_TOO_LONG",
        severity: "warning",
        message: `Bullet #${bulletIndex} is ${wordCount} words (max: 22)`,
        location: "experience",
        details: `"${bulletText.substring(0, 60)}..." — compress using Action → Scale → Outcome format.`,
      });
    }
  }

  return violations;
}

/**
 * Check total bullet count — should be 13-15 for a 2-page resume.
 */
export function checkTotalBulletCount(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);
  const bulletMatches = plainText.match(/•\s+/g) || [];
  const count = bulletMatches.length;

  if (count > 17) {
    violations.push({
      check: "TOO_MANY_BULLETS",
      severity: "warning",
      message: `Resume has ${count} bullets (target: 13-15, max: 17)`,
      location: "experience",
      details: `Too many bullets risk exceeding 2 pages. Reduce to 13-15 total by trimming older roles first.`,
    });
  }

  return violations;
}

/**
 * Check for stacked metrics in a single bullet (multiple numbers in one sentence).
 */
export function checkStackedMetrics(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);

  const bulletPattern = /•\s+([^•]+)/g;
  let match: RegExpExecArray | null;
  let bulletIndex = 0;

  while ((match = bulletPattern.exec(plainText)) !== null) {
    bulletIndex++;
    const bulletText = match[1].trim();
    // Count distinct metric-like patterns (numbers with $, %, or followed by units)
    const metricMatches = bulletText.match(/\$[\d,.]+[BMK]?|\d+[%]|\d+\+?\s*(?:FTEs?|people|team members|direct reports|business units)/gi) || [];

    if (metricMatches.length > 2) {
      violations.push({
        check: "STACKED_METRICS",
        severity: "warning",
        message: `Bullet #${bulletIndex} has ${metricMatches.length} stacked metrics (max 1 per clause)`,
        location: "experience",
        details: `Metrics found: ${metricMatches.join(", ")} — split into separate bullets or keep one metric per clause.`,
      });
    }
  }

  return violations;
}

/**
 * Check that experience entries are in reverse chronological order.
 * Parses date strings from the document and flags any out-of-order roles.
 */
export function checkChronologicalOrder(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);

  // Find date ranges in the format "Mon YYYY – Mon YYYY" or "Mon YYYY – Present"
  const dateRangePattern = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s*[–—-]\s*(?:(Present)|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4}))/gi;
  const dates: { startYear: number; endYear: number; raw: string }[] = [];
  let dateMatch: RegExpExecArray | null;

  while ((dateMatch = dateRangePattern.exec(plainText)) !== null) {
    const startYear = parseInt(dateMatch[1], 10);
    const endYear = dateMatch[2] === "Present" ? 9999 : parseInt(dateMatch[3] || dateMatch[1], 10);
    dates.push({ startYear, endYear, raw: dateMatch[0] });
  }

  // Check reverse chronological order (most recent first)
  for (let i = 1; i < dates.length; i++) {
    if (dates[i].endYear > dates[i - 1].endYear) {
      violations.push({
        check: "CHRONOLOGICAL_ORDER",
        severity: "warning",
        message: `Role with "${dates[i].raw}" appears after "${dates[i - 1].raw}" — expected reverse chronological order`,
        location: "experience",
        details: "Roles must be ordered from most recent to oldest. Move this role earlier in the document.",
      });
    }
  }

  return violations;
}

/**
 * Check for passive phrasing that should be replaced with action-first language.
 */
export function checkPassivePhrasing(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);

  for (const { regex, label } of PASSIVE_PHRASES) {
    regex.lastIndex = 0;
    const matches = plainText.match(regex) || [];
    if (matches.length > 0) {
      violations.push({
        check: "PASSIVE_PHRASING",
        severity: "warning",
        message: `Found passive/hedging phrase ${label} (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
        location: "document",
        details: `Replace ${label} with direct action verbs. Executive resumes must read like a senior leader briefing a board.`,
      });
    }
  }

  return violations;
}

/**
 * Check that the executive summary does not exceed 5 lines.
 * Estimates lines at ~80 characters per line.
 */
export function checkSummaryLineCount(xml: string): FormattingViolation[] {
  const violations: FormattingViolation[] = [];
  const plainText = extractPlainText(xml);

  // Find summary section — between SUMMARY heading and next heading
  const summaryMatch = plainText.match(/(?:EXECUTIVE SUMMARY|PROFESSIONAL SUMMARY)\s+([\s\S]*?)(?=(?:CORE COMPETENCIES|PROFESSIONAL EXPERIENCE|EXPERIENCE|SKILLS|EDUCATION|$))/i);
  if (summaryMatch) {
    const summaryText = summaryMatch[1].trim();
    const estimatedLines = Math.ceil(summaryText.length / 80);

    if (estimatedLines > 5) {
      violations.push({
        check: "SUMMARY_TOO_LONG",
        severity: "warning",
        message: `Executive summary is ~${estimatedLines} lines (max: 5)`,
        location: "summary",
        details: `Summary should be max 5 lines for visual density compliance. Current: ~${summaryText.length} chars (~${estimatedLines} lines at 80 chars/line).`,
      });
    }
  }

  return violations;
}

export async function validateResumeFormatting(
  docxBuffer: Buffer,
  profile: {
    name?: string;
    email?: string;
    phone?: string;
    location?: string;
  },
  pageCount?: number,
): Promise<FormattingReport> {
  const xml = await extractDocxText(docxBuffer);
  const violations: FormattingViolation[] = [];
  let checksRun = 0;

  checksRun++;
  violations.push(...checkDuplicateHeadings(xml));

  checksRun++;
  violations.push(
    ...checkPlaceholders(xml, [
      profile.name || "",
      profile.email || "",
      profile.phone || "",
      profile.location || "",
    ].filter(Boolean)),
  );

  checksRun++;
  violations.push(...checkMissingContactInfo(xml, profile));

  checksRun++;
  violations.push(...checkBrokenLinks(xml));

  checksRun++;
  violations.push(...checkResumeSections(xml));

  if (pageCount !== undefined) {
    checksRun++;
    violations.push(...checkPageCount(pageCount, 2, "Resume"));
  }

  // ── Executive Quality Checks ──
  checksRun++;
  violations.push(...checkFillerPhrases(xml));

  checksRun++;
  violations.push(...checkBulletLength(xml));

  checksRun++;
  violations.push(...checkTotalBulletCount(xml));

  checksRun++;
  violations.push(...checkStackedMetrics(xml));

  checksRun++;
  violations.push(...checkChronologicalOrder(xml));

  checksRun++;
  violations.push(...checkPassivePhrasing(xml));

  checksRun++;
  violations.push(...checkSummaryLineCount(xml));

  const criticalCount = violations.filter((v) => v.severity === "critical").length;
  const warningCount = violations.filter((v) => v.severity === "warning").length;

  return {
    pass: criticalCount === 0,
    checksRun,
    criticalCount,
    warningCount,
    violations,
    documentType: "resume",
    timestamp: new Date().toISOString(),
  };
}

export async function validateCoverLetterFormatting(
  docxBuffer: Buffer,
  profile: {
    name?: string;
    email?: string;
    phone?: string;
    location?: string;
  },
  pageCount?: number,
): Promise<FormattingReport> {
  const xml = await extractDocxText(docxBuffer);
  const violations: FormattingViolation[] = [];
  let checksRun = 0;

  checksRun++;
  violations.push(...checkDuplicateHeadings(xml));

  checksRun++;
  violations.push(
    ...checkPlaceholders(xml, [
      profile.name || "",
      profile.email || "",
      profile.phone || "",
      profile.location || "",
    ].filter(Boolean)),
  );

  checksRun++;
  violations.push(...checkMissingContactInfo(xml, profile));

  checksRun++;
  violations.push(...checkBrokenLinks(xml));

  if (pageCount !== undefined) {
    checksRun++;
    violations.push(...checkPageCount(pageCount, 1, "Cover letter"));
  }

  const criticalCount = violations.filter((v) => v.severity === "critical").length;
  const warningCount = violations.filter((v) => v.severity === "warning").length;

  return {
    pass: criticalCount === 0,
    checksRun,
    criticalCount,
    warningCount,
    violations,
    documentType: "cover_letter",
    timestamp: new Date().toISOString(),
  };
}

export interface CombinedFormattingReport {
  pass: boolean;
  resumeReport: FormattingReport;
  coverLetterReport: FormattingReport;
  totalChecks: number;
  totalCritical: number;
  totalWarnings: number;
  totalViolations: number;
  blockSending: boolean;
  timestamp: string;
}

export async function validatePacketFormatting(
  resumeBuffer: Buffer,
  coverLetterBuffer: Buffer,
  profile: {
    name?: string;
    email?: string;
    phone?: string;
    location?: string;
  },
  resumePageCount?: number,
  coverLetterPageCount?: number,
): Promise<CombinedFormattingReport> {
  const [resumeReport, coverLetterReport] = await Promise.all([
    validateResumeFormatting(resumeBuffer, profile, resumePageCount),
    validateCoverLetterFormatting(coverLetterBuffer, profile, coverLetterPageCount),
  ]);

  const totalCritical = resumeReport.criticalCount + coverLetterReport.criticalCount;
  const totalWarnings = resumeReport.warningCount + coverLetterReport.warningCount;

  return {
    pass: totalCritical === 0,
    resumeReport,
    coverLetterReport,
    totalChecks: resumeReport.checksRun + coverLetterReport.checksRun,
    totalCritical,
    totalWarnings,
    totalViolations: totalCritical + totalWarnings,
    blockSending: totalCritical > 0,
    timestamp: new Date().toISOString(),
  };
}
