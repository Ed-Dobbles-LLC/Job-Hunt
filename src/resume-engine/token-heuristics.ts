/**
 * Token Heuristics — single source of truth for malformed-token detection.
 *
 * History: three independent copies of an "impossible consonant cluster"
 * regex (qa-gate, refinement-layer, post-processing-controller) drifted and
 * false-positived on ordinary analytics vocabulary (insights, consistently,
 * strengths, cycles). All layers now import from here.
 *
 * Rules:
 *  - "y" is excluded from the consonant class — it functions as a vowel in
 *    exactly the words resumes use (cycles, rhythm, analytics, dynamics).
 *  - Word START: legal English onsets max out at 3 consonants. The only
 *    legitimate 4-consonant starts are sch- loanwords/proper nouns
 *    (Schwab, Schmidt, Schneider), which resumes do contain.
 *  - Word END: English legitimately ends words with 4-consonant runs
 *    (insights "ghts", attempts "mpts"), so the threshold is 5+ with an
 *    allowlist of legal 5-runs (strengths "ngths", twelfths "lfths",
 *    sixths "xths").
 */

const CONSONANTS = "bcdfghjklmnpqrstvwxz"; // y intentionally excluded

const START_RUN = new RegExp(`^[${CONSONANTS}]+`);
const END_RUN = new RegExp(`[${CONSONANTS}]+$`);

export const LEGAL_END_RUNS = new Set(["ngths", "lfths", "xths"]);

/** True if the word begins with an impossible consonant cluster. */
export function impossibleClusterAtStart(word: string): boolean {
  const run = (word.toLowerCase().match(START_RUN) || [""])[0];
  return (run.length >= 4 && !run.startsWith("sch")) || run.length >= 6;
}

/** True if the word ends with an impossible consonant cluster. */
export function impossibleClusterAtEnd(word: string): boolean {
  const run = (word.toLowerCase().match(END_RUN) || [""])[0];
  return run.length >= 5 && !LEGAL_END_RUNS.has(run);
}

/**
 * Orphaned single consonant, apostrophe-aware.
 * The naive \b[consonant]\b pattern fires on the "s" in "Google's" and
 * "Let's" because the apostrophe creates a word boundary. Possessives and
 * contractions (straight ' or curly \u2019) are not corruption.
 */
export const ORPHANED_CONSONANT = /(?<!['\u2019])\b[bcdfghjklmnpqrstvwxz]\b(?!['\u2019])/i;

/**
 * Banned AI-isms (candidate brand-voice list) with same-part-of-speech
 * replacements. Lesson from the powerhouse bug: never swap a noun for an
 * adjective — it corrupts sentences. Verbs map to verbs, nouns to nouns.
 * "journey" and "navigate" are phrase-scoped to avoid clobbering legitimate
 * terms of art (customer journey maps, navigation products).
 */
export const BANNED_AI_ISMS: { pattern: RegExp; replacement: string; label: string }[] = [
  { pattern: /\bleveraging\b/gi, replacement: "using", label: "leveraging" },
  { pattern: /\bleveraged\b/gi, replacement: "used", label: "leveraged" },
  { pattern: /\bleverages\b/gi, replacement: "uses", label: "leverages" },
  { pattern: /\bleverage\b/gi, replacement: "use", label: "leverage" },
  { pattern: /\butilizing\b/gi, replacement: "using", label: "utilizing" },
  { pattern: /\butilized\b/gi, replacement: "used", label: "utilized" },
  { pattern: /\butilizes\b/gi, replacement: "uses", label: "utilizes" },
  { pattern: /\butilize\b/gi, replacement: "use", label: "utilize" },
  { pattern: /\bdelving\b/gi, replacement: "digging", label: "delving" },
  { pattern: /\bdelved?\b/gi, replacement: "dug", label: "delve" },
  { pattern: /\bunlocking\b/gi, replacement: "enabling", label: "unlocking" },
  { pattern: /\bunlocked\b/gi, replacement: "enabled", label: "unlocked" },
  { pattern: /\bunlocks\b/gi, replacement: "enables", label: "unlocks" },
  { pattern: /\bunlock\b/gi, replacement: "enable", label: "unlock" },
  { pattern: /\bsynergies\b/gi, replacement: "efficiencies", label: "synergies" },
  { pattern: /\bsynergy\b/gi, replacement: "alignment", label: "synergy" },
  { pattern: /\bholistically\b/gi, replacement: "comprehensively", label: "holistically" },
  { pattern: /\bholistic\b/gi, replacement: "comprehensive", label: "holistic" },
  { pattern: /\bgame-changer\b/gi, replacement: "step change", label: "game-changer" },
  // Phrase-scoped: figurative uses only
  { pattern: /\b(my|our|career|professional)\s+journey\b/gi, replacement: "$1 career", label: "journey (figurative)" },
  { pattern: /\bnavigating\s+(the\s+)?(complexit\w+|challeng\w+|landscape\w*|ambiguity|uncertainty)\b/gi, replacement: "managing $1$2", label: "navigate (figurative)" },
  { pattern: /\bnavigate\s+(the\s+)?(complexit\w+|challeng\w+|landscape\w*|ambiguity|uncertainty)\b/gi, replacement: "manage $1$2", label: "navigate (figurative)" },
];
