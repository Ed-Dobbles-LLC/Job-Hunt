/**
 * Resume Divergence Enforcer — Ensures each tailored resume is meaningfully
 * distinct from the last 3 resumes generated.
 *
 * Checks:
 * 1. Executive summary overlap > 50% → force rewrite with archetype framing
 * 2. Competency cluster overlap > 70% → force reweight
 * 3. Top 2 bullets per role unchanged → force reorder
 *
 * Also provides archetype-driven summary framing directives based on the
 * dominant job mandate archetype.
 *
 * Storage: Uses `resume_history` table in PostgreSQL to persist the last N
 * resume snapshots (summary, competencies, top bullets) for comparison.
 */

import { query } from "./db";
import type { TailoredResume } from "./tailoredResumePrompt";
import type { MandateProfile } from "./mandateClassifier";

// ── Thresholds (tightened for elite-caliber differentiation) ────
const SUMMARY_OVERLAP_THRESHOLD = 0.30;   // >30% overlap = too similar (tightened from 40%)
const COMPETENCY_OVERLAP_THRESHOLD = 0.50; // >50% overlap = too similar (tightened from 60%)
const BULLET_SIMILARITY_THRESHOLD = 0.40;  // >40% top-3 bullet similarity = too similar (tightened from 50%)
const MIN_ROLES_WITH_DIFFERENT_TOP2 = 0.6; // At least 60% of roles must have different top-2 bullets (tightened from 50%)

// ── Global Phrase Suppression List ──────────────────────────────
// These stock phrases are banned across ALL outputs to force syntactic variation.
const GLOBAL_SUPPRESSED_PHRASES = [
  "track record of",
  "proven ability to",
  "extensive experience in",
  "passionate about",
  "results-oriented",
  "data-driven leader",
  "transforming organizations",
  "cross-functional collaboration",
  "stakeholder management",
  "end-to-end",
  "best-in-class",
  "world-class",
  "cutting-edge",
  "state-of-the-art",
  "leveraging data",
  "actionable insights",
  "data-informed decisions",
  "driving value",
  "unlocking value",
  "fostering a culture of",
  "spearheaded the development",
  "instrumental in",
  "at the forefront of",
];

// ── Resume Snapshot (what we store per resume) ──────────────────
export interface ResumeSnapshot {
  job_id: number;
  target_company: string;
  target_role: string;
  summary_text: string;
  competencies: string[];
  top_bullets_by_role: string[][]; // For each role, the top 3 bullet texts
  archetype_primary: string;
  key_phrases: string[];          // Distinctive phrases used in this resume
  created_at: string;
}

// ── Divergence Result ───────────────────────────────────────────
export interface DivergenceResult {
  compared_against: number;       // How many prior resumes were compared
  summary_overlaps: { job_id: number; company: string; overlap_pct: number }[];
  competency_overlaps: { job_id: number; company: string; overlap_pct: number }[];
  bullet_staleness: { job_id: number; company: string; unchanged_roles: number; total_roles: number }[];
  bullet_similarity: { job_id: number; company: string; similarity_pct: number }[];
  suppressed_phrases: string[];   // Phrases to avoid (already used in prior resumes)
  needs_rewrite: boolean;
  rewrite_reasons: string[];
  divergence_prompt: string;      // Prompt addendum for the LLM to force divergence
}

// ── Archetype-driven summary framing ────────────────────────────
const ARCHETYPE_SUMMARY_FRAMING: Record<string, {
  lead_with: string;
  tone: string;
  opening_pattern: string;
  opening_examples: string[];
  first_sentence_anchor: string;
  avoid: string[];
  banned_openers: string[];
}> = {
  governance_standardization: {
    lead_with: "control, reporting rigor, operating discipline, metric standardization",
    tone: "Governance-first: emphasize frameworks, compliance, data quality, and metric discipline",
    opening_pattern: "Anchor the first sentence on CONTROL and RIGOR — what this person imposes on chaos, not what they've scaled.",
    opening_examples: [
      "Every metric in a $4B portfolio traces to a single governed definition because [Name] built the framework that enforces it.",
      "When reporting said one thing and finance said another, [candidate] was brought in to make the numbers speak one language.",
    ],
    first_sentence_anchor: "The first sentence must reflect control, discipline, or standardization — the dominant mandate of this role.",
    avoid: ["platform modernization", "dashboard design", "founder alignment", "architecture"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  bi_platform_modernization: {
    lead_with: "architecture, data platform modernization, cloud migration, infrastructure design",
    tone: "Architecture-first: emphasize platform decisions, migration outcomes, and technical leadership at scale",
    opening_pattern: "Anchor the first sentence on ARCHITECTURE and SCALABILITY — what was designed and why it had to change.",
    opening_examples: [
      "Replaced a 15-year-old on-prem warehouse with a cloud-native lakehouse serving 2,000+ analysts across 4 business units.",
      "The platform decision that unlocked real-time analytics for [org] was made by [candidate] — and it's still running 3 years later.",
    ],
    first_sentence_anchor: "The first sentence must reflect architecture, modernization, or platform scalability — the dominant mandate of this role.",
    avoid: ["governance frameworks", "reporting cadence", "founder alignment", "KPI clarity"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  insight_delivery_automation: {
    lead_with: "insight delivery, stakeholder clarity, reporting cadence, self-service analytics",
    tone: "Delivery-first: emphasize how insights reach decision-makers, reporting automation, and stakeholder satisfaction",
    opening_pattern: "Anchor the first sentence on CLARITY and STAKEHOLDER ENABLEMENT — how decisions get made faster because of this person.",
    opening_examples: [
      "Eliminated the 3-day reporting lag that left executives flying blind — automated delivery now reaches 400+ stakeholders in real time.",
      "Before [candidate] arrived, business leaders waited a week for answers. Now they self-serve in minutes.",
    ],
    first_sentence_anchor: "The first sentence must reflect insight delivery, stakeholder enablement, or reporting clarity — the dominant mandate of this role.",
    avoid: ["platform architecture", "governance frameworks", "founder alignment", "pricing optimization"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  founder_adjacent_builder: {
    lead_with: "dashboard design, KPI clarity, founder alignment, zero-to-one analytics",
    tone: "Builder-first: emphasize what was created from scratch, speed of execution, and direct founder/CEO partnership",
    opening_pattern: "Anchor the first sentence on CREATION FROM ZERO — what didn't exist before this person showed up.",
    opening_examples: [
      "There was no analytics function, no data warehouse, and no reporting cadence — [candidate] built all three in 6 months.",
      "First data hire in a Series B startup. Stood up the entire analytics stack, hired the team, and delivered the KPIs the board needed to greenlight Series C.",
    ],
    first_sentence_anchor: "The first sentence must reflect zero-to-one building, speed, or founder-level partnership — the dominant mandate of this role.",
    avoid: ["enterprise governance", "platform migration", "reporting cadence", "board advisory"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  revenue_ops_forecasting: {
    lead_with: "revenue optimization, demand forecasting, pricing analytics, P&L influence",
    tone: "Revenue-first: emphasize financial outcomes, forecasting accuracy, and commercial impact",
    opening_pattern: "Anchor the first sentence on FINANCIAL IMPACT — the revenue moved, the margin protected, the forecast that held.",
    opening_examples: [
      "The pricing model that added $12M in annual margin wasn't inherited — it was designed, tested, and deployed by [candidate].",
      "Forecast accuracy went from 68% to 94% within two quarters. Pipeline visibility went from monthly to daily.",
    ],
    first_sentence_anchor: "The first sentence must reflect revenue impact, forecasting accuracy, or commercial analytics — the dominant mandate of this role.",
    avoid: ["governance frameworks", "platform architecture", "dashboard design", "founder alignment"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  operating_model_transformation: {
    lead_with: "operating model transformation, embedded analytics, data democratization",
    tone: "Transformation-first: emphasize before/after operating model shift and organizational change",
    opening_pattern: "Anchor the first sentence on REDESIGN OF HOW INSIGHTS ARE CONSUMED — the before/after operating model shift.",
    opening_examples: [
      "Replaced a centralized request-queue model with embedded analytics pods across 5 business units — self-service adoption went from 12% to 78%.",
      "The old model: 200 ad-hoc requests per week. The new model: 3 embedded teams, zero queue, real-time decisions.",
    ],
    first_sentence_anchor: "The first sentence must reflect operating model redesign, embedded analytics, or organizational transformation — the dominant mandate of this role.",
    avoid: ["governance compliance", "platform migration", "founder alignment", "reporting cadence"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  product_gtm_analytics: {
    lead_with: "product analytics, go-to-market measurement, user journey optimization",
    tone: "Product-first: emphasize product metrics, feature adoption, and GTM analytics",
    opening_pattern: "Anchor the first sentence on PRODUCT SIGNAL — what user behavior revealed and how it changed the product.",
    opening_examples: [
      "The feature adoption spike that justified a $20M product investment started with the instrumentation framework [candidate] built.",
      "Identified the onboarding drop-off that was costing 15% of new users per month — redesigned the measurement system and closed the gap.",
    ],
    first_sentence_anchor: "The first sentence must reflect product analytics, user journey optimization, or GTM measurement — the dominant mandate of this role.",
    avoid: ["enterprise governance", "platform migration", "reporting cadence", "founder alignment"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  growth_monetization: {
    lead_with: "growth analytics, experimentation velocity, conversion optimization, monetization",
    tone: "Growth-first: emphasize experimentation, conversion rates, and monetization outcomes",
    opening_pattern: "Anchor the first sentence on EXPERIMENTATION VELOCITY or CONVERSION IMPACT — the growth engine this person built.",
    opening_examples: [
      "Took experimentation velocity from 2 tests/month to 40 — the resulting conversion lift added $8M in annual revenue.",
      "The paywall optimization that increased ARPU by 23% came from a testing framework [candidate] built from scratch.",
    ],
    first_sentence_anchor: "The first sentence must reflect experimentation, conversion optimization, or monetization — the dominant mandate of this role.",
    avoid: ["enterprise governance", "platform architecture", "reporting cadence", "board advisory"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  executive_storytelling: {
    lead_with: "board advisory, executive influence, data-driven storytelling, strategic alignment",
    tone: "Advisory-first: emphasize board-level presentations, C-suite partnership, and strategic influence",
    opening_pattern: "Anchor the first sentence on INFLUENCE and DECISION QUALITY — what decisions were made differently because of this person.",
    opening_examples: [
      "The board voted to double the AI investment after a single presentation — [candidate] built the business case and the data behind it.",
      "When the CEO needed to decide between 3 market entry strategies, [candidate] framed the data that made the call clear.",
    ],
    first_sentence_anchor: "The first sentence must reflect executive influence, board advisory, or strategic decision enablement — the dominant mandate of this role.",
    avoid: ["platform architecture", "dashboard design", "founder alignment", "experimentation"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
  team_leadership_scale: {
    lead_with: "team building, organizational design, talent strategy, scaling analytics functions",
    tone: "Leadership-first: emphasize team growth, org design, and talent development at scale",
    opening_pattern: "Anchor the first sentence on ORGANIZATIONAL DESIGN — what the org looked like before and after this person built it.",
    opening_examples: [
      "Inherited 3 analysts with no structure. Left behind a 45-person globally distributed org with 4 specialized pods and a 92% retention rate.",
      "Designed the analytics org structure that survived 3 reorgs and a merger — because it was built around capability, not headcount.",
    ],
    first_sentence_anchor: "The first sentence must reflect org design, team building, or talent strategy — the dominant mandate of this role.",
    avoid: ["platform architecture", "governance compliance", "founder alignment", "experimentation"],
    banned_openers: ["Data and analytics leader who", "Executive with a track record of", "Analytics executive transforming", "Seasoned leader with"],
  },
};

// ── DB Operations ───────────────────────────────────────────────

/**
 * Ensure the resume_history table exists.
 */
export async function ensureResumeHistoryTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS resume_history (
        id SERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES jobs(job_id),
        target_company TEXT,
        target_role TEXT,
        summary_text TEXT,
        competencies JSONB DEFAULT '[]'::jsonb,
        top_bullets_by_role JSONB DEFAULT '[]'::jsonb,
        archetype_primary TEXT,
        key_phrases JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Add key_phrases column if table already exists without it
    await query(`ALTER TABLE resume_history ADD COLUMN IF NOT EXISTS key_phrases JSONB DEFAULT '[]'::jsonb`);
  } catch {
    // Table might already exist or DB might be unavailable — non-fatal
  }
}

/**
 * Store a resume snapshot after successful generation.
 */
export async function storeResumeSnapshot(
  resume: TailoredResume,
  jobId: number,
  archetypePrimary: string,
): Promise<void> {
  const topBulletsByRole = resume.experience.map(exp =>
    exp.bullets.slice(0, 3).map(b => typeof b === "string" ? b : b.text),
  );

  const competencies = (resume as any).core_competencies || [];
  const keyPhrases = extractKeyPhrases(resume);

  try {
    await query(
      `INSERT INTO resume_history (job_id, target_company, target_role, summary_text, competencies, top_bullets_by_role, archetype_primary, key_phrases)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        jobId,
        resume.target_company,
        resume.target_role,
        resume.professional_summary,
        JSON.stringify(competencies),
        JSON.stringify(topBulletsByRole),
        archetypePrimary,
        JSON.stringify(keyPhrases),
      ],
    );
  } catch {
    // Non-fatal — divergence enforcement degrades gracefully without history
  }
}

/**
 * Load the last N resume snapshots (excluding the current job).
 */
export async function loadRecentSnapshots(
  currentJobId: number,
  limit: number = 3,
): Promise<ResumeSnapshot[]> {
  try {
    const result = await query(
      `SELECT job_id, target_company, target_role, summary_text, competencies, top_bullets_by_role, archetype_primary, key_phrases, created_at
       FROM resume_history
       WHERE job_id != $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [currentJobId, limit],
    );

    return result.rows.map((row: any) => ({
      job_id: row.job_id,
      target_company: row.target_company,
      target_role: row.target_role,
      summary_text: row.summary_text,
      competencies: typeof row.competencies === "string" ? JSON.parse(row.competencies) : (row.competencies || []),
      top_bullets_by_role: typeof row.top_bullets_by_role === "string" ? JSON.parse(row.top_bullets_by_role) : (row.top_bullets_by_role || []),
      archetype_primary: row.archetype_primary,
      key_phrases: typeof row.key_phrases === "string" ? JSON.parse(row.key_phrases) : (row.key_phrases || []),
      created_at: row.created_at,
    }));
  } catch {
    return []; // DB unavailable — no history to compare
  }
}

/**
 * Extract distinctive phrases (3+ word chunks) from a resume for phrase tracking.
 */
function extractKeyPhrases(resume: TailoredResume): string[] {
  const phrases: string[] = [];
  const summary = resume.professional_summary;

  // Extract 3-5 word phrases from summary sentences
  const sentences = summary.split(/[.!?]\s+/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(w => w.length > 3);
    // Sliding window of 3-4 words
    for (let i = 0; i <= words.length - 3; i++) {
      phrases.push(words.slice(i, i + 3).join(" ").toLowerCase());
      if (i <= words.length - 4) {
        phrases.push(words.slice(i, i + 4).join(" ").toLowerCase());
      }
    }
  }

  // Extract opening phrases from first bullet of each role
  for (const exp of resume.experience) {
    if (exp.bullets.length > 0) {
      const firstBullet = exp.bullets[0].text;
      const words = firstBullet.split(/\s+/).filter(w => w.length > 3);
      if (words.length >= 3) {
        phrases.push(words.slice(0, 3).join(" ").toLowerCase());
      }
    }
  }

  return [...new Set(phrases)];
}

/**
 * Calculate top-3 bullet text similarity between two resumes.
 */
function topBulletSimilarity(
  currentBullets: string[][],
  priorBullets: string[][],
): number {
  const minRoles = Math.min(currentBullets.length, priorBullets.length);
  if (minRoles === 0) return 0;

  let totalOverlap = 0;
  let totalComparisons = 0;

  for (let i = 0; i < minRoles; i++) {
    const current = currentBullets[i] || [];
    const prior = priorBullets[i] || [];
    const maxBullets = Math.min(3, current.length, prior.length);

    for (let j = 0; j < maxBullets; j++) {
      if (current[j] && prior[j]) {
        totalOverlap += textOverlap(current[j], prior[j]);
        totalComparisons++;
      }
    }
  }

  return totalComparisons > 0 ? totalOverlap / totalComparisons : 0;
}

// ── Comparison Logic ────────────────────────────────────────────

/**
 * Calculate word-level overlap between two texts (0-1 scale).
 * Uses significant words only (>3 chars) for meaningful comparison.
 */
function textOverlap(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const smaller = Math.min(wordsA.size, wordsB.size);
  return intersection.size / smaller;
}

/**
 * Calculate competency set overlap (0-1 scale).
 */
function competencyOverlap(compsA: string[], compsB: string[]): number {
  const setA = new Set(compsA.map(c => c.toLowerCase().trim()));
  const setB = new Set(compsB.map(c => c.toLowerCase().trim()));
  if (setA.size === 0 || setB.size === 0) return 0;

  const intersection = new Set([...setA].filter(c => setB.has(c)));
  const smaller = Math.min(setA.size, setB.size);
  return intersection.size / smaller;
}

/**
 * Check how many roles have identical top-3 bullets between two resumes.
 */
function bulletStaleness(
  currentTopBullets: string[][],
  priorTopBullets: string[][],
): { unchangedRoles: number; totalRoles: number } {
  const minRoles = Math.min(currentTopBullets.length, priorTopBullets.length);
  let unchanged = 0;

  for (let i = 0; i < minRoles; i++) {
    const currentTop = currentTopBullets[i]?.map(b => b.toLowerCase().trim()) || [];
    const priorTop = priorTopBullets[i]?.map(b => b.toLowerCase().trim()) || [];

    // Check top 3 bullets for similarity
    let sameBullets = 0;
    const maxCheck = Math.min(3, currentTop.length, priorTop.length);
    for (let j = 0; j < maxCheck; j++) {
      if (currentTop[j] && priorTop[j] && textOverlap(currentTop[j], priorTop[j]) > 0.8) {
        sameBullets++;
      }
    }

    // If 2+ of top-3 are the same, consider it unchanged
    if (sameBullets >= 2) unchanged++;
  }

  return { unchangedRoles: unchanged, totalRoles: minRoles };
}

// ── Main Divergence Check ───────────────────────────────────────

/**
 * Compare a newly generated resume against the last 3 stored resumes.
 * Returns divergence analysis and a prompt addendum to force rewriting if needed.
 */
export async function checkDivergenceAgainstHistory(
  resume: TailoredResume,
  jobId: number,
  mandate: MandateProfile,
): Promise<DivergenceResult> {
  const priorResumes = await loadRecentSnapshots(jobId, 3);

  const result: DivergenceResult = {
    compared_against: priorResumes.length,
    summary_overlaps: [],
    competency_overlaps: [],
    bullet_staleness: [],
    bullet_similarity: [],
    suppressed_phrases: [],
    needs_rewrite: false,
    rewrite_reasons: [],
    divergence_prompt: "",
  };

  if (priorResumes.length === 0) {
    return result; // No history — nothing to compare
  }

  const currentCompetencies = (resume as any).core_competencies || [];
  const currentTopBullets = resume.experience.map(exp =>
    exp.bullets.slice(0, 3).map(b => typeof b === "string" ? b : b.text),
  );

  // Collect all prior key phrases for suppression
  const allPriorPhrases = new Set<string>();
  for (const prior of priorResumes) {
    for (const phrase of prior.key_phrases || []) {
      allPriorPhrases.add(phrase.toLowerCase());
    }
  }

  // Check current resume against prior phrases
  const currentPhrases = extractKeyPhrases(resume);
  for (const phrase of currentPhrases) {
    if (allPriorPhrases.has(phrase)) {
      result.suppressed_phrases.push(phrase);
    }
  }

  // Also suppress globally banned stock phrases found in the resume
  const resumeFullText = [
    resume.professional_summary,
    ...resume.experience.flatMap(e => e.bullets.map(b => b.text)),
  ].join(" ").toLowerCase();
  for (const banned of GLOBAL_SUPPRESSED_PHRASES) {
    if (resumeFullText.includes(banned.toLowerCase())) {
      if (!result.suppressed_phrases.includes(banned)) {
        result.suppressed_phrases.push(banned);
      }
    }
  }

  let worstSummaryOverlap = 0;
  let worstCompOverlap = 0;
  let worstBulletSimilarity = 0;
  let anyBulletsStale = false;

  for (const prior of priorResumes) {
    // Summary overlap
    const summaryOvlp = textOverlap(resume.professional_summary, prior.summary_text);
    result.summary_overlaps.push({
      job_id: prior.job_id,
      company: prior.target_company,
      overlap_pct: Math.round(summaryOvlp * 100),
    });
    if (summaryOvlp > worstSummaryOverlap) worstSummaryOverlap = summaryOvlp;

    // Competency overlap
    const compOvlp = competencyOverlap(currentCompetencies, prior.competencies);
    result.competency_overlaps.push({
      job_id: prior.job_id,
      company: prior.target_company,
      overlap_pct: Math.round(compOvlp * 100),
    });
    if (compOvlp > worstCompOverlap) worstCompOverlap = compOvlp;

    // Top-3 bullet similarity (new)
    const bulletSim = topBulletSimilarity(currentTopBullets, prior.top_bullets_by_role);
    result.bullet_similarity.push({
      job_id: prior.job_id,
      company: prior.target_company,
      similarity_pct: Math.round(bulletSim * 100),
    });
    if (bulletSim > worstBulletSimilarity) worstBulletSimilarity = bulletSim;

    // Bullet staleness (role-level)
    const staleness = bulletStaleness(currentTopBullets, prior.top_bullets_by_role);
    result.bullet_staleness.push({
      job_id: prior.job_id,
      company: prior.target_company,
      unchanged_roles: staleness.unchangedRoles,
      total_roles: staleness.totalRoles,
    });
    if (staleness.totalRoles > 0 && staleness.unchangedRoles / staleness.totalRoles >= MIN_ROLES_WITH_DIFFERENT_TOP2) {
      anyBulletsStale = true;
    }
  }

  // Determine if rewrite is needed (tightened thresholds)
  if (worstSummaryOverlap > SUMMARY_OVERLAP_THRESHOLD) {
    result.needs_rewrite = true;
    result.rewrite_reasons.push(
      `Executive summary overlap ${Math.round(worstSummaryOverlap * 100)}% with prior resume (threshold: ${SUMMARY_OVERLAP_THRESHOLD * 100}%)`,
    );
  }

  if (worstCompOverlap > COMPETENCY_OVERLAP_THRESHOLD) {
    result.needs_rewrite = true;
    result.rewrite_reasons.push(
      `Competency cluster overlap ${Math.round(worstCompOverlap * 100)}% with prior resume (threshold: ${COMPETENCY_OVERLAP_THRESHOLD * 100}%)`,
    );
  }

  if (worstBulletSimilarity > BULLET_SIMILARITY_THRESHOLD) {
    result.needs_rewrite = true;
    result.rewrite_reasons.push(
      `Top-3 bullet similarity ${Math.round(worstBulletSimilarity * 100)}% with prior resume (threshold: ${BULLET_SIMILARITY_THRESHOLD * 100}%)`,
    );
  }

  if (anyBulletsStale) {
    result.needs_rewrite = true;
    result.rewrite_reasons.push(
      "Top 3 bullets per role are too similar to a prior resume — force reorder",
    );
  }

  // Check for globally banned stock phrases in the resume
  const bannedPhrasesFound = result.suppressed_phrases.filter(p =>
    GLOBAL_SUPPRESSED_PHRASES.some(g => g.toLowerCase() === p.toLowerCase()),
  );
  if (bannedPhrasesFound.length >= 3) {
    result.needs_rewrite = true;
    result.rewrite_reasons.push(
      `${bannedPhrasesFound.length} globally banned stock phrases detected: ${bannedPhrasesFound.slice(0, 5).map(p => `"${p}"`).join(", ")}`,
    );
  }

  // Build divergence prompt if rewrite needed
  if (result.needs_rewrite) {
    result.divergence_prompt = buildDivergencePrompt(resume, priorResumes, mandate, result);
  }

  return result;
}

// ── Divergence Correction Prompt ────────────────────────────────

function buildDivergencePrompt(
  resume: TailoredResume,
  priorResumes: ResumeSnapshot[],
  mandate: MandateProfile,
  divergenceResult: DivergenceResult,
): string {
  const archetypeFraming = ARCHETYPE_SUMMARY_FRAMING[mandate.primary_mandate];
  const priorSummaries = priorResumes
    .map((p, i) => `  Resume ${i + 1} (${p.target_company} — ${p.target_role}):\n    "${p.summary_text.substring(0, 200)}..."`)
    .join("\n");

  const priorCompetencies = priorResumes
    .map((p, i) => `  Resume ${i + 1} (${p.target_company}): [${p.competencies.slice(0, 6).join(", ")}...]`)
    .join("\n");

  let prompt = `## CROSS-RESUME DIVERGENCE CORRECTION — MANDATORY

Your resume is TOO SIMILAR to recent resumes. Each tailored resume must feel meaningfully distinct.

### PROBLEMS DETECTED
${divergenceResult.rewrite_reasons.map((r, i) => `${i + 1}. ${r}`).join("\n")}

### PRIOR RESUME SUMMARIES (DO NOT REUSE THIS PHRASING)
${priorSummaries}

### PRIOR COMPETENCY CLUSTERS (MUST BE DIFFERENT)
${priorCompetencies}

### CORRECTION RULES
1. The Executive Summary MUST use different narrative framing than the prior resumes.
2. Do NOT reuse the same opening sentence or paragraph structure.
3. Reweight competencies to match THIS job's dominant archetype.
4. Reorder top-2 bullets per role to highlight different achievements.
5. Each resume must feel like it was written for a DIFFERENT type of role.
`;

  if (archetypeFraming) {
    prompt += `
### ARCHETYPE-DRIVEN SUMMARY FRAMING
This job's dominant archetype is: ${mandate.primary_mandate.replace(/_/g, " ").toUpperCase()}

**SUMMARY ARCHITECTURE RULE — FIRST SENTENCE:**
${archetypeFraming.first_sentence_anchor}
${archetypeFraming.opening_pattern}

**Example openings (adapt to candidate's actual facts):**
${archetypeFraming.opening_examples.map(e => `  - ${e}`).join("\n")}

**Lead the Executive Summary with:** ${archetypeFraming.lead_with}
**Tone:** ${archetypeFraming.tone}

**BANNED OPENERS — these are REJECTED on sight:**
${archetypeFraming.banned_openers.map(b => `  - "${b}..."`).join("\n")}

**AVOID these themes in the summary** (they belong to OTHER archetypes):
${archetypeFraming.avoid.map(a => `  - ${a}`).join("\n")}
`;
  }

  if (divergenceResult.suppressed_phrases.length > 0) {
    prompt += `
### SUPPRESSED PHRASES (already used in prior resumes — DO NOT REUSE)
${divergenceResult.suppressed_phrases.slice(0, 20).map(p => `  - "${p}"`).join("\n")}
Use DIFFERENT language patterns. Each resume must feel linguistically distinct.
`;
  }

  prompt += `
### DIVERGENCE TARGETS (TIGHTENED)
- Summary word overlap with ANY prior resume: < 30%
- Competency cluster overlap with ANY prior resume: < 50%
- Top-3 bullet similarity with ANY prior resume: < 40%
- At least 60% of roles must have DIFFERENT top-3 bullets than any prior resume
- Opening sentence of Executive Summary must be UNIQUE
- Re-cluster competencies using different wording while staying truthful
- Zero globally banned stock phrases (see suppressed list above)

Return the CORRECTED TailoredResume JSON with meaningfully different framing.`;

  return prompt;
}

/**
 * Get the archetype-driven summary framing for a given mandate.
 * Used by the initial generation prompt to guide summary tone from the start.
 */
export function getArchetypeSummaryFraming(
  mandate: MandateProfile,
): string {
  const framing = ARCHETYPE_SUMMARY_FRAMING[mandate.primary_mandate];
  if (!framing) return "";

  return `## ARCHETYPE-DRIVEN SUMMARY FRAMING
This job's dominant archetype is: ${mandate.primary_mandate.replace(/_/g, " ").toUpperCase()}

### SUMMARY ARCHITECTURE RULE — FIRST SENTENCE (NON-NEGOTIABLE)
${framing.first_sentence_anchor}
${framing.opening_pattern}

The first sentence must NOT open with scale, team size, or revenue.
The first sentence must NOT use reusable structural phrasing like "[Domain] leader who has..."
The first sentence must be psychologically anchored to THIS job's mandate.

**Example openings (adapt to candidate's actual inventory facts):**
${framing.opening_examples.map(e => `  - ${e}`).join("\n")}

**BANNED OPENERS — these are REJECTED on sight:**
${framing.banned_openers.map(b => `  - "${b}..."`).join("\n")}
Do NOT open with ANY variation of these patterns. Each summary must feel unique.

**Lead the Executive Summary with:** ${framing.lead_with}
**Tone:** ${framing.tone}

**AVOID these themes as the lead** (they belong to OTHER archetypes):
${framing.avoid.map(a => `  - ${a}`).join("\n")}

Summary MUST be ≤ 5 lines. No repeated phrasing across outputs. No repetition of first bullet.
Do NOT reuse prior summary phrasing. Each resume must have a distinct narrative arc.`;
}
