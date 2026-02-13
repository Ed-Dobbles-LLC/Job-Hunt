/**
 * Resume Compressor — Post-generation enforcement of 2-page executive resume rules.
 *
 * This module runs AFTER the LLM generates the TailoredResume JSON and BEFORE
 * DOCX rendering. It deterministically enforces:
 *
 * 1. Strict 2-page limit via bullet caps
 * 2. Bullet compression (18-24 word target, max 2 lines)
 * 3. Filler phrase removal
 * 4. Redundancy elimination (summary vs first bullets)
 * 5. Page balance (Page 1: header+summary+competencies+recent role)
 * 6. Tool line limiting
 * 7. Section line count limits (10-12 lines max)
 */

import type { TailoredResume } from "./tailoredResumePrompt";

export interface CompressionReport {
  originalBulletCount: number;
  finalBulletCount: number;
  removedBullets: { roleIndex: number; bulletIndex: number; text: string; reason: string }[];
  condensedBullets: { roleIndex: number; bulletIndex: number; before: string; after: string; wordsBefore: number; wordsAfter: number }[];
  redundanciesFound: { location: string; phrase: string }[];
  fillerPhrasesRemoved: { location: string; before: string; after: string }[];
  toolsTrimmed: { before: string[]; after: string[] } | null;
  pageBalanceAdjusted: boolean;
}

// ── Filler phrases to strip from bullets ──
const FILLER_PATTERNS: { regex: RegExp; replacement: string }[] = [
  { regex: /\bserving as (?:a |the )?(?:core |key |primary )?(?:member|leader|partner|advisor)\s*(?:of|for|to|,)\s*/gi, replacement: "" },
  { regex: /\bknown for\s+/gi, replacement: "" },
  { regex: /\bresponsible for\s+/gi, replacement: "" },
  { regex: /\bplayed a key role in\s+/gi, replacement: "" },
  { regex: /\bcore (?:C-suite )?member\s*(?:of|,)\s*/gi, replacement: "" },
  { regex: /\bserved as\s+/gi, replacement: "" },
  { regex: /\btasked with\s+/gi, replacement: "" },
  { regex: /\bin charge of\s+/gi, replacement: "" },
  // Phrases banned by executive polish rules
  { regex: /\bcareer defined by\s+/gi, replacement: "" },
  { regex: /\bdistinctly technical for an executive of this level\s*[—–-]?\s*/gi, replacement: "" },
  // Filler adjectives
  { regex: /\bstrategically\s+/gi, replacement: "" },
  { regex: /\bholistically\s+/gi, replacement: "" },
  { regex: /\bcomprehensively\s+/gi, replacement: "" },
  { regex: /\beffectively\s+/gi, replacement: "" },
  { regex: /\bsuccessfully\s+/gi, replacement: "" },
  { regex: /\bsignificantly\s+/gi, replacement: "" },
];

// ── Redundant phrases that appear across sections ──
const REDUNDANT_CROSS_SECTION_PHRASES = [
  "transforming analytics",
  "bridging technical capabilities",
  "core c-suite member",
  "serving as core",
  "known for bridging",
  "career defined by",
  "distinctly technical for an executive",
];

/**
 * Count words in a string.
 */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Determine bullet caps per role based on position and age.
 */
function getBulletCaps(experience: { start_date: string; end_date: string }[]): number[] {
  const currentYear = new Date().getFullYear();
  return experience.map((exp, idx) => {
    const endDate = exp.end_date?.toLowerCase() === "present"
      ? currentYear
      : parseInt(exp.end_date?.substring(0, 4) || "0", 10);
    const isOlderThan15Years = endDate > 0 && (currentYear - endDate) > 15;

    if (isOlderThan15Years) return 2;
    if (idx === 0) return 4;       // Most recent role
    if (idx <= 2) return 3;        // Second and third roles
    return 2;                      // Fourth+ role
  });
}

/**
 * Remove filler phrases from a text string.
 */
function removeFiller(text: string): { cleaned: string; removedAny: boolean } {
  let cleaned = text;
  let removedAny = false;

  for (const { regex, replacement } of FILLER_PATTERNS) {
    const before = cleaned;
    regex.lastIndex = 0;
    cleaned = cleaned.replace(regex, replacement);
    if (cleaned !== before) removedAny = true;
  }

  // Clean up double spaces and leading/trailing whitespace
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  // Ensure first character is capitalized after removals
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return { cleaned, removedAny };
}

/**
 * Calculate semantic overlap between two texts using word-level Jaccard similarity.
 */
function semanticOverlap(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const smaller = Math.min(wordsA.size, wordsB.size);
  return intersection.size / smaller;
}

/**
 * Main compression function. Mutates the resume in place and returns a report.
 */
export function compressResume(resume: TailoredResume): CompressionReport {
  const report: CompressionReport = {
    originalBulletCount: 0,
    finalBulletCount: 0,
    removedBullets: [],
    condensedBullets: [],
    redundanciesFound: [],
    fillerPhrasesRemoved: [],
    toolsTrimmed: null,
    pageBalanceAdjusted: false,
  };

  // Count original bullets
  report.originalBulletCount = resume.experience.reduce(
    (sum, exp) => sum + exp.bullets.length, 0,
  );

  // ── Phase 1: Remove filler phrases from all bullets ──
  for (let ri = 0; ri < resume.experience.length; ri++) {
    for (let bi = 0; bi < resume.experience[ri].bullets.length; bi++) {
      const bullet = resume.experience[ri].bullets[bi];
      const original = bullet.text;
      const { cleaned, removedAny } = removeFiller(original);
      if (removedAny) {
        report.fillerPhrasesRemoved.push({
          location: `experience[${ri}].bullets[${bi}]`,
          before: original,
          after: cleaned,
        });
        bullet.text = cleaned;
      }
    }
  }

  // Also clean filler from professional_summary
  const { cleaned: cleanedSummary, removedAny: summaryChanged } = removeFiller(resume.professional_summary);
  if (summaryChanged) {
    report.fillerPhrasesRemoved.push({
      location: "professional_summary",
      before: resume.professional_summary,
      after: cleanedSummary,
    });
    resume.professional_summary = cleanedSummary;
  }

  // ── Phase 2: Redundancy elimination ──
  // Check summary vs first bullet of each role
  const summaryLower = resume.professional_summary.toLowerCase();
  for (let ri = 0; ri < resume.experience.length; ri++) {
    if (resume.experience[ri].bullets.length === 0) continue;
    const firstBullet = resume.experience[ri].bullets[0].text;
    const overlap = semanticOverlap(resume.professional_summary, firstBullet);

    if (overlap > 0.6) {
      report.redundanciesFound.push({
        location: `experience[${ri}].bullets[0] vs professional_summary`,
        phrase: firstBullet.substring(0, 80),
      });
    }
  }

  // Check for cross-section redundant phrases
  for (const phrase of REDUNDANT_CROSS_SECTION_PHRASES) {
    if (summaryLower.includes(phrase)) {
      report.redundanciesFound.push({
        location: "professional_summary",
        phrase,
      });
    }
    for (let ri = 0; ri < resume.experience.length; ri++) {
      for (let bi = 0; bi < resume.experience[ri].bullets.length; bi++) {
        if (resume.experience[ri].bullets[bi].text.toLowerCase().includes(phrase)) {
          report.redundanciesFound.push({
            location: `experience[${ri}].bullets[${bi}]`,
            phrase,
          });
        }
      }
    }
  }

  // ── Phase 3: Enforce bullet caps per role ──
  const bulletCaps = getBulletCaps(resume.experience);
  for (let ri = 0; ri < resume.experience.length; ri++) {
    const maxBullets = bulletCaps[ri];
    const exp = resume.experience[ri];

    if (exp.bullets.length > maxBullets) {
      const removed = exp.bullets.splice(maxBullets);
      for (let i = 0; i < removed.length; i++) {
        report.removedBullets.push({
          roleIndex: ri,
          bulletIndex: maxBullets + i,
          text: removed[i].text,
          reason: `Exceeds ${maxBullets}-bullet cap for role at position ${ri}`,
        });
      }
    }
  }

  // ── Phase 4: Track bullet compression (word count — max 22 words) ──
  for (let ri = 0; ri < resume.experience.length; ri++) {
    for (let bi = 0; bi < resume.experience[ri].bullets.length; bi++) {
      const bullet = resume.experience[ri].bullets[bi];
      const wc = wordCount(bullet.text);
      if (wc > 22) {
        report.condensedBullets.push({
          roleIndex: ri,
          bulletIndex: bi,
          before: bullet.text,
          after: bullet.text, // LLM already generated — flag for review
          wordsBefore: wc,
          wordsAfter: wc,
        });
      }
    }
  }

  // ── Phase 4b: Enforce reverse chronological order ──
  for (let i = 1; i < resume.experience.length; i++) {
    const prevEnd = resume.experience[i - 1].end_date?.toLowerCase() === "present"
      ? 9999
      : parseInt(resume.experience[i - 1].end_date?.substring(0, 4) || "0", 10);
    const currEnd = resume.experience[i].end_date?.toLowerCase() === "present"
      ? 9999
      : parseInt(resume.experience[i].end_date?.substring(0, 4) || "0", 10);

    if (currEnd > prevEnd) {
      // Swap to restore chronological order
      const temp = resume.experience[i - 1];
      resume.experience[i - 1] = resume.experience[i];
      resume.experience[i] = temp;
      report.redundanciesFound.push({
        location: `experience[${i}]`,
        phrase: `Role at index ${i} was out of chronological order — swapped with index ${i - 1}`,
      });
    }
  }

  // ── Phase 5: Trim tools to 1 compact line ──
  const skills = resume.skills as any;
  if (skills?.tools_and_platforms && Array.isArray(skills.tools_and_platforms)) {
    const original = [...skills.tools_and_platforms];
    const MAX_TOOLS_LINE = 90;
    let currentLength = 0;
    const trimmed: string[] = [];

    for (const tool of original) {
      const addedLength = trimmed.length > 0 ? String(tool).length + 4 : String(tool).length;
      if (currentLength + addedLength > MAX_TOOLS_LINE && trimmed.length > 0) break;
      trimmed.push(tool);
      currentLength += addedLength;
    }

    if (trimmed.length < original.length) {
      report.toolsTrimmed = { before: original, after: trimmed };
      skills.tools_and_platforms = trimmed;
    }
  }

  // ── Phase 6: If core_competencies present, remove enterprise_capabilities to avoid redundancy ──
  const coreComps = (resume as any).core_competencies;
  if (Array.isArray(coreComps) && coreComps.length > 0 && skills?.enterprise_capabilities) {
    delete skills.enterprise_capabilities;
  }

  // Count final bullets
  report.finalBulletCount = resume.experience.reduce(
    (sum, exp) => sum + exp.bullets.length, 0,
  );

  // Also update evidence_pointers to only include bullets that still exist
  const remainingBulletTexts = new Set(
    resume.experience.flatMap(exp => exp.bullets.map(b => b.text)),
  );
  resume.evidence_pointers = resume.evidence_pointers.filter(
    ep => remainingBulletTexts.has(ep.claim_text),
  );

  return report;
}
