/**
 * Stage 6: Layout Governor
 *
 * Deterministic enforcement of all formatting rules:
 * - Bullet caps per role
 * - Word limits per bullet
 * - Filler phrase removal
 * - Reverse chronological ordering
 * - Section length limits
 * - Passive voice stripping
 *
 * Wraps and extends the existing resumeCompressor.
 *
 * Type: DETERMINISTIC (no LLM calls)
 */

import { compressResume, type CompressionReport } from "../../mastra/tools/resumeCompressor";
import type { TailoredResume } from "../../mastra/tools/tailoredResumePrompt";
import type { MandateProfile } from "../stage2-mandate-classifier/classifier";

// ── Filler Phrases ───────────────────────────────────────────────

const FILLER_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bserving as\b/gi, replacement: "" },
  { pattern: /\bknown for\b/gi, replacement: "" },
  { pattern: /\bresponsible for\b/gi, replacement: "" },
  { pattern: /\bplayed a key role in\b/gi, replacement: "" },
  { pattern: /\bcore member of\b/gi, replacement: "" },
  { pattern: /\bcareer defined by\b/gi, replacement: "" },
  { pattern: /\bstrategically\b/gi, replacement: "" },
  { pattern: /\bholistically\b/gi, replacement: "" },
  { pattern: /\bcomprehensively\b/gi, replacement: "" },
  { pattern: /\beffectively\b/gi, replacement: "" },
  { pattern: /\bsuccessfully\b/gi, replacement: "" },
  { pattern: /\bin order to\b/gi, replacement: "to" },
  { pattern: /\bwith the goal of\b/gi, replacement: "to" },
  { pattern: /\bwhich resulted in\b/gi, replacement: "—" },
  { pattern: /\bwas responsible for\b/gi, replacement: "" },
  { pattern: /\bwas tasked with\b/gi, replacement: "" },
  { pattern: /\bwas involved in\b/gi, replacement: "" },
];

// ── Soft Verb Detection (Bullet Tone Refinement) ────────────────

const SOFT_VERBS = [
  "supported", "helped", "contributed", "assisted",
  "participated", "aided", "facilitated",
];

const PASSIVE_STARTERS = [
  /^was\s+/i,
  /^were\s+/i,
  /^has been\s+/i,
  /^have been\s+/i,
  /^had been\s+/i,
  /^being\s+/i,
];

// ── Chronology Enforcer ──────────────────────────────────────────

function parseDate(dateStr: string): number {
  if (!dateStr || dateStr.toLowerCase() === "present") return Date.now();
  const match = dateStr.match(/(\d{4})[-/]?(\d{2})?/);
  if (!match) return 0;
  const year = parseInt(match[1]);
  const month = match[2] ? parseInt(match[2]) : 1;
  return new Date(year, month - 1).getTime();
}

function enforceReverseChronological(resume: TailoredResume): boolean {
  let reordered = false;
  const sorted = [...resume.experience].sort((a, b) => {
    const dateA = parseDate(a.end_date);
    const dateB = parseDate(b.end_date);
    return dateB - dateA;
  });

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== resume.experience[i]) {
      reordered = true;
      break;
    }
  }

  if (reordered) {
    resume.experience = sorted;
  }
  return reordered;
}

// ── Bullet Cap Enforcement ───────────────────────────────────────

interface BulletCapResult {
  capped: boolean;
  original_count: number;
  final_count: number;
  details: string[];
}

function enforceBulletCaps(resume: TailoredResume): BulletCapResult {
  const details: string[] = [];
  let capped = false;
  let originalCount = 0;
  let finalCount = 0;

  const currentYear = new Date().getFullYear();

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];
    const bulletsBefore = exp.bullets.length;
    originalCount += bulletsBefore;

    // Determine max bullets based on recency
    let maxBullets: number;
    if (i === 0) {
      maxBullets = 4; // Most recent role
    } else if (i <= 2) {
      maxBullets = 3; // 2nd and 3rd roles
    } else {
      // Check if older than 15 years
      const startYear = parseInt(exp.start_date?.match(/\d{4}/)?.[0] || "0");
      maxBullets = (currentYear - startYear > 15) ? 2 : 3;
    }

    if (exp.bullets.length > maxBullets) {
      exp.bullets = exp.bullets.slice(0, maxBullets);
      details.push(`${exp.employer}: ${bulletsBefore} → ${maxBullets} bullets`);
      capped = true;
    }

    finalCount += exp.bullets.length;
  }

  // Total cap: 13-15 bullets
  if (finalCount > 15) {
    // Trim from oldest roles first
    let excess = finalCount - 15;
    for (let i = resume.experience.length - 1; i >= 0 && excess > 0; i--) {
      const exp = resume.experience[i];
      while (exp.bullets.length > 2 && excess > 0) {
        exp.bullets.pop();
        excess--;
        finalCount--;
      }
    }
    if (excess > 0) {
      details.push(`Total bullets still ${finalCount + excess}, could not trim below 15`);
    }
    capped = true;
  }

  return { capped, original_count: originalCount, final_count: finalCount, details };
}

// ── Word Limit Enforcement ───────────────────────────────────────

function enforceWordLimits(resume: TailoredResume): string[] {
  const truncated: string[] = [];

  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      const words = bullet.text.split(/\s+/);
      if (words.length > 22) {
        bullet.text = words.slice(0, 22).join(" ");
        // Ensure it ends cleanly
        if (!bullet.text.match(/[.!?]$/)) {
          bullet.text = bullet.text.replace(/[,;:\s]+$/, "");
        }
        truncated.push(`${exp.employer}: "${bullet.text.substring(0, 50)}..." (was ${words.length} words)`);
      }
    }
  }

  return truncated;
}

// ── Filler Removal ───────────────────────────────────────────────

function removeFiller(resume: TailoredResume): string[] {
  const removed: string[] = [];

  function cleanText(text: string, location: string): string {
    let cleaned = text;
    for (const { pattern, replacement } of FILLER_PATTERNS) {
      const before = cleaned;
      cleaned = cleaned.replace(pattern, replacement);
      if (cleaned !== before) {
        removed.push(`${location}: removed "${before.match(pattern)?.[0]}"`);
      }
    }
    // Clean up double spaces
    cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
    // Capitalize first letter if it became lowercase
    if (cleaned.length > 0 && cleaned[0] !== cleaned[0].toUpperCase()) {
      cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
    }
    return cleaned;
  }

  resume.professional_summary = cleanText(resume.professional_summary, "summary");

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      resume.experience[i].bullets[j].text = cleanText(
        resume.experience[i].bullets[j].text,
        `experience[${i}].bullets[${j}]`,
      );
    }
  }

  return removed;
}

// ── Bullet Tone Refinement ───────────────────────────────────────

interface ToneViolation {
  location: string;
  issue: string;
  original: string;
}

/**
 * Bullet Tone Refinement Pass:
 * - Detect soft verbs (supported, helped, contributed, etc.)
 * - Detect passive voice starters
 * - Detect stacked clauses (3+ commas = over-complex)
 * - Each bullet should read like a board-level performance summary
 */
function refineBulletTone(resume: TailoredResume): ToneViolation[] {
  const violations: ToneViolation[] = [];

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const text = bullet.text;
      const loc = `experience[${i}].bullets[${j}]`;

      // Check soft verbs at start of bullet
      const firstWord = text.split(/\s+/)[0]?.toLowerCase() || "";
      if (SOFT_VERBS.includes(firstWord)) {
        violations.push({
          location: loc,
          issue: `soft_verb_opener: "${firstWord}"`,
          original: text.substring(0, 60),
        });
      }

      // Check passive voice starters
      for (const pattern of PASSIVE_STARTERS) {
        if (pattern.test(text)) {
          violations.push({
            location: loc,
            issue: "passive_voice_opener",
            original: text.substring(0, 60),
          });
          break;
        }
      }

      // Check stacked clauses (3+ commas indicate over-complexity)
      const commaCount = (text.match(/,/g) || []).length;
      if (commaCount >= 3) {
        violations.push({
          location: loc,
          issue: `stacked_clauses: ${commaCount} commas`,
          original: text.substring(0, 60),
        });
      }
    }
  }

  return violations;
}

// ── Competency Cap Enforcement ──────────────────────────────────

function enforceCompetencyCap(resume: TailoredResume): boolean {
  const comps = (resume as any).core_competencies;
  if (!Array.isArray(comps)) return false;
  if (comps.length > 12) {
    (resume as any).core_competencies = comps.slice(0, 12);
    return true;
  }
  return false;
}

// ── Scope Line Enforcement ──────────────────────────────────────

function enforceScopeLines(resume: TailoredResume): string[] {
  const fixes: string[] = [];

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i] as any;
    if (!exp.scope_line) continue;

    // Scope line must be 1 line max (~100 chars)
    if (exp.scope_line.length > 120) {
      const truncated = exp.scope_line.substring(0, 115).replace(/\s*\|?\s*$/, "");
      fixes.push(`experience[${i}].scope_line truncated: ${exp.scope_line.length} → ${truncated.length} chars`);
      exp.scope_line = truncated;
    }
  }

  return fixes;
}

// ── Summary Density Enforcement ─────────────────────────────────

/**
 * Enforce the 5-line max for professional summary.
 * Counts logical lines (split by newlines, then by ~80 char wrapping).
 */
function enforceSummaryDensity(resume: TailoredResume): boolean {
  const summary = resume.professional_summary;
  const lines = summary.split(/\n/).filter(l => l.trim().length > 0);

  // Estimate rendered line count (assuming ~80 chars per line)
  let estimatedLines = 0;
  for (const line of lines) {
    estimatedLines += Math.max(1, Math.ceil(line.length / 80));
  }

  if (estimatedLines > 5) {
    // Trim from the end of the last paragraph
    const paragraphs = summary.split(/\n\n/);
    if (paragraphs.length > 3) {
      resume.professional_summary = paragraphs.slice(0, 3).join("\n\n");
      return true;
    }
    // If 3 or fewer paragraphs but still too long, trim last paragraph
    if (paragraphs.length >= 2) {
      const lastPara = paragraphs[paragraphs.length - 1];
      const words = lastPara.split(/\s+/);
      if (words.length > 20) {
        paragraphs[paragraphs.length - 1] = words.slice(0, 20).join(" ");
        resume.professional_summary = paragraphs.join("\n\n");
        return true;
      }
    }
  }

  return false;
}

// ── Deterministic Page Estimator ────────────────────────────────

/**
 * Estimates the number of pages a resume will occupy when rendered.
 *
 * Page budget (approximate, based on standard resume formatting):
 * - Header (name + contact): ~3 lines
 * - Executive headline: ~1 line
 * - Summary: lines (estimated from char count)
 * - Core competencies: ~2 lines
 * - Per role: title/company/location/dates = 2 lines, scope_line = 1 line, each bullet = 1.5 lines
 * - Education: ~2 lines per entry
 * - Certifications: ~1 line per entry
 * - Skills section: ~2-3 lines
 *
 * Standard page ~= 48 lines (11pt, 1" margins, standard resume layout)
 */
interface PageEstimate {
  estimated_lines: number;
  estimated_pages: number;
  section_breakdown: Record<string, number>;
  exceeds_2_pages: boolean;
}

function estimatePages(resume: TailoredResume): PageEstimate {
  const LINES_PER_PAGE = 48;
  const breakdown: Record<string, number> = {};
  let totalLines = 0;

  // Header (name, contact info, LinkedIn)
  breakdown.header = 3;
  totalLines += 3;

  // Executive headline
  if ((resume as any).executive_headline) {
    breakdown.headline = 1;
    totalLines += 1;
  }

  // Summary (estimate based on character count)
  const summaryChars = resume.professional_summary.length;
  const summaryLines = Math.ceil(summaryChars / 75); // ~75 chars per line in resume font
  breakdown.summary = summaryLines;
  totalLines += summaryLines;

  // Spacing after summary
  totalLines += 1;

  // Core competencies
  const comps = ((resume as any).core_competencies || []) as string[];
  const compLines = Math.ceil(comps.join(" | ").length / 75);
  breakdown.competencies = Math.max(2, compLines);
  totalLines += breakdown.competencies;

  // Spacing
  totalLines += 1;

  // Experience
  let expLines = 0;
  for (const exp of resume.experience) {
    expLines += 2; // title | company + location | dates
    if ((exp as any).scope_line) expLines += 1;
    for (const bullet of exp.bullets) {
      // Each bullet: estimate 1-2 lines based on word count
      const words = bullet.text.split(/\s+/).length;
      expLines += words > 15 ? 2 : 1;
    }
    expLines += 0.5; // spacing between roles
  }
  breakdown.experience = Math.ceil(expLines);
  totalLines += Math.ceil(expLines);

  // Education
  const eduEntries = (resume as any).education || [];
  breakdown.education = eduEntries.length * 2;
  totalLines += breakdown.education;

  // Certifications
  const certEntries = (resume as any).certifications || [];
  breakdown.certifications = Math.ceil(certEntries.length / 2); // 2 per line typically
  totalLines += breakdown.certifications;

  // Skills
  breakdown.skills = 3;
  totalLines += 3;

  // Section headers and spacing
  const sectionCount = 5; // experience, education, certs, skills, competencies
  breakdown.section_spacing = sectionCount;
  totalLines += sectionCount;

  const estimatedPages = totalLines / LINES_PER_PAGE;

  return {
    estimated_lines: Math.ceil(totalLines),
    estimated_pages: Math.round(estimatedPages * 10) / 10,
    section_breakdown: breakdown,
    exceeds_2_pages: estimatedPages > 2.0,
  };
}

/**
 * Attempt to compress the resume to fit within 2 pages.
 * Strategy (in order):
 * 1. Drop lowest mandate-scoring bullets from oldest roles
 * 2. Compress older roles before recent
 * 3. Trim competencies to 10
 * 4. Trim summary to 4 lines
 *
 * Returns null if still over budget after all compression.
 */
function compressToPageBudget(resume: TailoredResume): { compressed: boolean; blocked: boolean; actions: string[] } {
  const actions: string[] = [];
  let estimate = estimatePages(resume);

  if (!estimate.exceeds_2_pages) {
    return { compressed: false, blocked: false, actions: [] };
  }

  // Step 1: Drop lowest bullets from oldest roles (keep minimum 2 per role)
  for (let i = resume.experience.length - 1; i >= 1 && estimate.exceeds_2_pages; i--) {
    const exp = resume.experience[i];
    while (exp.bullets.length > 2 && estimate.exceeds_2_pages) {
      exp.bullets.pop();
      actions.push(`Dropped bullet from ${exp.employer} (role ${i})`);
      estimate = estimatePages(resume);
    }
  }

  // Step 2: Reduce most recent role to 3 bullets if still over
  if (estimate.exceeds_2_pages && resume.experience[0]?.bullets.length > 3) {
    resume.experience[0].bullets = resume.experience[0].bullets.slice(0, 3);
    actions.push(`Reduced most recent role to 3 bullets`);
    estimate = estimatePages(resume);
  }

  // Step 3: Trim competencies to 10
  const comps = (resume as any).core_competencies;
  if (estimate.exceeds_2_pages && Array.isArray(comps) && comps.length > 10) {
    (resume as any).core_competencies = comps.slice(0, 10);
    actions.push(`Trimmed competencies from ${comps.length} to 10`);
    estimate = estimatePages(resume);
  }

  // Step 4: Trim summary
  if (estimate.exceeds_2_pages) {
    const paragraphs = resume.professional_summary.split(/\n\n/);
    if (paragraphs.length > 2) {
      resume.professional_summary = paragraphs.slice(0, 2).join("\n\n");
      actions.push(`Trimmed summary to 2 paragraphs`);
      estimate = estimatePages(resume);
    }
  }

  // Step 5: Drop oldest roles if still over (keep most recent 5)
  if (estimate.exceeds_2_pages && resume.experience.length > 5) {
    const removed = resume.experience.length - 5;
    resume.experience = resume.experience.slice(0, 5);
    actions.push(`Dropped ${removed} oldest role(s) to fit 2-page budget`);
    estimate = estimatePages(resume);
  }

  // If still over 2 pages after all compression → BLOCKED
  if (estimate.exceeds_2_pages) {
    return { compressed: true, blocked: true, actions };
  }

  return { compressed: true, blocked: false, actions };
}

// ── Governor Result ──────────────────────────────────────────────

export interface GovernorResult {
  resume: TailoredResume;
  compression_report: CompressionReport;
  chronology_reordered: boolean;
  bullet_cap_result: BulletCapResult;
  word_limit_truncations: string[];
  filler_removals: string[];
  tone_violations: ToneViolation[];
  competency_capped: boolean;
  scope_line_fixes: string[];
  summary_trimmed: boolean;
  page_estimate: PageEstimate;
  page_budget_actions: string[];
  blocked: boolean;
  duration_ms: number;
}

/**
 * Run all layout governance checks on a resume.
 * Mutates the resume in place and returns a report.
 *
 * Returns blocked=true if the resume cannot fit within 2 pages
 * after exhausting all deterministic compression strategies.
 */
export function governLayout(resume: TailoredResume, mandate: MandateProfile): GovernorResult {
  const start = Date.now();

  // 1. Reverse chronological ordering
  const chronologyReordered = enforceReverseChronological(resume);

  // 2. Run existing compression (mandate-aware bullet reordering + filler removal)
  const compressionReport = compressResume(resume, mandate);

  // 3. Enforce bullet caps
  const bulletCapResult = enforceBulletCaps(resume);

  // 4. Word limit enforcement
  const wordLimitTruncations = enforceWordLimits(resume);

  // 5. Additional filler removal
  const fillerRemovals = removeFiller(resume);

  // 6. Bullet tone refinement pass
  const toneViolations = refineBulletTone(resume);

  // 7. Competency cap (10-12)
  const competencyCapped = enforceCompetencyCap(resume);

  // 8. Scope line enforcement (1 line max, ~120 chars)
  const scopeLineFixes = enforceScopeLines(resume);

  // 9. Summary density enforcement (max 5 lines)
  const summaryTrimmed = enforceSummaryDensity(resume);

  // 10. Page estimation + compression to 2-page budget
  const pageBudget = compressToPageBudget(resume);
  const pageEstimate = estimatePages(resume);

  return {
    resume,
    compression_report: compressionReport,
    chronology_reordered: chronologyReordered,
    bullet_cap_result: bulletCapResult,
    word_limit_truncations: wordLimitTruncations,
    filler_removals: fillerRemovals,
    tone_violations: toneViolations,
    competency_capped: competencyCapped,
    scope_line_fixes: scopeLineFixes,
    summary_trimmed: summaryTrimmed,
    page_estimate: pageEstimate,
    page_budget_actions: pageBudget.actions,
    blocked: pageBudget.blocked,
    duration_ms: Date.now() - start,
  };
}
