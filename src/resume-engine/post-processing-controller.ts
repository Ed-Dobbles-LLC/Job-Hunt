/**
 * Post-Processing Controller
 *
 * Consolidates all post-generation quality checks into a single,
 * ordered, DETECTION-ONLY pass. No stage in this controller may
 * mutate the resume or cover letter.
 *
 * Replaces the previous scattered architecture of:
 *   - QA Gate (qa-gate.ts)
 *   - Refinement Layer (refinement-layer.ts)
 *   - Executive Depth Pass (inline in qa-gate.ts)
 *   - Hype Residual Check (inline in qa-gate.ts)
 *   - Verb Integrity Check (inline in qa-gate.ts)
 *
 * ORDER OF OPERATIONS (deterministic, no LLM):
 *   1. Corruption Detection    — doubled suffixes, malformed tokens, non-ASCII
 *   2. Verb Integrity          — semantic drift, hype verbs, misaligned categories
 *   3. Hype & Authority Audit  — inflated adjectives, ungrounded claims
 *   4. Phrase Quality          — duplication, suppressed phrases, filler residuals
 *   5. Mandate Alignment       — summary anchoring, keyword coverage
 *   6. Differentiation         — overlap with prior resumes (summary, competencies)
 *   7. Layout Compliance       — page budget, bullet counts, word limits
 *   8. Executive Depth         — impact bullet coverage, career arc, enterprise roles
 *   9. Ownership Inflation     — escalation patterns (contributor→owner)
 *   10. Cover Letter QA        — hype, corruption, repetition in cover letter
 *
 * MUTATION BOUNDARY: This controller NEVER modifies its inputs.
 * It returns a structured PostProcessingReport with scores, issues,
 * and blocking flags. The pipeline orchestrator decides what to do.
 *
 * CONTRACT: stage-contracts.ts defines this as "post_processing"
 *   - allowed_mutations: ["none"]
 *   - forbidden_mutations: all resume/cover_letter fields
 */

import type { TailoredResume } from "../mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../mastra/tools/tailoredCoverLetterPrompt";
import type { MandateProfile } from "./stage2-mandate-classifier/classifier";
import type { ClaimsLedger } from "./types";
import { HYPE_WORDS, bulletHasOutcome } from "./stage6-layout-governor/governor";
import {
  checkMandateAnchoredSummary,
  checkVerbAlignment,
  inferContentCategory,
  INFLATED_ADJECTIVES,
  PHRASE_SUPPRESSION_LIST,
  VERB_WHITELIST,
} from "./refinement-layer";

// ── Result Types ─────────────────────────────────────────────────

export interface PostProcessingIssue {
  category: PostProcessingCategory;
  severity: "blocking" | "warning" | "info";
  location: string;
  text: string;
  explanation: string;
}

export type PostProcessingCategory =
  | "corruption"
  | "verb_integrity"
  | "hype_authority"
  | "phrase_quality"
  | "mandate_alignment"
  | "differentiation"
  | "layout_compliance"
  | "executive_depth"
  | "ownership_inflation"
  | "cover_letter";

export interface PostProcessingScores {
  corruption: number;           // 0-100 (100 = no issues)
  verb_integrity: number;       // 0-100
  hype_authority: number;       // 0-100
  phrase_quality: number;       // 0-100
  mandate_alignment: number;    // 0-100
  differentiation: number;      // 0-100
  layout_compliance: number;    // 0-100
  executive_depth: number;      // 0-100
  ownership_inflation: number;  // 0-100
  cover_letter: number;         // 0-100
  composite: number;            // weighted average
  grade: "A" | "B" | "C" | "D" | "F";
}

export interface PostProcessingReport {
  passed: boolean;
  scores: PostProcessingScores;
  issues: PostProcessingIssue[];
  blocking_issues: string[];
  warnings: string[];
  duration_ms: number;
}

// ── Input ────────────────────────────────────────────────────────

export interface PostProcessingInput {
  resume: TailoredResume;
  coverLetter?: TailoredCoverLetter;
  mandate: MandateProfile;
  ledger?: ClaimsLedger;
  inventory?: Record<string, any>;
  priorSummaries?: string[];
  priorCompetencies?: string[][];
  logger?: any;
}

// ── Legitimate Word Exceptions ───────────────────────────────────

const LEGIT_DOUBLED_SUFFIX_WORDS = new Set([
  "succeeded", "exceeded", "preceded", "proceeded",
  "needed", "seeded", "heeded", "deeded", "weeded",
  "superseded", "acceded", "conceded", "receded",
  "interceded", "ceded", "impeded", "stampeded",
  "singing", "bringing", "ringing", "stinging",
  "clinging", "wringing", "stringing", "swinging",
  "springing", "flinging", "slinging",
  "add", "odd", "todd", "kidd", "ladd", "budd", "rudd", "mudd", "dodd",
  "added", "adding",
]);

// ── Detection Functions (all read-only) ──────────────────────────

function detectCorruption(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
): number {
  let score = 100;

  function scanText(text: string, location: string) {
    const words = text.split(/\s+/);
    for (const raw of words) {
      const clean = raw.replace(/[^a-zA-Z]/g, "").toLowerCase();
      if (clean.length < 3) continue;
      if (LEGIT_DOUBLED_SUFFIX_WORDS.has(clean)) continue;

      // Doubled -ed suffix
      if (clean.endsWith("eded") && clean.length > 6) {
        issues.push({ category: "corruption", severity: "blocking", location, text: raw, explanation: `Doubled -ed suffix: "${clean}"` });
        score -= 25;
      }
      // Doubled -ing suffix
      if (clean.endsWith("inging") && clean.length > 8) {
        issues.push({ category: "corruption", severity: "blocking", location, text: raw, explanation: `Doubled -ing suffix: "${clean}"` });
        score -= 25;
      }
      // Doubled terminal consonant (not common doubles)
      const commonDoubles = new Set(["ll", "ss", "ff", "zz", "rr", "tt", "nn"]);
      if (clean.length > 6 && /([bcdfghjkmnpqrtvwxyz])\1$/i.test(clean)) {
        const ending = clean.slice(-2);
        if (!commonDoubles.has(ending)) {
          issues.push({ category: "corruption", severity: "blocking", location, text: raw, explanation: `Doubled terminal consonant: "${clean}"` });
          score -= 25;
        }
      }
      // Impossible consonant clusters
      if (/^[bcdfghjklmnpqrstvwxyz]{4,}/i.test(clean)) {
        issues.push({ category: "corruption", severity: "blocking", location, text: raw, explanation: "Impossible consonant cluster at start" });
        score -= 25;
      }
      // Triple letter
      if (/(.)\1{2,}/i.test(clean)) {
        const tripled = clean.match(/(.)\1{2,}/)?.[0] || "";
        if (tripled.length >= 3) {
          issues.push({ category: "corruption", severity: "blocking", location, text: raw, explanation: `Tripled letter: "${tripled}"` });
          score -= 25;
        }
      }
      // Word too long
      if (clean.length > 25) {
        issues.push({ category: "corruption", severity: "warning", location, text: raw, explanation: "Word exceeds 25 chars (likely corrupted)" });
        score -= 10;
      }
    }

    // Non-ASCII check
    const allowed = new Set(["—", "–", "\u2018", "\u2019", "\u201C", "\u201D", "\u2022"]);
    const nonAscii = text.match(/[^\x20-\x7E\n\t]/g);
    if (nonAscii) {
      const unexpected = [...new Set(nonAscii)].filter(c => !allowed.has(c));
      if (unexpected.length > 0) {
        issues.push({ category: "corruption", severity: "warning", location, text: unexpected.join(""), explanation: "Unexpected non-ASCII characters" });
        score -= 5;
      }
    }
  }

  scanText(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
    if ((resume.experience[i] as any).scope_line) {
      scanText((resume.experience[i] as any).scope_line, `experience[${i}].scope_line`);
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectVerbIntegrity(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
): number {
  let score = 100;
  const HYPE_VERBS = ["catalyzed", "revolutionized", "disrupted", "synergized", "ideated", "evangelized"];

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const firstWord = bullet.text.trim().split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, "") || "";
      const verb = firstWord.toLowerCase();
      const location = `experience[${i}].bullets[${j}]`;

      if (!verb || verb.length < 3) continue;

      // Semantic alignment check
      const alignment = checkVerbAlignment(verb, bullet.text);
      if (!alignment.aligned) {
        issues.push({ category: "verb_integrity", severity: "warning", location, text: firstWord, explanation: alignment.explanation });
        score -= 10;
      }

      // Hype verb check
      if (HYPE_VERBS.includes(verb)) {
        issues.push({ category: "verb_integrity", severity: "warning", location, text: firstWord, explanation: `Hype verb "${verb}" undermines credibility` });
        score -= 8;
      }
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectHypeAndAuthority(
  resume: TailoredResume,
  inventory: Record<string, any> | undefined,
  issues: PostProcessingIssue[],
): number {
  let score = 100;
  const inventoryText = inventory ? JSON.stringify(inventory).toLowerCase() : "";

  function scanText(text: string, location: string) {
    // Check inflated adjectives (detection only — no replacement)
    for (const adj of INFLATED_ADJECTIVES) {
      adj.pattern.lastIndex = 0;
      const match = text.match(adj.pattern);
      if (match) {
        issues.push({
          category: "hype_authority",
          severity: "warning",
          location,
          text: match[0],
          explanation: `Inflated adjective "${match[0]}" → consider "${adj.replacement}"`,
        });
        score -= 5;
      }
    }

    // Check hype words
    for (const hw of HYPE_WORDS) {
      hw.pattern.lastIndex = 0;
      const match = text.match(hw.pattern);
      if (match) {
        issues.push({
          category: "hype_authority",
          severity: "warning",
          location,
          text: match[0],
          explanation: `Hype word "${match[0]}" survived suppression → consider "${hw.replacement}"`,
        });
        score -= 5;
      }
    }
  }

  scanText(resume.professional_summary, "summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `experience[${i}].bullets[${j}]`);
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectPhraseQuality(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
): number {
  let score = 100;

  // Cross-section phrase duplication (4-grams)
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

  for (const [gram, locs] of gramLocations) {
    const uniqueLocs = [...new Set(locs)];
    if (uniqueLocs.length > 1) {
      const sections = new Set(uniqueLocs.map(l => l.split(".")[0]));
      if (sections.size > 1) {
        issues.push({ category: "phrase_quality", severity: "warning", location: uniqueLocs.join(", "), text: gram, explanation: "Cross-section phrase duplication" });
        score -= 3;
      }
    }
  }

  // Suppressed phrase check
  const fullText = [
    resume.professional_summary,
    ...resume.experience.flatMap(e => e.bullets.map(b => b.text)),
  ].join(" ").toLowerCase();

  for (const phrase of PHRASE_SUPPRESSION_LIST) {
    if (fullText.includes(phrase.toLowerCase())) {
      issues.push({ category: "phrase_quality", severity: "warning", location: "resume", text: phrase, explanation: "Suppressed stock phrase found" });
      score -= 2;
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectMandateAlignment(
  resume: TailoredResume,
  mandate: MandateProfile,
  issues: PostProcessingIssue[],
): number {
  const check = checkMandateAnchoredSummary(resume.professional_summary, mandate);

  let score = 0;

  // Summary anchoring (35%)
  if (check.first_sentence_anchored) score += 35;
  else if (check.mandate_keywords_found > 0) score += 15;

  // No generic opener (15%)
  if (!check.uses_generic_opener) score += 15;
  else {
    issues.push({ category: "mandate_alignment", severity: "warning", location: "summary", text: check.matched_generic_pattern || "", explanation: "Summary opens with generic pattern" });
  }

  // No revenue-first for non-revenue role (10%)
  if (!check.revenue_first_non_revenue) score += 10;
  else {
    issues.push({ category: "mandate_alignment", severity: "warning", location: "summary", text: "", explanation: "Revenue-first framing in non-revenue role" });
  }

  // First 2 bullets per role aligned (40%)
  const MANDATE_KEYWORDS: Record<string, string[]> = {
    governance_standardization: ["governance", "compliance", "standardiz", "audit", "control"],
    bi_modernization: ["platform", "architect", "moderniz", "migrat", "cloud"],
    insight_delivery_modernization: ["insight", "self-service", "reporting", "dashboard"],
    executive_okr_reporting: ["okr", "kpi", "scorecard", "executive reporting"],
    revenue_ops_forecasting: ["revenue", "forecast", "pricing", "demand"],
    operating_model_transformation: ["operating model", "transform", "embed", "democratiz"],
    ai_integration_llm: ["ai", "ml", "llm", "genai"],
    growth_monetization: ["growth", "experiment", "a/b test", "conversion"],
    cross_functional_influence: ["board", "c-suite", "advisory", "storytelling"],
    team_scale_org_design: ["team", "hired", "scaled", "organizational design"],
  };
  const mandateKeywords = MANDATE_KEYWORDS[mandate.primary_mandate] || [];
  const firstTwoBullets = resume.experience.flatMap(e => e.bullets.slice(0, 2));
  let aligned = 0;
  for (const bullet of firstTwoBullets) {
    if (mandateKeywords.some(kw => bullet.text.toLowerCase().includes(kw))) aligned++;
  }
  score += firstTwoBullets.length > 0 ? Math.round((aligned / firstTwoBullets.length) * 40) : 0;

  for (const issue of check.issues) {
    issues.push({ category: "mandate_alignment", severity: "warning", location: "summary", text: "", explanation: issue });
  }

  return Math.max(0, Math.min(100, score));
}

function detectDifferentiation(
  resume: TailoredResume,
  priorSummaries: string[] | undefined,
  priorCompetencies: string[][] | undefined,
  issues: PostProcessingIssue[],
): number {
  let score = 100;

  if (priorSummaries && priorSummaries.length > 0) {
    for (const prior of priorSummaries) {
      const overlap = wordOverlap(resume.professional_summary, prior);
      if (overlap > 0.35) {
        issues.push({ category: "differentiation", severity: "blocking", location: "summary", text: `${Math.round(overlap * 100)}% overlap`, explanation: `Summary overlap ${Math.round(overlap * 100)}% exceeds 35% threshold` });
        score -= 30;
      } else if (overlap > 0.25) {
        issues.push({ category: "differentiation", severity: "warning", location: "summary", text: `${Math.round(overlap * 100)}% overlap`, explanation: "Summary approaching differentiation threshold" });
        score -= 10;
      }
    }
  }

  const currentComps = ((resume as any).core_competencies || []) as string[];
  if (priorCompetencies && priorCompetencies.length > 0) {
    for (const priorComps of priorCompetencies) {
      const overlap = setOverlap(currentComps, priorComps);
      if (overlap > 0.50) {
        issues.push({ category: "differentiation", severity: "warning", location: "competencies", text: `${Math.round(overlap * 100)}% overlap`, explanation: "Competency overlap exceeds 50%" });
        score -= 15;
      }
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectLayoutCompliance(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
): number {
  let score = 100;
  const LINES_PER_PAGE = 42; // Calibri 11pt with DOCX spacing
  const CHARS_PER_LINE = 85;

  // Page estimate
  let totalLines = 4; // header
  totalLines += Math.ceil(resume.professional_summary.length / CHARS_PER_LINE) + 1;
  const comps = ((resume as any).core_competencies || []) as string[];
  totalLines += Math.max(2, Math.ceil(comps.join(" | ").length / CHARS_PER_LINE)) + 1;
  for (const exp of resume.experience) {
    totalLines += 2;
    if ((exp as any).scope_line) totalLines += 1;
    for (const b of exp.bullets) {
      totalLines += b.text.split(/\s+/).length > 15 ? 2 : 1;
    }
    totalLines += 0.5;
  }
  totalLines += 10; // education + certs + skills

  const pages = totalLines / LINES_PER_PAGE;
  if (pages > 2.0) {
    issues.push({ category: "layout_compliance", severity: "blocking", location: "resume", text: `${pages.toFixed(1)} pages`, explanation: `Estimated ${pages.toFixed(1)} pages exceeds 2-page budget` });
    score -= 30;
  }

  // Word limit check
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const words = resume.experience[i].bullets[j].text.split(/\s+/).length;
      if (words > 22) {
        issues.push({ category: "layout_compliance", severity: "warning", location: `experience[${i}].bullets[${j}]`, text: `${words} words`, explanation: "Bullet exceeds 22-word limit" });
        score -= 5;
      }
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectExecutiveDepth(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
): number {
  let score = 100;

  // Impact bullets per major role
  for (let i = 0; i < Math.min(3, resume.experience.length); i++) {
    const exp = resume.experience[i];
    const impactCount = exp.bullets.filter(b => bulletHasOutcome(b.text)).length;
    if (impactCount < 2) {
      issues.push({ category: "executive_depth", severity: "warning", location: `experience[${i}]`, text: `${impactCount} impact bullets`, explanation: `${exp.employer}: only ${impactCount}/2 required impact bullets for major role` });
      score -= 10;
    }
  }

  // Career arc
  if (resume.experience.length < 3) {
    issues.push({ category: "executive_depth", severity: "warning", location: "resume", text: `${resume.experience.length} roles`, explanation: "Need 3+ roles for visible career arc" });
    score -= 15;
  }

  // Enterprise role presence
  const hasEnterprise = resume.experience.some(exp => {
    const scope = ((exp as any).scope_line || "").toLowerCase();
    return /\$\d/.test(scope) || /\d+\s*(?:person|fte|report|member)/i.test(scope);
  });
  if (!hasEnterprise && resume.experience.length > 0) {
    issues.push({ category: "executive_depth", severity: "warning", location: "resume", text: "", explanation: "No enterprise-scale role visible" });
    score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

function detectOwnershipInflation(
  resume: TailoredResume,
  issues: PostProcessingIssue[],
): number {
  let score = 100;

  const ESCALATION_PATTERNS: { weak: RegExp; strong: RegExp; label: string }[] = [
    { weak: /contributed/i, strong: /\b(?:built|created|architected|owned)\b/i, label: "contributor → owner" },
    { weak: /team member/i, strong: /\bsingle-handedly\b/i, label: "team member → sole credit" },
    { weak: /(?:assisted|helped|supported)/i, strong: /\b(?:led|drove|directed|transformed)\b/i, label: "helper → leader" },
  ];

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const bulletLower = bullet.text.toLowerCase();
      const sourceText = ((bullet.evidence_quote || "") + " " + (bullet.source_hash || "")).toLowerCase();

      for (const pattern of ESCALATION_PATTERNS) {
        if (pattern.strong.test(bulletLower) && sourceText && pattern.weak.test(sourceText) && !pattern.strong.test(sourceText)) {
          issues.push({
            category: "ownership_inflation",
            severity: "warning",
            location: `experience[${i}].bullets[${j}]`,
            text: bullet.text.substring(0, 60),
            explanation: `Ownership escalation: ${pattern.label}`,
          });
          score -= 10;
        }
      }
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectCoverLetterIssues(
  cl: TailoredCoverLetter | undefined,
  issues: PostProcessingIssue[],
): number {
  if (!cl) return 100;
  let score = 100;

  const sections = [
    { text: cl.opening_paragraph, loc: "cl.opening" },
    ...cl.body_paragraphs.map((p: string, i: number) => ({ text: p, loc: `cl.body[${i}]` })),
    { text: cl.closing_paragraph, loc: "cl.closing" },
  ];

  for (const { text, loc } of sections) {
    // Hype words
    for (const hw of HYPE_WORDS) {
      hw.pattern.lastIndex = 0;
      if (hw.pattern.test(text)) {
        issues.push({ category: "cover_letter", severity: "warning", location: loc, text: hw.label, explanation: `Hype word in cover letter: "${hw.label}"` });
        score -= 5;
      }
    }

    // Corruption
    const words = text.split(/\s+/);
    for (const w of words) {
      const clean = w.replace(/[^a-zA-Z]/g, "").toLowerCase();
      if (clean.length > 6 && clean.endsWith("eded") && !LEGIT_DOUBLED_SUFFIX_WORDS.has(clean)) {
        issues.push({ category: "cover_letter", severity: "blocking", location: loc, text: w, explanation: "Doubled suffix in cover letter" });
        score -= 25;
      }
    }
  }

  // Repetition patterns
  const fullText = sections.map(s => s.text).join(" ");
  const CL_REPETITION_PATTERNS: RegExp[] = [
    /\baligns? with [\w']+'s need\b/gi,
    /\bthis aligns (?:directly )?with\b/gi,
  ];
  for (const pat of CL_REPETITION_PATTERNS) {
    pat.lastIndex = 0;
    const match = fullText.match(pat);
    if (match) {
      issues.push({ category: "cover_letter", severity: "warning", location: "cover_letter", text: match[0], explanation: "Template-driven alignment phrase" });
      score -= 5;
    }
  }

  return Math.max(0, Math.min(100, score));
}

// ── Helpers ──────────────────────────────────────────────────────

function wordOverlap(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  return intersection.size / Math.min(wordsA.size, wordsB.size);
}

function setOverlap(a: string[], b: string[]): number {
  const setA = new Set(a.map(c => c.toLowerCase().trim()));
  const setB = new Set(b.map(c => c.toLowerCase().trim()));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(c => setB.has(c)));
  return intersection.size / Math.min(setA.size, setB.size);
}

// ── Main Controller ──────────────────────────────────────────────

/**
 * Run the complete post-processing quality assessment.
 *
 * IMPORTANT: This function NEVER modifies its inputs.
 * It returns a detection-only report.
 */
export function runPostProcessing(input: PostProcessingInput): PostProcessingReport {
  const start = Date.now();
  const { resume, coverLetter, mandate, ledger, inventory, priorSummaries, priorCompetencies, logger } = input;
  const issues: PostProcessingIssue[] = [];

  logger?.info("🔬 [PostProcessing] Starting consolidated post-processing assessment...");

  // 1. Corruption Detection
  const corruptionScore = detectCorruption(resume, issues);

  // 2. Verb Integrity
  const verbScore = detectVerbIntegrity(resume, issues);

  // 3. Hype & Authority Audit
  const hypeScore = detectHypeAndAuthority(resume, inventory, issues);

  // 4. Phrase Quality
  const phraseScore = detectPhraseQuality(resume, issues);

  // 5. Mandate Alignment
  const mandateScore = detectMandateAlignment(resume, mandate, issues);

  // 6. Differentiation
  const diffScore = detectDifferentiation(resume, priorSummaries, priorCompetencies, issues);

  // 7. Layout Compliance
  const layoutScore = detectLayoutCompliance(resume, issues);

  // 8. Executive Depth
  const depthScore = detectExecutiveDepth(resume, issues);

  // 9. Ownership Inflation
  const ownershipScore = detectOwnershipInflation(resume, issues);

  // 10. Cover Letter QA
  const clScore = detectCoverLetterIssues(coverLetter, issues);

  // Composite score (weighted)
  const composite = Math.round(
    corruptionScore * 0.15 +
    verbScore * 0.10 +
    hypeScore * 0.05 +
    phraseScore * 0.05 +
    mandateScore * 0.15 +
    diffScore * 0.10 +
    layoutScore * 0.10 +
    depthScore * 0.10 +
    ownershipScore * 0.10 +
    clScore * 0.10,
  );

  const grade = composite >= 90 ? "A"
    : composite >= 80 ? "B"
    : composite >= 70 ? "C"
    : composite >= 60 ? "D"
    : "F" as const;

  const scores: PostProcessingScores = {
    corruption: corruptionScore,
    verb_integrity: verbScore,
    hype_authority: hypeScore,
    phrase_quality: phraseScore,
    mandate_alignment: mandateScore,
    differentiation: diffScore,
    layout_compliance: layoutScore,
    executive_depth: depthScore,
    ownership_inflation: ownershipScore,
    cover_letter: clScore,
    composite,
    grade,
  };

  const blockingIssues = issues.filter(i => i.severity === "blocking").map(i => `${i.category}: ${i.explanation}`);
  const warnings = issues.filter(i => i.severity === "warning").map(i => `${i.category}: ${i.explanation}`);

  const passed = blockingIssues.length === 0;

  const duration = Date.now() - start;
  logger?.info(`🔬 [PostProcessing] Complete: ${composite}/100 (${grade}) — ${passed ? "PASS" : "FAIL"} — ${blockingIssues.length} blocking, ${warnings.length} warnings — ${duration}ms`);

  return {
    passed,
    scores,
    issues,
    blocking_issues: blockingIssues,
    warnings,
    duration_ms: duration,
  };
}
