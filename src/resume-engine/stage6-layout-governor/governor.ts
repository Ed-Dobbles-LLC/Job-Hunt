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

/** Mapping of weak opener verbs to stronger executive-level replacements. */
const SOFT_VERB_REPLACEMENTS: Record<string, string> = {
  supported: "Strengthened",
  helped: "Drove",
  contributed: "Delivered",
  assisted: "Partnered",
  participated: "Engaged in",
  aided: "Enabled",
  facilitated: "Orchestrated",
};

// ── Generic-Strong Verb Upgrades (Verb Strength Pass) ───────────
//
// "Led", "built", "managed", "transformed" are accurate but overused.
// When the mandate signals a specific archetype, swap to mandate-aligned
// verbs that convey domain-specific authority.

const GENERIC_STRONG_VERBS = ["led", "built", "managed", "transformed", "drove", "created", "developed"];

/** Mandate-aligned verb alternatives. Each mandate maps to a pool of verbs
 * that convey the right KIND of authority for that archetype. */
const MANDATE_VERB_POOL: Record<string, string[]> = {
  governance_standardization: ["Instituted", "Codified", "Standardized", "Embedded", "Enforced", "Formalized", "Governed"],
  bi_platform_modernization: ["Architected", "Migrated", "Replatformed", "Engineered", "Unified", "Modernized", "Scaled"],
  insight_delivery_automation: ["Operationalized", "Automated", "Democratized", "Surfaced", "Instrumented", "Embedded", "Accelerated"],
  founder_adjacent_builder: ["Established", "Launched", "Bootstrapped", "Founded", "Pioneered", "Incubated", "Originated"],
  revenue_ops_forecasting: ["Recaptured", "Forecasted", "Recovered", "Monetized", "Optimized", "Repriced", "Modeled"],
  operating_model_transformation: ["Redesigned", "Restructured", "Overhauled", "Reengineered", "Consolidated", "Realigned", "Repositioned"],
  product_gtm_analytics: ["Instrumented", "Segmented", "Personalized", "Activated", "Converted", "Optimized", "Tracked"],
  growth_monetization: ["Converted", "Experimented", "Optimized", "Monetized", "Funneled", "Tested", "Iterated"],
  executive_storytelling: ["Influenced", "Briefed", "Positioned", "Advised", "Counseled", "Steered", "Shaped"],
  team_leadership_scale: ["Recruited", "Mentored", "Scaled", "Organized", "Elevated", "Coached", "Developed"],
};

/** Safe managerial phrasing that sounds impressive but says nothing. */
const SAFE_MANAGERIAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /^(?:oversaw|managed|responsible for)\s+(?:the\s+)?(?:day-to-day|daily|ongoing|routine)\b/i, label: "routine oversight" },
  { pattern: /^(?:managed|oversaw)\s+(?:a\s+)?team\s+(?:of\s+)?\w+\s+(?:to\s+)?(?:deliver|ensure|maintain|support)\b/i, label: "generic team management" },
  { pattern: /^ensured\s+(?:the\s+)?(?:quality|timely|smooth|successful)\b/i, label: "ensured quality" },
  { pattern: /^responsible\s+for\s+(?:managing|overseeing|ensuring|maintaining)\b/i, label: "responsible for" },
  { pattern: /^(?:served|acted|functioned)\s+as\s+(?:a\s+)?(?:key|primary|main|go-to)\b/i, label: "served as" },
  { pattern: /^(?:played|had)\s+(?:a\s+)?(?:key|critical|vital|important)\s+role\s+in\b/i, label: "played a key role" },
  { pattern: /^(?:worked\s+(?:closely|collaboratively|cross-functionally))\s+with\b/i, label: "worked closely with" },
];

// ── Hype Word Suppression ───────────────────────────────────────
//
// Words that inflate tone beyond what facts support. Deterministically
// replaced with precise executive alternatives. No heuristic suffixing.

export const HYPE_WORDS: { pattern: RegExp; replacement: string; label: string }[] = [
  { pattern: /\bpowerhouse\b/gi, replacement: "high-performing", label: "powerhouse" },
  { pattern: /\bmarket-dominating\b/gi, replacement: "market-leading", label: "market-dominating" },
  { pattern: /\bgame-changing\b/gi, replacement: "significant", label: "game-changing" },
  { pattern: /\bgame changer\b/gi, replacement: "significant improvement", label: "game changer" },
  { pattern: /\bcatalyzed\b/gi, replacement: "initiated", label: "catalyzed" },
  { pattern: /\bcatalyze\b/gi, replacement: "initiate", label: "catalyze" },
  { pattern: /\bcatalyst\b/gi, replacement: "driver", label: "catalyst" },
  { pattern: /\bgroundbreaking\b/gi, replacement: "first-of-its-kind", label: "groundbreaking" },
  { pattern: /\brevolutionized\b/gi, replacement: "redesigned", label: "revolutionized" },
  { pattern: /\brevolutionize\b/gi, replacement: "redesign", label: "revolutionize" },
  { pattern: /\bworld-class\b/gi, replacement: "enterprise-grade", label: "world-class" },
  { pattern: /\bbest-in-class\b/gi, replacement: "competitive", label: "best-in-class" },
  { pattern: /\bcutting-edge\b/gi, replacement: "modern", label: "cutting-edge" },
  { pattern: /\bstate-of-the-art\b/gi, replacement: "advanced", label: "state-of-the-art" },
  { pattern: /\bskyrocketed\b/gi, replacement: "increased significantly", label: "skyrocketed" },
  { pattern: /\bunprecedented\b/gi, replacement: "notable", label: "unprecedented" },
  { pattern: /\btransformative\b/gi, replacement: "impactful", label: "transformative" },
  { pattern: /\bexponential(?:ly)?\b/gi, replacement: "substantial", label: "exponential" },
  { pattern: /\bmassive\b/gi, replacement: "large-scale", label: "massive" },
  { pattern: /\bseismic\b/gi, replacement: "significant", label: "seismic" },
  { pattern: /\bdisruptive\b/gi, replacement: "innovative", label: "disruptive" },
  { pattern: /\bblew past\b/gi, replacement: "exceeded", label: "blew past" },
  { pattern: /\brunaway success\b/gi, replacement: "strong result", label: "runaway success" },
  { pattern: /\btrailblazing\b/gi, replacement: "leading", label: "trailblazing" },
  { pattern: /\bparadigm[- ]shift\b/gi, replacement: "strategic change", label: "paradigm shift" },
];

export interface HypeWordResult {
  total_found: number;
  replacements: { location: string; word: string; replacement: string }[];
}

function hypeWordSuppression(resume: TailoredResume): HypeWordResult {
  const replacements: { location: string; word: string; replacement: string }[] = [];

  function scanAndReplace(text: string, location: string): string {
    let result = text;
    for (const hw of HYPE_WORDS) {
      hw.pattern.lastIndex = 0;
      const match = result.match(hw.pattern);
      if (match) {
        result = result.replace(hw.pattern, hw.replacement);
        replacements.push({ location, word: match[0], replacement: hw.replacement });
      }
    }
    return result;
  }

  // Scan summary
  resume.professional_summary = scanAndReplace(resume.professional_summary, "summary");

  // Scan bullets and scope lines
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      resume.experience[i].bullets[j].text = scanAndReplace(
        resume.experience[i].bullets[j].text,
        `experience[${i}].bullets[${j}]`,
      );
    }
    const exp = resume.experience[i] as any;
    if (exp.scope_line) {
      exp.scope_line = scanAndReplace(exp.scope_line, `experience[${i}].scope_line`);
    }
  }

  return { total_found: replacements.length, replacements };
}

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
 * Bullet Authority Pass:
 * - Detect AND auto-fix soft verb openers (supported → Strengthened, helped → Drove)
 * - Detect passive voice starters
 * - Detect stacked clauses (3+ commas = over-complex)
 * - Detect safe managerial phrasing ("managed day-to-day", "played a key role")
 * - Each bullet should read like a board-level performance summary
 *
 * Auto-fix behavior: soft verbs are replaced in-place with executive alternatives.
 */
function refineBulletTone(resume: TailoredResume): ToneViolation[] {
  const violations: ToneViolation[] = [];

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const text = bullet.text;
      const loc = `experience[${i}].bullets[${j}]`;

      // Check soft verbs at start of bullet — AUTO-FIX
      const firstWord = text.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      if (SOFT_VERBS.includes(firstWord)) {
        const replacement = SOFT_VERB_REPLACEMENTS[firstWord];
        if (replacement) {
          // Safe auto-fix: replace only the leading word (no indexOf heuristic)
          bullet.text = text.replace(/^\S+/, replacement);
          violations.push({
            location: loc,
            issue: `soft_verb_opener: "${firstWord}" → auto-fixed to "${replacement}"`,
            original: text.substring(0, 60),
          });
        } else {
          violations.push({
            location: loc,
            issue: `soft_verb_opener: "${firstWord}"`,
            original: text.substring(0, 60),
          });
        }
      }

      // Check passive voice starters
      for (const pattern of PASSIVE_STARTERS) {
        if (pattern.test(bullet.text)) {
          violations.push({
            location: loc,
            issue: "passive_voice_opener",
            original: bullet.text.substring(0, 60),
          });
          break;
        }
      }

      // Check stacked clauses (3+ commas indicate over-complexity) — AUTO-FIX
      const commaCount = (bullet.text.match(/,/g) || []).length;
      if (commaCount >= 3) {
        // Auto-fix: simplify by truncating at the 2nd comma boundary
        const parts = bullet.text.split(/,\s*/);
        if (parts.length >= 3) {
          // Keep the first 2 clauses + a clean ending from the 3rd
          const simplified = parts.slice(0, 2).join(", ");
          const remainder = parts.slice(2).join(", ").trim();
          // Take only the first phrase from remainder (up to next natural break)
          const endPhrase = remainder.split(/[;—]/)[0]?.trim() || "";
          bullet.text = endPhrase ? `${simplified} — ${endPhrase}` : simplified;
          // Ensure clean ending
          if (bullet.text.length > 0 && !bullet.text.match(/[.!?]$/)) {
            bullet.text = bullet.text.replace(/[,;:\s]+$/, "");
          }
        }
        violations.push({
          location: loc,
          issue: `stacked_clauses: ${commaCount} commas → auto-simplified`,
          original: text.substring(0, 60),
        });
      }

      // Check safe managerial phrasing — sounds impressive but says nothing
      for (const mp of SAFE_MANAGERIAL_PATTERNS) {
        if (mp.pattern.test(bullet.text)) {
          violations.push({
            location: loc,
            issue: `safe_managerial_phrasing: ${mp.label}`,
            original: bullet.text.substring(0, 60),
          });
          break; // One flag per bullet is enough
        }
      }
    }
  }

  return violations;
}

// ── Verb Strength Pass ──────────────────────────────────────────

export interface VerbStrengthResult {
  upgrades_applied: number;
  diversity_fixes: number;
  verb_map: Record<string, number>;     // verb → usage count after pass
  generic_verbs_remaining: number;      // "led", "built", etc. still present
  mandate_aligned_pct: number;          // % of bullets starting with mandate verbs
}

/**
 * Verb Strength Pass (ANALYSIS ONLY — no mutation):
 *
 * Analyzes verb usage patterns across the resume and returns metrics.
 * Does NOT mutate bullet text. Verb mutation was removed to prevent
 * semantic distortion (e.g., "Organized transformation", "Recruited analytics").
 *
 * Verb quality is now enforced by the Refinement Layer's controlled whitelist
 * which validates verbs against bullet content categories.
 *
 * Metrics computed:
 * - verb_map: frequency of each opener verb
 * - generic_verbs_remaining: count of overused generic verbs
 * - mandate_aligned_pct: % of bullets using mandate-specific verbs
 */
function verbStrengthPass(resume: TailoredResume, mandate: MandateProfile): VerbStrengthResult {
  const mandatePool = MANDATE_VERB_POOL[mandate.primary_mandate] || [];
  const mandateVerbSet = new Set(mandatePool.map(v => v.toLowerCase().split(/\s+/)[0]));

  // Collect all opener verbs (read-only analysis)
  const finalVerbMap: Record<string, number> = {};
  let mandateAlignedCount = 0;
  let totalBullets = 0;

  for (const exp of resume.experience) {
    for (const bullet of exp.bullets) {
      totalBullets++;
      const verb = bullet.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      finalVerbMap[verb] = (finalVerbMap[verb] || 0) + 1;
      if (mandateVerbSet.has(verb)) mandateAlignedCount++;
    }
  }

  const genericRemaining = Object.entries(finalVerbMap)
    .filter(([v]) => GENERIC_STRONG_VERBS.includes(v))
    .reduce((s, [, c]) => s + c, 0);

  return {
    upgrades_applied: 0,
    diversity_fixes: 0,
    verb_map: finalVerbMap,
    generic_verbs_remaining: genericRemaining,
    mandate_aligned_pct: totalBullets > 0 ? Math.round((mandateAlignedCount / totalBullets) * 100) : 0,
  };
}

// ── Competency Cap Enforcement ──────────────────────────────────

/** Mandate keyword relevance for competency sorting. */
const MANDATE_COMP_KEYWORDS: Record<string, string[]> = {
  governance_standardization: ["governance", "compliance", "audit", "control", "framework", "quality", "risk", "standard"],
  bi_platform_modernization: ["platform", "cloud", "architecture", "pipeline", "infrastructure", "migration", "warehouse", "lake"],
  insight_delivery_automation: ["reporting", "dashboard", "self-service", "analytics", "insight", "automation", "visualization"],
  founder_adjacent_builder: ["startup", "zero-to-one", "product", "mvp", "agile", "lean", "build"],
  revenue_ops_forecasting: ["revenue", "forecast", "pricing", "financial", "p&l", "margin", "demand"],
  operating_model_transformation: ["operating model", "transformation", "change management", "process", "optimization", "redesign"],
  product_gtm_analytics: ["product", "go-to-market", "user", "adoption", "engagement", "feature", "journey"],
  growth_monetization: ["growth", "experiment", "a/b", "conversion", "funnel", "monetization", "testing"],
  executive_storytelling: ["storytelling", "board", "executive", "strategy", "advisory", "influence", "communication"],
  team_leadership_scale: ["leadership", "team", "talent", "organizational", "hiring", "mentoring", "scaling"],
};

/**
 * Enforce competency cap at 10 items (curated, not dumped).
 * When over the cap, sort competencies by mandate relevance before trimming.
 * This ensures the most mandate-aligned competencies survive the cut.
 */
function enforceCompetencyCap(resume: TailoredResume, mandate?: MandateProfile): boolean {
  const COMPETENCY_CAP = 10; // Curated: 8-10 items for visual clarity
  const comps: string[] = (resume as any).core_competencies;
  if (!Array.isArray(comps)) return false;

  if (comps.length > COMPETENCY_CAP) {
    // Sort by mandate relevance before slicing
    if (mandate) {
      const keywords = MANDATE_COMP_KEYWORDS[mandate.primary_mandate] || [];
      const scored = comps.map(c => {
        const lower = c.toLowerCase();
        const mandateScore = keywords.filter(kw => lower.includes(kw)).length;
        return { comp: c, score: mandateScore };
      });
      scored.sort((a, b) => b.score - a.score);
      (resume as any).core_competencies = scored.slice(0, COMPETENCY_CAP).map(s => s.comp);
    } else {
      (resume as any).core_competencies = comps.slice(0, COMPETENCY_CAP);
    }
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
 * Counts logical lines (split by newlines, then by ~85 char wrapping — Calibri 11pt).
 */
function enforceSummaryDensity(resume: TailoredResume): boolean {
  const summary = resume.professional_summary;
  const lines = summary.split(/\n/).filter(l => l.trim().length > 0);

  // Estimate rendered line count (85 chars/line for Calibri 11pt, 0.7" margins)
  let estimatedLines = 0;
  for (const line of lines) {
    estimatedLines += Math.max(1, Math.ceil(line.length / 85));
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
 * Standard page ~= 48 lines (Calibri 11pt, 0.7" margins, standard resume layout)
 *
 * Character-per-line estimates use 85 chars (Calibri 11pt at 0.7" margins),
 * NOT the generic 75 chars used in earlier versions.
 */
interface PageEstimate {
  estimated_lines: number;
  estimated_pages: number;
  section_breakdown: Record<string, number>;
  exceeds_2_pages: boolean;
  compression_suggestions: string[];
}

function estimatePages(resume: TailoredResume): PageEstimate {
  const LINES_PER_PAGE = 48;
  const CHARS_PER_LINE = 85; // Calibri 11pt, 0.7" margins — measured from DOCX output
  const breakdown: Record<string, number> = {};
  const suggestions: string[] = [];
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
  const summaryLines = Math.ceil(summaryChars / CHARS_PER_LINE);
  breakdown.summary = summaryLines;
  totalLines += summaryLines;

  // Spacing after summary
  totalLines += 1;

  // Core competencies
  const comps = ((resume as any).core_competencies || []) as string[];
  const compLines = Math.ceil(comps.join(" | ").length / CHARS_PER_LINE);
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

  // Build actionable compression suggestions if over budget
  if (estimatedPages > 2.0) {
    const excessLines = totalLines - (LINES_PER_PAGE * 2);

    // Suggest dropping bullets from oldest roles
    for (let i = resume.experience.length - 1; i >= 1; i--) {
      const exp = resume.experience[i];
      const droppable = Math.max(0, exp.bullets.length - 2);
      if (droppable > 0) {
        const linesSaved = droppable * 1.5; // ~1.5 lines per bullet
        suggestions.push(`Drop ${droppable} bullet(s) from "${exp.employer}" (role ${i + 1}) — saves ~${linesSaved.toFixed(1)} lines`);
      }
    }

    // Suggest trimming competencies (cap is 10 for curated visual clarity)
    if (comps.length > 8) {
      suggestions.push(`Trim competencies from ${comps.length} to 8 — saves ~${Math.ceil((comps.length - 8) * 0.3)} lines`);
    }

    // Suggest trimming summary
    if (summaryLines > 4) {
      suggestions.push(`Trim summary from ${summaryLines} to 4 lines — saves ~${summaryLines - 4} lines`);
    }

    // Suggest dropping oldest role entirely
    if (resume.experience.length > 4) {
      const oldestRole = resume.experience[resume.experience.length - 1];
      const roleLines = 2 + (oldestRole.scope_line ? 1 : 0) + oldestRole.bullets.length * 1.5;
      suggestions.push(`Drop oldest role "${oldestRole.employer}" entirely — saves ~${roleLines.toFixed(0)} lines`);
    }

    // Suggest removing certifications if present
    if (certEntries.length > 0) {
      suggestions.push(`Remove certifications section — saves ~${breakdown.certifications + 1} lines`);
    }
  }

  return {
    estimated_lines: Math.ceil(totalLines),
    estimated_pages: Math.round(estimatedPages * 10) / 10,
    section_breakdown: breakdown,
    exceeds_2_pages: estimatedPages > 2.0,
    compression_suggestions: suggestions,
  };
}

// ── Page Band Constants ─────────────────────────────────────────
// Target: 1.6–2.0 pages. Under 1.6 = too thin (lacks executive depth).
// Over 2.0 = too long (fails ATS page limits and looks unfocused).

const PAGE_BAND_MIN = 1.6;
const PAGE_BAND_MAX = 2.0;
const MIN_ROLES = 3; // Minimum enterprise roles for career progression signal

/**
 * Attempt to compress the resume to fit within 2 pages.
 * Strategy (in order):
 * 1. Drop lowest mandate-scoring bullets from oldest roles (keep min 2)
 * 2. Compress most recent role to 3 bullets
 * 3. Trim competencies to 10
 * 4. Trim summary to 2 paragraphs
 * 5. Drop oldest roles (but NEVER below MIN_ROLES)
 *
 * HARD CONSTRAINT: Never compress below 3 roles — career progression must be visible.
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

  // Step 3: Trim competencies to 8 (aggressive — curated over dumped)
  const comps = (resume as any).core_competencies;
  if (estimate.exceeds_2_pages && Array.isArray(comps) && comps.length > 8) {
    (resume as any).core_competencies = comps.slice(0, 8);
    actions.push(`Trimmed competencies from ${comps.length} to 8`);
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

  // Step 5: Drop oldest roles if still over — but NEVER below MIN_ROLES
  if (estimate.exceeds_2_pages && resume.experience.length > MIN_ROLES) {
    const maxRemovable = resume.experience.length - MIN_ROLES;
    let removed = 0;
    while (estimate.exceeds_2_pages && removed < maxRemovable) {
      resume.experience.pop();
      removed++;
      estimate = estimatePages(resume);
    }
    if (removed > 0) {
      actions.push(`Dropped ${removed} oldest role(s) to fit 2-page budget (kept ${resume.experience.length} roles)`);
    }
  }

  // If still over 2 pages after all compression → BLOCKED
  if (estimate.exceeds_2_pages) {
    return { compressed: true, blocked: true, actions };
  }

  return { compressed: true, blocked: false, actions };
}

/**
 * EXPANSION MODE: Restore depth when resume is too thin (<1.6 pages).
 *
 * A 25+ year executive career on 1.3 pages signals lack of depth.
 * Expansion restores bullets to older roles first (cheapest line gain),
 * then promotes scope lines, and finally loosens summary density.
 *
 * Strategy (in priority order):
 * 1. Restore bullets to older roles (up to their cap)
 * 2. Ensure at least MIN_ROLES enterprise roles are present
 * 3. If summary was trimmed, allow 1 additional line
 *
 * Does NOT pad with fluff. Only restores content that was previously compressed
 * or allows existing content to render at its natural length.
 *
 * Note: Expansion Mode works on the resume AFTER compression has run.
 * It cannot add content that wasn't generated by the LLM — it can only
 * restore caps from 2→3 or 3→4 where bullets exist but were trimmed.
 */
interface ExpansionResult {
  expanded: boolean;
  actions: string[];
  pre_expansion_pages: number;
  post_expansion_pages: number;
}

function expandToPageBand(
  resume: TailoredResume,
  originalBulletCounts: number[],
): ExpansionResult {
  const actions: string[] = [];
  let estimate = estimatePages(resume);
  const prePages = estimate.estimated_pages;

  // Only expand if under the minimum band
  if (estimate.estimated_pages >= PAGE_BAND_MIN) {
    return { expanded: false, actions: [], pre_expansion_pages: prePages, post_expansion_pages: prePages };
  }

  // Step 1: Restore bullet caps for non-leading roles (3rd, 4th role → restore from 2 to 3)
  // This is the cheapest expansion: each bullet adds ~1.5 lines
  for (let i = 2; i < resume.experience.length && estimate.estimated_pages < PAGE_BAND_MIN; i++) {
    const exp = resume.experience[i];
    const originalCount = originalBulletCounts[i] || exp.bullets.length;
    const maxBullets = i <= 2 ? 3 : 2;

    // We can only "restore" if the current count is less than what was originally generated
    // The original bullet count was saved before compression
    if (exp.bullets.length < maxBullets && exp.bullets.length < originalCount) {
      // We cannot add bullets that don't exist — this is a no-op unless the LLM generated more than the cap
      // In practice, bullets were sliced, and we can't un-slice them here.
      // However, we can raise the cap for the NEXT run via the expansion signal.
      actions.push(`SIGNAL: Role "${exp.employer}" has room for ${maxBullets - exp.bullets.length} more bullet(s) — raise cap on next generation`);
    }
  }

  // Step 2: Check minimum role count
  if (resume.experience.length < MIN_ROLES) {
    actions.push(`SIGNAL: Resume has only ${resume.experience.length} roles (min ${MIN_ROLES}). Inventory may need more roles or next generation should include more.`);
  }

  // Step 3: Allow summary to expand by 1 line if it was previously trimmed
  // (We don't mutate — this is a signal for the next iteration)
  const summaryLines = Math.ceil(resume.professional_summary.length / 85);
  if (summaryLines < 4 && estimate.estimated_pages < PAGE_BAND_MIN) {
    actions.push(`SIGNAL: Summary is ${summaryLines} lines. Can expand to 4-5 lines for more executive context.`);
  }

  const postPages = estimatePages(resume).estimated_pages;

  return {
    expanded: actions.length > 0,
    actions,
    pre_expansion_pages: prePages,
    post_expansion_pages: postPages,
  };
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
  verb_strength: VerbStrengthResult;
  hype_word_suppression: HypeWordResult;
  competency_capped: boolean;
  scope_line_fixes: string[];
  summary_trimmed: boolean;
  page_estimate: PageEstimate;
  page_budget_actions: string[];
  compression_suggestions: string[];
  expansion_result: ExpansionResult;
  page_band: { min: number; max: number; actual: number; in_band: boolean };
  min_roles_met: boolean;
  blocked: boolean;
  duration_ms: number;
}

/**
 * Run all layout governance checks on a resume.
 * Mutates the resume in place and returns a report.
 *
 * Enforces the 1.6–2.0 page band:
 * - COMPRESSION MODE (>2.0 pages): Drop bullets, trim sections, cap roles
 * - EXPANSION MODE (<1.6 pages): Signal that depth needs restoration
 *
 * Returns blocked=true if the resume cannot fit within 2 pages
 * after exhausting all deterministic compression strategies.
 */
export function governLayout(resume: TailoredResume, mandate: MandateProfile): GovernorResult {
  const start = Date.now();

  // Snapshot original bullet counts before any compression (for expansion mode)
  const originalBulletCounts = resume.experience.map(exp => exp.bullets.length);

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

  // 6b. Verb Strength Pass (mandate-aligned upgrades + diversity enforcement)
  const verbStrength = verbStrengthPass(resume, mandate);

  // 6c. Hype Word Suppression (deterministic removal of inflated language)
  const hypeWordResult = hypeWordSuppression(resume);

  // 7. Competency cap (8-10, mandate-sorted)
  const competencyCapped = enforceCompetencyCap(resume, mandate);

  // 8. Scope line enforcement (1 line max, ~120 chars)
  const scopeLineFixes = enforceScopeLines(resume);

  // 9. Summary density enforcement (max 5 lines)
  const summaryTrimmed = enforceSummaryDensity(resume);

  // 10. Page estimation + compression to 2-page budget (Compression Mode)
  const pageBudget = compressToPageBudget(resume);

  // 11. Expansion Mode — restore depth if resume is too thin (<1.6 pages)
  const expansionResult = expandToPageBand(resume, originalBulletCounts);

  // Final page estimate after all adjustments
  const pageEstimate = estimatePages(resume);

  // Track page band compliance
  const actualPages = pageEstimate.estimated_pages;
  const inBand = actualPages >= PAGE_BAND_MIN && actualPages <= PAGE_BAND_MAX;
  const minRolesMet = resume.experience.length >= MIN_ROLES;

  return {
    resume,
    compression_report: compressionReport,
    chronology_reordered: chronologyReordered,
    bullet_cap_result: bulletCapResult,
    word_limit_truncations: wordLimitTruncations,
    filler_removals: fillerRemovals,
    tone_violations: toneViolations,
    verb_strength: verbStrength,
    hype_word_suppression: hypeWordResult,
    competency_capped: competencyCapped,
    scope_line_fixes: scopeLineFixes,
    summary_trimmed: summaryTrimmed,
    page_estimate: pageEstimate,
    page_budget_actions: pageBudget.actions,
    compression_suggestions: pageEstimate.compression_suggestions,
    expansion_result: expansionResult,
    page_band: {
      min: PAGE_BAND_MIN,
      max: PAGE_BAND_MAX,
      actual: actualPages,
      in_band: inBand,
    },
    min_roles_met: minRolesMet,
    blocked: pageBudget.blocked,
    duration_ms: Date.now() - start,
  };
}
