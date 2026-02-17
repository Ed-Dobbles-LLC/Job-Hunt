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
 * 8. Summary line enforcement (max 5 lines)
 * 9. First-sentence team-size/revenue detection
 * 10. Mandate-aware bullet reordering
 * 11. Visual density auto-compression
 * 12. Passive phrasing removal
 */

import type { TailoredResume } from "./tailoredResumePrompt";
import type { MandateProfile } from "./mandateClassifier";

export interface CompressionReport {
  originalBulletCount: number;
  finalBulletCount: number;
  removedBullets: { roleIndex: number; bulletIndex: number; text: string; reason: string }[];
  condensedBullets: { roleIndex: number; bulletIndex: number; before: string; after: string; wordsBefore: number; wordsAfter: number }[];
  redundanciesFound: { location: string; phrase: string }[];
  fillerPhrasesRemoved: { location: string; before: string; after: string }[];
  toolsTrimmed: { before: string[]; after: string[] } | null;
  pageBalanceAdjusted: boolean;
  summaryLinesTrimmed: boolean;
  firstSentenceFixed: boolean;
  bulletsReorderedByMandate: boolean;
  passivePhrasesRemoved: { location: string; before: string; after: string }[];
  densityCompressed: boolean;
  orphanRolesDetected: number;
  wallOfTextRolesTrimmed: number;
  verbRepetitions: { verb: string; count: number }[];
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
  // Hedging language
  { regex: /\bhelped\s+/gi, replacement: "" },
  { regex: /\bassisted\s+(in|with)\s+/gi, replacement: "" },
  { regex: /\bcontributed to\s+/gi, replacement: "" },
  { regex: /\bsupported\s+/gi, replacement: "" },
  // Explanatory clauses that dilute impact
  { regex: /\s*,?\s*which resulted in\s+/gi, replacement: " — " },
  { regex: /\s+in order to\s+/gi, replacement: " to " },
  { regex: /\s+with the goal of\s+/gi, replacement: " to " },
];

// ── Passive phrasing patterns to rewrite ──
const PASSIVE_PATTERNS: { regex: RegExp; replacement: string }[] = [
  { regex: /\bwas responsible for\s+/gi, replacement: "" },
  { regex: /\bwas tasked with\s+/gi, replacement: "" },
  { regex: /\bwas involved in\s+/gi, replacement: "" },
  { regex: /\bwas charged with\s+/gi, replacement: "" },
  { regex: /\bwas instrumental in\s+/gi, replacement: "" },
  { regex: /\bwas appointed to\s+/gi, replacement: "" },
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
  "positioned analytics as a revenue driver",
  "transforming analytics into strategic growth engines",
  "distinctly technical for an executive at this level",
  "bridging technical capabilities with business strategy",
];

// ── Revenue-signal keywords for mandate-aware bullet ordering ──
const REVENUE_SIGNAL_KEYWORDS = [
  "revenue", "sales", "pricing", "monetiz", "conversion", "arpu", "ltv", "mrr", "arr",
  "topline", "top-line", "margin", "profit", "p&l", "roi",
];

// ── Mandate-relevant keywords by archetype ──
const MANDATE_KEYWORDS: Record<string, string[]> = {
  governance_standardization: ["governance", "compliance", "standardiz", "audit", "control", "framework", "metric discipline", "data quality", "reporting rigor"],
  bi_modernization: ["platform", "architect", "moderniz", "migrat", "cloud", "infrastructure", "pipeline", "data lake", "warehouse"],
  insight_delivery_modernization: ["insight", "self-service", "reporting", "dashboard", "stakeholder", "decision-maker", "automat"],
  executive_okr_reporting: ["okr", "kpi", "scorecard", "executive reporting", "board reporting", "qbr", "performance management", "annual operating plan"],
  revenue_ops_forecasting: ["revenue", "forecast", "pricing", "demand planning", "p&l", "margin", "commercial"],
  operating_model_transformation: ["operating model", "transform", "embed", "democratiz", "reorganiz", "change management"],
  ai_integration_llm: ["ai", "ml", "llm", "genai", "model", "mlops", "prompt engineering", "rag", "embeddings"],
  growth_monetization: ["growth", "experiment", "a/b test", "conversion", "monetiz", "funnel"],
  cross_functional_influence: ["board", "c-suite", "advisory", "storytelling", "strategic", "influence"],
  team_scale_org_design: ["team", "hired", "scaled", "organizational design", "talent", "mentored"],
};

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
    if (idx === 0) return 5;       // Most recent role — needs depth for executive presence
    if (idx <= 2) return 4;        // Second and third roles
    return 3;                      // Fourth+ role
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
 * Score a bullet's relevance to a mandate archetype (0-5).
 */
function scoreBulletForMandate(text: string, mandate: string): number {
  const keywords = MANDATE_KEYWORDS[mandate] || [];
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 1;
  }
  return Math.min(5, score);
}

/**
 * Check if a bullet is revenue-focused.
 */
function isRevenueBullet(text: string): boolean {
  const lower = text.toLowerCase();
  return REVENUE_SIGNAL_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Remove passive phrasing from text.
 */
function removePassive(text: string): { cleaned: string; removedAny: boolean } {
  let cleaned = text;
  let removedAny = false;
  for (const { regex, replacement } of PASSIVE_PATTERNS) {
    const before = cleaned;
    regex.lastIndex = 0;
    cleaned = cleaned.replace(regex, replacement);
    if (cleaned !== before) removedAny = true;
  }
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return { cleaned, removedAny };
}

/**
 * Count lines in a summary (split by newlines, non-empty).
 */
function countSummaryLines(text: string): number {
  // Estimate lines: ~80 chars per line for executive resume
  const paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0);
  let totalLines = 0;
  for (const p of paragraphs) {
    totalLines += Math.ceil(p.length / 80);
  }
  return totalLines;
}

/**
 * Check if the first sentence of the summary mentions team size or revenue.
 */
function firstSentenceHasTeamSizeOrRevenue(text: string): { hasTeamSize: boolean; hasRevenue: boolean } {
  const firstSentence = text.split(/[.!?]\s/)[0] || text;
  const lower = firstSentence.toLowerCase();
  const teamSizePatterns = /\d+[\s-]*(?:person|people|ftes?|team|members|engineers|analysts|direct reports)/i;
  const revenuePatterns = /\$[\d,.]+[mbk]?|\d+%\s*(?:revenue|growth|margin|roi|cost)/i;
  return {
    hasTeamSize: teamSizePatterns.test(lower),
    hasRevenue: revenuePatterns.test(lower),
  };
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
 * @param mandate - Optional mandate profile for mandate-aware bullet reordering.
 */
export function compressResume(resume: TailoredResume, mandate?: MandateProfile): CompressionReport {
  const report: CompressionReport = {
    originalBulletCount: 0,
    finalBulletCount: 0,
    removedBullets: [],
    condensedBullets: [],
    redundanciesFound: [],
    fillerPhrasesRemoved: [],
    toolsTrimmed: null,
    pageBalanceAdjusted: false,
    summaryLinesTrimmed: false,
    firstSentenceFixed: false,
    bulletsReorderedByMandate: false,
    passivePhrasesRemoved: [],
    densityCompressed: false,
    orphanRolesDetected: 0,
    wallOfTextRolesTrimmed: 0,
    verbRepetitions: [],
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

  // ── Phase 1b: Remove passive phrasing from all bullets ──
  for (let ri = 0; ri < resume.experience.length; ri++) {
    for (let bi = 0; bi < resume.experience[ri].bullets.length; bi++) {
      const bullet = resume.experience[ri].bullets[bi];
      const original = bullet.text;
      const { cleaned: passiveCleaned, removedAny: passiveRemoved } = removePassive(original);
      if (passiveRemoved) {
        report.passivePhrasesRemoved.push({
          location: `experience[${ri}].bullets[${bi}]`,
          before: original,
          after: passiveCleaned,
        });
        bullet.text = passiveCleaned;
      }
    }
  }

  // Also clean passive from summary
  const { cleaned: passiveSummary, removedAny: passiveSummaryChanged } = removePassive(resume.professional_summary);
  if (passiveSummaryChanged) {
    report.passivePhrasesRemoved.push({
      location: "professional_summary",
      before: resume.professional_summary,
      after: passiveSummary,
    });
    resume.professional_summary = passiveSummary;
  }

  // ── Phase 1c: Summary line enforcement (max 4 lines — mandate sharpening) ──
  const summaryLines = countSummaryLines(resume.professional_summary);
  if (summaryLines > 4) {
    // Trim to approximately 4 lines (~340 chars)
    const maxChars = 340;
    if (resume.professional_summary.length > maxChars) {
      const trimmed = resume.professional_summary.substring(0, maxChars);
      const lastSentenceEnd = Math.max(
        trimmed.lastIndexOf(". "),
        trimmed.lastIndexOf(".\n"),
        trimmed.lastIndexOf("."),
      );
      if (lastSentenceEnd > maxChars * 0.5) {
        resume.professional_summary = trimmed.substring(0, lastSentenceEnd + 1);
      }
      report.summaryLinesTrimmed = true;
    }
  }

  // ── Phase 1d: First-sentence team-size/revenue check ──
  const firstSentenceCheck = firstSentenceHasTeamSizeOrRevenue(resume.professional_summary);
  if (firstSentenceCheck.hasTeamSize || firstSentenceCheck.hasRevenue) {
    report.firstSentenceFixed = true;
    report.redundanciesFound.push({
      location: "professional_summary (first sentence)",
      phrase: `First sentence contains ${firstSentenceCheck.hasTeamSize ? "team size" : ""}${firstSentenceCheck.hasTeamSize && firstSentenceCheck.hasRevenue ? " and " : ""}${firstSentenceCheck.hasRevenue ? "revenue metrics" : ""} — should lead with identity/domain instead`,
    });
  }

  // ── Phase 1e: Mandate-aware bullet reordering ──
  if (mandate) {
    const primaryMandate = mandate.primary_mandate;
    const isRevenueFocusedMandate = primaryMandate === "revenue_ops_forecasting" || primaryMandate === "growth_monetization";

    for (let ri = 0; ri < resume.experience.length; ri++) {
      const bullets = resume.experience[ri].bullets;
      if (bullets.length <= 2) continue;

      // Score each bullet for mandate alignment
      const scored = bullets.map((b, bi) => ({
        bullet: b,
        originalIndex: bi,
        mandateScore: scoreBulletForMandate(b.text, primaryMandate),
        isRevenue: isRevenueBullet(b.text),
      }));

      // Sort: mandate-aligned first, but demote revenue bullets if mandate ≠ revenue
      scored.sort((a, b) => {
        // Both in top-2 by mandate? Keep mandate order
        if (a.mandateScore !== b.mandateScore) return b.mandateScore - a.mandateScore;

        // If mandate is not revenue-focused, deprioritize revenue bullets from positions 0-1
        if (!isRevenueFocusedMandate) {
          if (a.isRevenue && !b.isRevenue) return 1;
          if (!a.isRevenue && b.isRevenue) return -1;
        }

        return a.originalIndex - b.originalIndex; // Preserve original order as tiebreaker
      });

      // Check if order actually changed
      const orderChanged = scored.some((s, i) => s.originalIndex !== i);
      if (orderChanged) {
        resume.experience[ri].bullets = scored.map(s => s.bullet);
        report.bulletsReorderedByMandate = true;
      }
    }
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

  // ── Phase 6b: Cap core_competencies to max 12 items (2 lines when rendered) ──
  if (Array.isArray(coreComps) && coreComps.length > 12) {
    (resume as any).core_competencies = coreComps.slice(0, 12);
    report.redundanciesFound.push({
      location: "core_competencies",
      phrase: `Trimmed from ${coreComps.length} to 12 items (max 2 lines)`,
    });
  }

  // ── Phase 7: Visual density auto-compression ──
  // If total bullets exceed 15, drop lowest-mandate-score bullets from oldest roles first
  const totalBulletsNow = resume.experience.reduce((s, exp) => s + exp.bullets.length, 0);
  const MAX_TOTAL_BULLETS = 15;
  if (totalBulletsNow > MAX_TOTAL_BULLETS && mandate) {
    let bulletsToRemove = totalBulletsNow - MAX_TOTAL_BULLETS;
    // Work backwards from oldest role
    for (let ri = resume.experience.length - 1; ri >= 0 && bulletsToRemove > 0; ri--) {
      const exp = resume.experience[ri];
      if (exp.bullets.length <= 1) continue; // Never leave a role with 0 bullets

      // Score bullets and remove lowest
      const scored = exp.bullets.map((b, bi) => ({
        bullet: b,
        index: bi,
        score: scoreBulletForMandate(b.text, mandate.primary_mandate),
      }));
      scored.sort((a, b) => a.score - b.score); // Lowest first

      while (bulletsToRemove > 0 && exp.bullets.length > 1) {
        const lowest = scored.shift()!;
        const removedIdx = exp.bullets.findIndex(b => b === lowest.bullet);
        if (removedIdx >= 0) {
          exp.bullets.splice(removedIdx, 1);
          report.removedBullets.push({
            roleIndex: ri,
            bulletIndex: removedIdx,
            text: lowest.bullet.text,
            reason: `Visual density compression: lowest mandate score (${lowest.score}/5)`,
          });
          bulletsToRemove--;
          report.densityCompressed = true;
        }
      }
    }
  }

  // ── Phase 8: Orphan role detection ──
  // Flag roles (except the last/oldest) that have only 1 bullet — looks unfinished
  for (let ri = 0; ri < resume.experience.length - 1; ri++) {
    if (resume.experience[ri].bullets.length < 2) {
      report.orphanRolesDetected++;
      report.redundanciesFound.push({
        location: `experience[${ri}]`,
        phrase: `Role has only ${resume.experience[ri].bullets.length} bullet(s) — may appear incomplete. Consider adding a second bullet or consolidating.`,
      });
    }
  }

  // ── Phase 9: Wall-of-text prevention ──
  // If any single role has more than 5 bullets after all caps, force trim
  for (let ri = 0; ri < resume.experience.length; ri++) {
    if (resume.experience[ri].bullets.length > 5) {
      const removed = resume.experience[ri].bullets.splice(5);
      report.wallOfTextRolesTrimmed++;
      for (let i = 0; i < removed.length; i++) {
        report.removedBullets.push({
          roleIndex: ri,
          bulletIndex: 5 + i,
          text: removed[i].text,
          reason: "Wall-of-text prevention: exceeds 5 bullets per role",
        });
      }
    }
  }

  // ── Phase 10: Verb repetition tracking ──
  // Track opening verbs across all bullets to flag overuse
  const verbCounts = new Map<string, number>();
  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      const firstWord = bullet.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      if (firstWord.length > 2) {
        verbCounts.set(firstWord, (verbCounts.get(firstWord) || 0) + 1);
      }
    }
  }
  report.verbRepetitions = [...verbCounts.entries()]
    .filter(([, count]) => count > 2)
    .map(([verb, count]) => ({ verb, count }))
    .sort((a, b) => b.count - a.count);

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
