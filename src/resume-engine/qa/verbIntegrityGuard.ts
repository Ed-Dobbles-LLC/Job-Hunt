/**
 * Verb Integrity + Semantic Drift Guard
 *
 * A deterministic QA step that runs post-LLM generation (after Stage 4)
 * and before layout (Stage 6). Catches two classes of defects:
 *
 *   1. MALFORMED TOKEN ARTIFACTS — doubled suffixes, corrupted words
 *      from string manipulation errors (e.g., "Influencedd", "Briefedd")
 *
 *   2. VERB SEMANTIC DRIFT — wrong verb for bullet content category
 *      (e.g., "Mentored growth…", "Organized analytics model…")
 *
 * Repair strategy:
 *   - Deterministic fix when safe (remove doubled suffix, swap verb)
 *   - Flag for LLM repair when multiple/complex issues remain
 *
 * Integration: pipeline.ts inserts this between Stage 4 and Stage 5.
 */

import type { TailoredResume } from "../../mastra/tools/tailoredResumePrompt";

// ── Types ───────────────────────────────────────────────────────

export interface VerbGuardOptions {
  /** If true, only detect — do not auto-repair (default: false) */
  detectOnly?: boolean;
  /** Logger for diagnostics */
  logger?: any;
}

export interface VerbIssue {
  type: "CORRUPTION" | "SEMANTIC_DRIFT" | "HYPE_VERB";
  location: string;
  original: string;
  replacement?: string;
  auto_fixed: boolean;
  category?: string;
  explanation: string;
}

export interface VerbGuardResult {
  issues: VerbIssue[];
  auto_fixed_count: number;
  remaining_count: number;
  needs_llm_repair: boolean;
  duration_ms: number;
}

// ── Corruption Patterns ─────────────────────────────────────────

/**
 * Patterns that detect malformed tokens from LLM string manipulation.
 * Each pattern has a regex to detect and a fix function.
 */
export const CORRUPTION_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  fix: (match: string) => string | null;
}> = [
  {
    // Words ending in "dd" that aren't legitimate (e.g., "Influencedd", "Briefedd")
    name: "doubled-terminal-d",
    pattern: /\b([A-Z][a-z]+)dd\b/g,
    fix: (match) => {
      // Skip legitimate names/words ending in "dd"
      const LEGIT_DD = new Set(["add", "odd", "todd", "kidd", "ladd", "budd", "rudd", "mudd", "dodd"]);
      if (LEGIT_DD.has(match.toLowerCase())) return null;
      // "Influencedd" → "Influenced", "Briefedd" → "Briefed"
      return match.slice(0, -1);
    },
  },
  {
    // Lowercase doubled-terminal-d (e.g., "recruitedd", "mentoredd")
    name: "doubled-terminal-d-lower",
    pattern: /\b([a-z]+)dd\b/g,
    fix: (match) => {
      // Skip legitimate "dd" words
      const LEGIT_DD = new Set(["add", "odd", "todd", "kidd", "ladd", "budd", "rudd", "mudd", "dodd"]);
      if (LEGIT_DD.has(match.toLowerCase())) return null;
      return match.slice(0, -1);
    },
  },
  {
    // Doubled "-ed" suffix: "implementeded", "establisheded"
    // Must skip legitimate English words like "succeeded", "needed", "exceeded".
    name: "doubled-ed",
    pattern: /\b(\w+ed)ed\b/gi,
    fix: (match) => {
      const LEGIT_EDED = new Set([
        "succeeded", "exceeded", "preceded", "proceeded",
        "needed", "seeded", "heeded", "deeded", "weeded",
        "superseded", "acceded", "conceded", "receded",
        "interceded", "ceded", "impeded", "stampeded",
      ]);
      if (LEGIT_EDED.has(match.toLowerCase())) return null;
      return match.slice(0, -2);
    },
  },
  {
    // Doubled "-ing" suffix: "managinging", "implementinging"
    // Must skip legitimate English words like "singing", "bringing".
    name: "doubled-ing",
    pattern: /\b(\w+ing)ing\b/gi,
    fix: (match) => {
      const LEGIT_INGING = new Set([
        "singing", "bringing", "ringing", "stinging",
        "clinging", "wringing", "stringing", "swinging",
        "springing", "flinging", "slinging", "dinging",
        "pinging", "winging", "zinging", "tingeing",
      ]);
      if (LEGIT_INGING.has(match.toLowerCase())) return null;
      return match.slice(0, -3);
    },
  },
  {
    // Doubled "-ized" → "-izeded": "optimizeded"
    name: "doubled-ized-ed",
    pattern: /\b(\w+ized)ed\b/gi,
    fix: (match) => match.slice(0, -2),
  },
  {
    // Doubled "-ated": "generatedated"
    name: "doubled-ated",
    pattern: /\b(\w+ated)ated\b/gi,
    fix: (match) => match.slice(0, -4),
  },
];

// ── Verb-Action Category Map ────────────────────────────────────

/**
 * Maps bullet content categories to their appropriate leading verbs.
 * Used to detect semantic drift (e.g., "Mentored" starting a growth bullet).
 */
export const CATEGORY_VERB_MAP: Record<string, {
  valid_verbs: string[];
  content_cues: RegExp[];
}> = {
  growth_revenue: {
    valid_verbs: [
      "generated", "increased", "drove", "delivered", "grew", "accelerated",
      "expanded", "produced", "captured", "boosted", "secured", "achieved",
      "attained", "realized", "yielded",
    ],
    content_cues: [
      /\$[\d.]+[MBK]/i, /\d+%/, /revenue/i, /growth/i, /savings/i, /cost/i,
      /profit/i, /ARR/i, /ROI/i, /pipeline/i, /margin/i, /EBITDA/i,
    ],
  },
  build_scale_org: {
    valid_verbs: [
      "built", "scaled", "established", "formed", "recruited", "hired",
      "assembled", "grew", "expanded", "staffed", "structured", "stood up",
    ],
    content_cues: [
      /\d+-person/i, /team/i, /organization/i, /department/i, /function/i,
      /\bpractice\b/i, /center of excellence/i, /from\s+\d+\s+to\s+\d+/i,
      /headcount/i, /FTE/i,
    ],
  },
  platform_implementation: {
    valid_verbs: [
      "implemented", "deployed", "integrated", "automated", "architected",
      "migrated", "engineered", "designed", "developed", "launched",
      "configured", "modernized", "replatformed",
    ],
    content_cues: [
      /platform/i, /system/i, /pipeline/i, /infrastructure/i, /stack/i,
      /framework/i, /API/i, /cloud/i, /Snowflake/i, /dbt/i, /Spark/i,
      /Kubernetes/i, /Docker/i, /ETL/i, /data\s+lake/i,
    ],
  },
  governance_standardization: {
    valid_verbs: [
      "standardized", "defined", "governed", "aligned", "codified",
      "formalized", "instituted", "established", "introduced", "enacted",
    ],
    content_cues: [
      /governance/i, /policy/i, /standard/i, /compliance/i, /framework/i,
      /process/i, /methodology/i, /SOX/i, /audit/i, /quality/i,
    ],
  },
  reporting_okr: {
    valid_verbs: [
      "operationalized", "instituted", "streamlined", "automated",
      "established", "launched", "created", "introduced", "designed",
    ],
    content_cues: [
      /reporting/i, /dashboard/i, /OKR/i, /KPI/i, /cadence/i,
      /metrics/i, /scorecard/i, /weekly\s+review/i, /executive\s+report/i,
    ],
  },
};

/**
 * Verbs that almost always signal semantic drift when used as bullet starters
 * for non-mentorship/non-interpersonal content.
 */
export const MISFIT_VERBS: Record<string, {
  verbs: string[];
  misfit_for: string[];
  explanation: string;
}> = {
  mentor_coach: {
    verbs: ["mentored", "coached", "tutored", "guided", "counseled"],
    misfit_for: ["growth_revenue", "platform_implementation", "governance_standardization", "build_scale_org"],
    explanation: "Mentoring/coaching verbs imply interpersonal development, not building/scaling/delivering",
  },
  organize_arrange: {
    verbs: ["organized", "arranged", "coordinated", "scheduled"],
    misfit_for: ["growth_revenue", "platform_implementation", "build_scale_org"],
    explanation: "Organizing/arranging verbs suggest event planning, not strategic delivery",
  },
  elevate_uplift: {
    verbs: ["elevated", "uplifted", "raised", "enhanced"],
    misfit_for: ["platform_implementation", "governance_standardization", "reporting_okr"],
    explanation: "Vague elevation verbs lack specificity for technical/process content",
  },
};

/**
 * Hype verbs that are inappropriate for resume bullets regardless of category.
 */
export const HYPE_VERB_LIST: string[] = [
  "catalyzed", "revolutionized", "disrupted", "spearheaded",
  "pioneered", "synergized", "leveraged", "ideated",
  "evangelized", "championed",
];

// ── Detection Functions ─────────────────────────────────────────

/**
 * Extract the leading verb (1-2 tokens) from a bullet.
 */
function extractLeadingVerb(bullet: string): string | null {
  const trimmed = bullet.trim();
  // Match leading word that looks like a verb (past tense or base form)
  const match = trimmed.match(/^([A-Za-z]+(?:ed|ing|ized|ated)?)\b/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Infer the content category of a bullet by keyword cues.
 * Returns the best-matching category, or null if ambiguous.
 */
function inferBulletCategory(bulletText: string): string | null {
  let bestCategory: string | null = null;
  let bestScore = 0;

  for (const [category, { content_cues }] of Object.entries(CATEGORY_VERB_MAP)) {
    const score = content_cues.filter(cue => cue.test(bulletText)).length;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestScore >= 1 ? bestCategory : null;
}

/**
 * Get a replacement verb for a misfit verb in a given category.
 * Picks the first valid verb from the category's list.
 */
function getCategoryReplacement(category: string, currentVerb: string): string | null {
  const catData = CATEGORY_VERB_MAP[category];
  if (!catData) return null;

  // Pick the first verb that isn't the current one
  for (const verb of catData.valid_verbs) {
    if (verb.toLowerCase() !== currentVerb.toLowerCase()) {
      return verb;
    }
  }
  return catData.valid_verbs[0] || null;
}

/**
 * Capitalize the first letter of a word (for bullet-start replacement).
 */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ── Main Guard Function ─────────────────────────────────────────

/**
 * Run the verb integrity and semantic drift guard on a resume.
 *
 * Scans all bullets for:
 *   1. Corrupted/malformed tokens → deterministic repair
 *   2. Semantic verb drift → deterministic verb swap
 *   3. Hype verbs → flag (not auto-replaced here, deferred to Stage 6)
 *
 * Mutates `resume` in place when auto-fixing (unless detectOnly=true).
 * Returns structured results for pipeline logging.
 */
export function runVerbIntegrityGuard(
  resume: TailoredResume,
  opts: VerbGuardOptions = {},
): VerbGuardResult {
  const start = Date.now();
  const issues: VerbIssue[] = [];
  const detectOnly = opts.detectOnly ?? false;

  // ── 1. Scan for corruption in all text sections ───────────────

  const textSections: Array<{ text: string; location: string; setter: (text: string) => void }> = [];

  // Summary
  textSections.push({
    text: resume.professional_summary,
    location: "resume.professional_summary",
    setter: (t) => { resume.professional_summary = t; },
  });

  // Experience bullets
  for (let expIdx = 0; expIdx < resume.experience.length; expIdx++) {
    const exp = resume.experience[expIdx];
    for (let bIdx = 0; bIdx < exp.bullets.length; bIdx++) {
      textSections.push({
        text: exp.bullets[bIdx].text,
        location: `resume.experience[${expIdx}].bullets[${bIdx}]`,
        setter: (t) => { exp.bullets[bIdx].text = t; },
      });
    }
    if (exp.scope_line) {
      textSections.push({
        text: exp.scope_line,
        location: `resume.experience[${expIdx}].scope_line`,
        setter: (t) => { (exp as any).scope_line = t; },
      });
    }
  }

  for (const section of textSections) {
    let currentText = section.text;
    let modified = false;

    for (const cp of CORRUPTION_PATTERNS) {
      const matches = [...currentText.matchAll(new RegExp(cp.pattern.source, cp.pattern.flags))];
      for (const match of matches) {
        const original = match[0];
        const fixed = cp.fix(original);

        if (fixed && fixed !== original) {
          issues.push({
            type: "CORRUPTION",
            location: section.location,
            original,
            replacement: fixed,
            auto_fixed: !detectOnly,
            explanation: `Malformed token "${original}" (${cp.name}) → "${fixed}"`,
          });

          if (!detectOnly) {
            currentText = currentText.replace(original, fixed);
            modified = true;
          }
        }
      }
    }

    if (modified) {
      section.setter(currentText);
    }
  }

  // ── 2. Scan bullets for semantic verb drift ────────────────────

  for (let expIdx = 0; expIdx < resume.experience.length; expIdx++) {
    const exp = resume.experience[expIdx];
    for (let bIdx = 0; bIdx < exp.bullets.length; bIdx++) {
      const bullet = exp.bullets[bIdx];
      const verb = extractLeadingVerb(bullet.text);
      if (!verb) continue;

      const location = `resume.experience[${expIdx}].bullets[${bIdx}]`;
      const category = inferBulletCategory(bullet.text);

      // Check misfit verbs
      for (const [, misfitGroup] of Object.entries(MISFIT_VERBS)) {
        const isMisfitVerb = misfitGroup.verbs.some(v => v.toLowerCase() === verb);
        if (!isMisfitVerb) continue;

        const isMisfitCategory = category && misfitGroup.misfit_for.includes(category);
        if (!isMisfitCategory) continue;

        // This verb is a misfit for this bullet's content
        const replacement = category ? getCategoryReplacement(category, verb) : null;

        if (replacement && !detectOnly) {
          // Deterministic swap: capitalize and replace leading verb
          const verbPattern = new RegExp(`^${verb}`, "i");
          const capitalizedReplacement = bullet.text.charAt(0) === bullet.text.charAt(0).toUpperCase()
            ? capitalize(replacement)
            : replacement;
          bullet.text = bullet.text.replace(verbPattern, capitalizedReplacement);
        }

        issues.push({
          type: "SEMANTIC_DRIFT",
          location,
          original: verb,
          replacement: replacement ?? undefined,
          auto_fixed: !!replacement && !detectOnly,
          category: category ?? undefined,
          explanation: `"${capitalize(verb)}" is a misfit for ${category} content. ${misfitGroup.explanation}`,
        });
        break; // One misfit detection per bullet
      }

      // Check hype verbs
      if (HYPE_VERB_LIST.includes(verb)) {
        issues.push({
          type: "HYPE_VERB",
          location,
          original: verb,
          auto_fixed: false, // Hype suppression deferred to Stage 6
          explanation: `Hype verb "${verb}" at bullet start — will be handled by Stage 6 suppression`,
        });
      }
    }
  }

  // ── 3. Compute result ─────────────────────────────────────────

  const autoFixed = issues.filter(i => i.auto_fixed).length;
  const remaining = issues.filter(i => !i.auto_fixed).length;
  const needsLLMRepair = remaining > 2; // Threshold: >2 unfixed issues suggest LLM repair

  opts.logger?.info(`🔤 [VerbGuard] ${issues.length} issue(s): ${autoFixed} auto-fixed, ${remaining} remaining${needsLLMRepair ? " → LLM repair recommended" : ""}`);
  for (const issue of issues) {
    const prefix = issue.auto_fixed ? "✅" : "⚠️";
    opts.logger?.info(`  ${prefix} [${issue.type}] ${issue.location}: "${issue.original}"${issue.replacement ? ` → "${issue.replacement}"` : ""}`);
  }

  return {
    issues,
    auto_fixed_count: autoFixed,
    remaining_count: remaining,
    needs_llm_repair: needsLLMRepair,
    duration_ms: Date.now() - start,
  };
}
