/**
 * QA Gate — Final quality assurance pass before PDF rendering.
 *
 * Runs AFTER all pipeline stages (1-7) and before DOCX/PDF output.
 * Catches corruption, malformed tokens, hype residuals, and structural
 * issues that survived the pipeline.
 *
 * Type: DETERMINISTIC (no LLM calls)
 *
 * Checks:
 *   1. Verb Integrity    — detect malformed words from failed string operations
 *   2. Corruption Scan   — doubled suffixes, orphaned fragments, non-ASCII
 *   3. Hype Residuals    — any hype words that survived suppression
 *   4. Phrase Duplication — exact duplicate phrases across sections
 *   5. Page Validation    — within 2-page budget
 *   6. Spellcheck         — common resume words + malformed token detection
 */

import type { TailoredResume } from "../mastra/tools/tailoredResumePrompt";
import { impossibleClusterAtStart, impossibleClusterAtEnd, ORPHANED_CONSONANT } from "./token-heuristics.js";
import type { TailoredCoverLetter } from "../mastra/tools/tailoredCoverLetterPrompt";
import { HYPE_WORDS, bulletHasOutcome } from "./stage6-layout-governor/governor";

// ── Interfaces ───────────────────────────────────────────────────

export interface VerbIntegrityCheck {
  passed: boolean;
  malformed_tokens: { location: string; token: string; issue: string }[];
}

export interface CorruptionScanCheck {
  passed: boolean;
  issues: { location: string; text: string; issue: string }[];
}

export interface HypeResidualCheck {
  passed: boolean;
  residuals: { location: string; word: string }[];
}

export interface PhraseDuplicationCheck {
  passed: boolean;
  duplicates: { phrase: string; locations: string[] }[];
}

export interface PageValidationCheck {
  passed: boolean;
  estimated_pages: number;
  total_bullets: number;
  within_budget: boolean;
}

export interface SpellcheckResult {
  passed: boolean;
  suspicious_tokens: { location: string; token: string; reason: string }[];
}

export interface ExecutiveDepthCheck {
  passed: boolean;
  roles_with_2_impact: number;
  roles_lacking_impact: string[];
  career_arc_visible: boolean;
  summary_mandate_anchored: boolean;
  outcome_clauses_present: boolean;
  issues: string[];
}

export interface CoverLetterQACheck {
  hype_residuals: { word: string; location: string }[];
  corruption: { text: string; issue: string; location: string }[];
  repetition_patterns: string[];
}

export interface QAGateResult {
  passed: boolean;
  checks: {
    verb_integrity: VerbIntegrityCheck;
    corruption_scan: CorruptionScanCheck;
    hype_residuals: HypeResidualCheck;
    phrase_duplication: PhraseDuplicationCheck;
    page_validation: PageValidationCheck;
    spellcheck: SpellcheckResult;
    executive_depth?: ExecutiveDepthCheck;
    cover_letter_qa?: CoverLetterQACheck;
  };
  blocking_issues: string[];
  warnings: string[];
  duration_ms: number;
}

// ── Doubled Suffix Patterns ──────────────────────────────────────
//
// Detect words with doubled suffixes created by heuristic verb mutation.
// e.g., "implementeded", "driveed", "transformeded", "Strengthenedd"

const DOUBLED_SUFFIX_PATTERNS: RegExp[] = [
  /\w+eded\b/,       // "implementeded", "establisheded"
  /\w+eded\b/i,
  /\w+inging\b/i,    // "managinging"
  /\w+inging\b/,
  /\w+teded\b/i,     // "presenteded"
  /\w{3,}dd\b/i,     // "Strengthenedd", "Ledd"
  /\w+izeded\b/i,    // "optimizeded"
  /\w+atedated\b/i,  // "generatedated"
  /\w+izedized\b/i,  // "modernizedized"
];

// ── Common Resume Words (for spellcheck) ─────────────────────────
//
// Not a full dictionary — focused on words commonly found in executive
// resumes that get corrupted by string manipulation.

const SUSPICIOUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // Doubled suffixes
  { pattern: /\b\w+eded\b/i, reason: "doubled -ed suffix" },
  { pattern: /\b\w+dd\b/i, reason: "doubled terminal consonant" },
  { pattern: /\b\w+inging\b/i, reason: "doubled -ing suffix" },
  { pattern: /\b\w+izeded\b/i, reason: "doubled -ized-ed suffix" },
  { pattern: /\b\w+atedated\b/i, reason: "doubled -ated suffix" },
  // Orphaned fragments (1-2 char words that aren't real)
  { pattern: ORPHANED_CONSONANT, reason: "orphaned single consonant" },
  // CamelCase in prose (suggests concatenation error)
  { pattern: /[a-z][A-Z][a-z]{2,}/g, reason: "camelCase in prose text" },
  // Consecutive duplicate words
  { pattern: /\b(\w{3,})\s+\1\b/i, reason: "consecutive duplicate word" },
  // Orphaned punctuation
  { pattern: /[—–-]\s*[,;.]/g, reason: "orphaned punctuation sequence" },
  { pattern: /[,;]\s*[,;]/g, reason: "consecutive punctuation" },
  // Words longer than 25 chars (likely corrupted)
  { pattern: /\b[a-zA-Z]{26,}\b/, reason: "word exceeds 25 characters (likely corrupted)" },
];

// Known exceptions to avoid false positives
const EXCEPTION_WORDS = new Set([
  "a", "i", // Valid single-letter words
]);

// Legitimate words that match doubled-suffix patterns but are NOT corruptions.
// Without this list, words like "succeeded", "exceeded", "needed", "singing" get
// falsely flagged as malformed tokens.
const LEGIT_DOUBLED_SUFFIX_WORDS = new Set([
  // Legitimate "-eded" words (verb stem ends in -eed/-ced/-ped)
  "succeeded", "exceeded", "preceded", "proceeded",
  "needed", "seeded", "heeded", "deeded", "weeded",
  "superseded", "acceded", "conceded", "receded",
  "interceded", "ceded", "impeded", "stampeded",
  // Legitimate "-inging" words (verb stem ends in -ing)
  "singing", "bringing", "ringing", "stinging",
  "clinging", "wringing", "stringing", "swinging",
  "springing", "flinging", "slinging",
  // Legitimate "-dd" words (names, common words)
  "add", "odd", "todd", "kidd", "ladd", "budd", "rudd", "mudd", "dodd",
  "added", "adding",
]);

// ── Check Implementations ────────────────────────────────────────

function checkVerbIntegrity(resume: TailoredResume): VerbIntegrityCheck {
  const malformed: { location: string; token: string; issue: string }[] = [];

  function scanText(text: string, location: string) {
    const words = text.split(/\s+/);
    for (const word of words) {
      const clean = word.replace(/[^a-zA-Z]/g, "").toLowerCase();
      if (clean.length < 3) continue;
      if (LEGIT_DOUBLED_SUFFIX_WORDS.has(clean)) continue;

      for (const pattern of DOUBLED_SUFFIX_PATTERNS) {
        if (pattern.test(clean)) {
          malformed.push({ location, token: word, issue: `doubled suffix detected: "${clean}"` });
          break;
        }
      }
    }
  }

  scanText(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
    const exp = resume.experience[i] as any;
    if (exp.scope_line) scanText(exp.scope_line, `experience[${i}].scope_line`);
  }

  return { passed: malformed.length === 0, malformed_tokens: malformed };
}

function checkCorruption(resume: TailoredResume): CorruptionScanCheck {
  const issues: { location: string; text: string; issue: string }[] = [];

  function scanText(text: string, location: string) {
    for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
      // Create new regex to reset lastIndex
      const regex = new RegExp(pattern.source, pattern.flags);
      const match = text.match(regex);
      if (match) {
        const token = match[0];
        // Skip known exceptions
        if (EXCEPTION_WORDS.has(token.toLowerCase())) continue;
        // Skip legitimate words that match doubled-suffix patterns
        if (LEGIT_DOUBLED_SUFFIX_WORDS.has(token.replace(/[^a-zA-Z]/g, "").toLowerCase())) continue;
        // Skip single consonant check for common abbreviations
        if (reason === "orphaned single consonant" && /^[A-Z]$/.test(token)) continue;
        issues.push({ location, text: token, issue: reason });
      }
    }

    // Check for non-ASCII characters (excluding common punctuation)
    const nonAscii = text.match(/[^\x20-\x7E\n\t]/g);
    if (nonAscii) {
      const unique = [...new Set(nonAscii)];
      // Allow common Unicode: em-dash, en-dash, smart quotes
      const allowed = new Set(["—", "–", "\u2018", "\u2019", "\u201C", "\u201D", "\u2022"]);
      const unexpected = unique.filter(c => !allowed.has(c));
      if (unexpected.length > 0) {
        issues.push({
          location,
          text: unexpected.join(""),
          issue: `unexpected non-ASCII characters: ${unexpected.map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(", ")}`,
        });
      }
    }
  }

  scanText(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
    const exp = resume.experience[i] as any;
    if (exp.scope_line) scanText(exp.scope_line, `experience[${i}].scope_line`);
  }

  return { passed: issues.length === 0, issues };
}

function checkHypeResiduals(resume: TailoredResume): HypeResidualCheck {
  const residuals: { location: string; word: string }[] = [];

  function scanText(text: string, location: string) {
    for (const hw of HYPE_WORDS) {
      hw.pattern.lastIndex = 0;
      const match = text.match(hw.pattern);
      if (match) {
        residuals.push({ location, word: match[0] });
      }
    }
  }

  scanText(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
    const exp = resume.experience[i] as any;
    if (exp.scope_line) scanText(exp.scope_line, `experience[${i}].scope_line`);
  }

  return { passed: residuals.length === 0, residuals };
}

function checkPhraseDuplication(resume: TailoredResume): PhraseDuplicationCheck {
  // Extract 4-grams from all sections
  const gramLocations = new Map<string, string[]>();

  function extractGrams(text: string, location: string) {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (let i = 0; i <= words.length - 4; i++) {
      const gram = words.slice(i, i + 4).join(" ");
      if (!gramLocations.has(gram)) gramLocations.set(gram, []);
      gramLocations.get(gram)!.push(location);
    }
  }

  extractGrams(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      extractGrams(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
  }

  // Find 4-grams that appear in multiple DIFFERENT sections
  const duplicates: { phrase: string; locations: string[] }[] = [];
  for (const [gram, locs] of gramLocations) {
    const uniqueLocs = [...new Set(locs)];
    if (uniqueLocs.length > 1) {
      // Only flag cross-section duplicates (summary + bullet, or different roles)
      const sections = new Set(uniqueLocs.map(l => l.split(".")[0]));
      if (sections.size > 1) {
        duplicates.push({ phrase: gram, locations: uniqueLocs });
      }
    }
  }

  return { passed: duplicates.length === 0, duplicates: duplicates.slice(0, 10) };
}

function checkPageValidation(resume: TailoredResume): PageValidationCheck {
  const LINES_PER_PAGE = 42; // Calibri 11pt with DOCX spacing
  const CHARS_PER_LINE = 85;
  let totalLines = 0;

  // Header + headline
  totalLines += 4;

  // Summary
  totalLines += Math.ceil(resume.professional_summary.length / CHARS_PER_LINE);
  totalLines += 1; // spacing

  // Competencies
  const comps = (resume as any).core_competencies || [];
  totalLines += Math.max(2, Math.ceil(comps.join(" | ").length / CHARS_PER_LINE));
  totalLines += 1; // spacing

  // Experience
  const totalBullets = resume.experience.reduce((s: number, e: any) => s + e.bullets.length, 0);
  for (const exp of resume.experience) {
    totalLines += 2; // title/company/dates
    if (exp.scope_line) totalLines += 1;
    for (const bullet of exp.bullets) {
      const words = bullet.text.split(/\s+/).length;
      totalLines += words > 15 ? 2 : 1;
    }
    totalLines += 0.5;
  }

  // Education + certs + skills + section spacing
  totalLines += 10;

  const estimatedPages = Math.round((totalLines / LINES_PER_PAGE) * 10) / 10;

  return {
    passed: estimatedPages <= 2.0,
    estimated_pages: estimatedPages,
    total_bullets: totalBullets,
    within_budget: estimatedPages <= 2.0,
  };
}

function checkSpelling(resume: TailoredResume): SpellcheckResult {
  const suspicious: { location: string; token: string; reason: string }[] = [];

  function scanText(text: string, location: string) {
    const words = text.split(/\s+/);
    for (const raw of words) {
      const word = raw.replace(/[^a-zA-Z'-]/g, "");
      if (word.length < 3) continue;

      // Check for impossible consonant clusters at word edges.
      // NOTE: y is excluded from the consonant class (vowel-like in cycles,
      // rhythm, analytics) and the threshold is 5+ with a legal-cluster
      // allowlist — English legitimately ends words with 4-consonant runs
      // (insights, attempts, strengths) that a 4+ rule falsely flags.
      if (impossibleClusterAtStart(word)) {
        suspicious.push({ location, token: raw, reason: "impossible consonant cluster at start" });
      }
      if (impossibleClusterAtEnd(word)) {
        suspicious.push({ location, token: raw, reason: "impossible consonant cluster at end" });
      }

      // Check for triple+ same letter
      if (/(.)\1{2,}/i.test(word)) {
        // Allow "eee" in some edge cases but flag most
        const tripled = word.match(/(.)\1{2,}/)?.[0] || "";
        if (tripled.length >= 3 && !["sss"].includes(tripled.toLowerCase())) {
          suspicious.push({ location, token: raw, reason: `tripled letter: "${tripled}"` });
        }
      }

      // Check for doubled past-tense suffix specifically
      const lower = word.toLowerCase();
      if (lower.endsWith("eded") && lower.length > 6) {
        suspicious.push({ location, token: raw, reason: "doubled -ed suffix" });
      }
      if (lower.endsWith("inging") && lower.length > 8) {
        suspicious.push({ location, token: raw, reason: "doubled -ing suffix" });
      }

      // Check for doubled terminal consonant (e.g., "Strengthenedd" from verb corruption)
      if (word.length > 6 && /([bcdfghjkmnpqrtvwxyz])\1$/i.test(word)) {
        const ending = word.slice(-2).toLowerCase();
        // Exclude common English doubled-consonant endings
        const commonDoubles = new Set(["ll", "ss", "ff", "zz", "rr", "tt", "nn"]);
        if (!commonDoubles.has(ending)) {
          suspicious.push({ location, token: raw, reason: "doubled terminal consonant" });
        }
      }
    }
  }

  scanText(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
    const exp = resume.experience[i] as any;
    if (exp.scope_line) scanText(exp.scope_line, `experience[${i}].scope_line`);
  }

  return { passed: suspicious.length === 0, suspicious_tokens: suspicious };
}

// ── Executive Depth QA ──────────────────────────────────────────
//
// FINAL QA: Before output, confirm executive depth is preserved.

function checkExecutiveDepth(resume: TailoredResume): ExecutiveDepthCheck {
  const issues: string[] = [];
  let rolesWithImpact = 0;
  const rolesLackingImpact: string[] = [];
  let totalOutcomes = 0;

  // Check: 2+ bullets per major role contain quantified impact
  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];
    const impactCount = exp.bullets.filter(b => bulletHasOutcome(b.text)).length;
    totalOutcomes += impactCount;

    if (impactCount >= 2) {
      rolesWithImpact++;
    } else {
      rolesLackingImpact.push(`${exp.employer} (${impactCount} impact bullets)`);
      if (i < 3) { // Major roles = top 3
        issues.push(`${exp.employer}: only ${impactCount}/2 required impact bullets for major role`);
      }
    }
  }

  // Check: Summary reflects mandate (not generic)
  const GENERIC_SUMMARY_STARTS = [
    /^(?:data|analytics)\s+(?:and\s+)?(?:analytics\s+)?(?:leader|executive|professional)\b/i,
    /^(?:seasoned|accomplished|dynamic|experienced|senior|results-driven)\s+/i,
    /^(?:proven|established|recognized)\s+(?:leader|executive)\b/i,
  ];
  const firstSentence = (resume.professional_summary.split(/[.!?]\s/)[0] || "").trim();
  const summaryMandateAnchored = !GENERIC_SUMMARY_STARTS.some(p => p.test(firstSentence));

  if (!summaryMandateAnchored) {
    issues.push("Summary opens with generic pattern — must anchor to job mandate");
  }

  // Check: Career arc visible (3+ roles)
  const careerArcVisible = resume.experience.length >= 3;
  if (!careerArcVisible) {
    issues.push(`Only ${resume.experience.length} role(s) — need 3+ for visible career arc`);
  }

  // Check: No outcome clauses removed (at least 1 impact bullet overall)
  const outcomeClausesPresent = totalOutcomes >= 2;
  if (!outcomeClausesPresent) {
    issues.push(`Only ${totalOutcomes} total impact bullets — at least 2 required`);
  }

  return {
    passed: issues.length === 0,
    roles_with_2_impact: rolesWithImpact,
    roles_lacking_impact: rolesLackingImpact,
    career_arc_visible: careerArcVisible,
    summary_mandate_anchored: summaryMandateAnchored,
    outcome_clauses_present: outcomeClausesPresent,
    issues,
  };
}

// ── Cover Letter Anti-Repetition QA ─────────────────────────────

const CL_REPETITION_PATTERNS: RegExp[] = [
  /\baligns? with [\w']+'s need\b/gi,
  /\bthis aligns (?:directly )?with\b/gi,
  /\bwhich aligns (?:directly )?with\b/gi,
  /\bdirectly address(?:es|ing) [\w']+'s need\b/gi,
];

// ── Cover Letter QA ──────────────────────────────────────────────

function checkCoverLetterQA(cl: TailoredCoverLetter): CoverLetterQACheck {
  const hype: { word: string; location: string }[] = [];
  const corruption: { text: string; issue: string; location: string }[] = [];

  const sections = [
    { text: cl.opening_paragraph, loc: "cl.opening" },
    ...cl.body_paragraphs.map((p: string, i: number) => ({ text: p, loc: `cl.body[${i}]` })),
    { text: cl.closing_paragraph, loc: "cl.closing" },
  ];

  for (const { text, loc } of sections) {
    // Check hype words
    for (const hw of HYPE_WORDS) {
      hw.pattern.lastIndex = 0;
      const match = text.match(hw.pattern);
      if (match) hype.push({ word: match[0], location: loc });
    }

    // Check corruption
    for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      const match = text.match(regex);
      if (match && !EXCEPTION_WORDS.has(match[0].toLowerCase())) {
        corruption.push({ text: match[0], issue: reason, location: loc });
      }
    }
  }

  // Check repetition patterns
  const fullText = sections.map(s => s.text).join(" ");
  const repetitionPatterns: string[] = [];
  for (const pat of CL_REPETITION_PATTERNS) {
    pat.lastIndex = 0;
    const match = fullText.match(pat);
    if (match) repetitionPatterns.push(match[0]);
  }

  return { hype_residuals: hype, corruption, repetition_patterns: repetitionPatterns };
}

// ── Main QA Gate ─────────────────────────────────────────────────

/**
 * Run the complete QA gate on a finalized resume + cover letter.
 * This is the LAST check before PDF rendering.
 *
 * Order:
 *   1. Verb integrity (detect malformed words from verb replacement)
 *   2. Corruption scan (doubled suffixes, orphaned fragments, non-ASCII)
 *   3. Hype residuals (any hype words that survived suppression)
 *   4. Phrase duplication (exact cross-section duplicates)
 *   5. Page validation (within 2-page budget)
 *   6. Spellcheck (malformed tokens, impossible letter clusters)
 *
 * Returns blocking_issues for issues that MUST be fixed,
 * and warnings for non-blocking quality concerns.
 */
export function runQAGate(
  resume: TailoredResume,
  coverLetter?: TailoredCoverLetter,
): QAGateResult {
  const start = Date.now();
  const blocking: string[] = [];
  const warnings: string[] = [];

  // 1. Verb integrity
  const verbIntegrity = checkVerbIntegrity(resume);
  if (!verbIntegrity.passed) {
    blocking.push(
      `${verbIntegrity.malformed_tokens.length} malformed token(s) from verb replacement: ${verbIntegrity.malformed_tokens.map(t => `"${t.token}"`).slice(0, 3).join(", ")}`,
    );
  }

  // 2. Corruption scan
  const corruptionScan = checkCorruption(resume);
  if (!corruptionScan.passed) {
    const criticalIssues = corruptionScan.issues.filter(i =>
      i.issue.includes("doubled") || i.issue.includes("corrupted") || i.issue.includes("duplicate word"),
    );
    if (criticalIssues.length > 0) {
      blocking.push(
        `${criticalIssues.length} corruption issue(s): ${criticalIssues.map(i => `"${i.text}" (${i.issue})`).slice(0, 3).join(", ")}`,
      );
    }
    const minorIssues = corruptionScan.issues.filter(i => !criticalIssues.includes(i));
    if (minorIssues.length > 0) {
      warnings.push(
        `${minorIssues.length} minor corruption warning(s): ${minorIssues.map(i => i.issue).slice(0, 3).join(", ")}`,
      );
    }
  }

  // 3. Hype residuals
  const hypeResiduals = checkHypeResiduals(resume);
  if (!hypeResiduals.passed) {
    warnings.push(
      `${hypeResiduals.residuals.length} hype word(s) survived suppression: ${hypeResiduals.residuals.map(r => `"${r.word}"`).slice(0, 5).join(", ")}`,
    );
  }

  // 4. Phrase duplication
  const phraseDuplication = checkPhraseDuplication(resume);
  if (!phraseDuplication.passed) {
    warnings.push(
      `${phraseDuplication.duplicates.length} cross-section phrase duplicate(s): ${phraseDuplication.duplicates.map(d => `"${d.phrase}"`).slice(0, 3).join(", ")}`,
    );
  }

  // 5. Page validation
  const pageValidation = checkPageValidation(resume);
  if (!pageValidation.passed) {
    blocking.push(
      `Resume exceeds 2-page budget: estimated ${pageValidation.estimated_pages} pages with ${pageValidation.total_bullets} bullets`,
    );
  }

  // 6. Spellcheck
  const spellcheck = checkSpelling(resume);
  if (!spellcheck.passed) {
    blocking.push(
      `${spellcheck.suspicious_tokens.length} suspicious token(s): ${spellcheck.suspicious_tokens.map(t => `"${t.token}" (${t.reason})`).slice(0, 3).join(", ")}`,
    );
  }

  // 7. Executive depth QA (balanced executive depth & impact pass)
  const executiveDepth = checkExecutiveDepth(resume);
  if (!executiveDepth.passed) {
    for (const issue of executiveDepth.issues) {
      warnings.push(`Executive depth: ${issue}`);
    }
    if (!executiveDepth.career_arc_visible) {
      warnings.push("Career arc not visible — fewer than 3 roles");
    }
    if (!executiveDepth.outcome_clauses_present) {
      warnings.push("Insufficient quantified impact — outcome clauses may have been stripped");
    }
  }

  // 8. Cover letter QA (if provided)
  let clQAResult: CoverLetterQACheck | undefined;
  if (coverLetter) {
    clQAResult = checkCoverLetterQA(coverLetter);
    if (clQAResult.hype_residuals.length > 0) {
      warnings.push(
        `Cover letter: ${clQAResult.hype_residuals.length} hype word(s): ${clQAResult.hype_residuals.map(r => `"${r.word}"`).join(", ")}`,
      );
    }
    if (clQAResult.corruption.length > 0) {
      blocking.push(
        `Cover letter: ${clQAResult.corruption.length} corruption issue(s): ${clQAResult.corruption.map(c => `"${c.text}" (${c.issue})`).slice(0, 3).join(", ")}`,
      );
    }
    if (clQAResult.repetition_patterns.length > 0) {
      warnings.push(
        `Cover letter repetition: ${clQAResult.repetition_patterns.map(p => `"${p}"`).join(", ")} — remove template-driven alignment phrases`,
      );
    }
  }

  return {
    passed: blocking.length === 0,
    checks: {
      verb_integrity: verbIntegrity,
      corruption_scan: corruptionScan,
      hype_residuals: hypeResiduals,
      phrase_duplication: phraseDuplication,
      page_validation: pageValidation,
      spellcheck: spellcheck,
      executive_depth: executiveDepth,
      cover_letter_qa: clQAResult,
    },
    blocking_issues: blocking,
    warnings,
    duration_ms: Date.now() - start,
  };
}
