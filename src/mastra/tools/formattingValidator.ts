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

const RESUME_REQUIRED_SECTIONS = [
  "PROFESSIONAL SUMMARY",
  "EXPERIENCE",
  "SKILLS",
  "EDUCATION",
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
    if (!allText.includes(section)) {
      violations.push({
        check: "MISSING_SECTION",
        severity: "critical",
        message: `Required section "${section}" not found`,
        location: "document",
        details: `The ${section} section is required in a resume. Ensure it is present with the correct heading.`,
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
