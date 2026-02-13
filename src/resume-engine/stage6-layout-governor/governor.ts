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

// ── Governor Result ──────────────────────────────────────────────

export interface GovernorResult {
  resume: TailoredResume;
  compression_report: CompressionReport;
  chronology_reordered: boolean;
  bullet_cap_result: BulletCapResult;
  word_limit_truncations: string[];
  filler_removals: string[];
  duration_ms: number;
}

/**
 * Run all layout governance checks on a resume.
 * Mutates the resume in place and returns a report.
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

  return {
    resume,
    compression_report: compressionReport,
    chronology_reordered: chronologyReordered,
    bullet_cap_result: bulletCapResult,
    word_limit_truncations: wordLimitTruncations,
    filler_removals: fillerRemovals,
    duration_ms: Date.now() - start,
  };
}
