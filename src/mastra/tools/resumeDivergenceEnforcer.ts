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

// ── Thresholds ──────────────────────────────────────────────────
const SUMMARY_OVERLAP_THRESHOLD = 0.50;   // >50% overlap = too similar
const COMPETENCY_OVERLAP_THRESHOLD = 0.70; // >70% overlap = too similar
const MIN_ROLES_WITH_DIFFERENT_TOP2 = 0.5; // At least 50% of roles must have different top-2 bullets

// ── Resume Snapshot (what we store per resume) ──────────────────
export interface ResumeSnapshot {
  job_id: number;
  target_company: string;
  target_role: string;
  summary_text: string;
  competencies: string[];
  top_bullets_by_role: string[][]; // For each role, the top 2 bullet texts
  archetype_primary: string;
  created_at: string;
}

// ── Divergence Result ───────────────────────────────────────────
export interface DivergenceResult {
  compared_against: number;       // How many prior resumes were compared
  summary_overlaps: { job_id: number; company: string; overlap_pct: number }[];
  competency_overlaps: { job_id: number; company: string; overlap_pct: number }[];
  bullet_staleness: { job_id: number; company: string; unchanged_roles: number; total_roles: number }[];
  needs_rewrite: boolean;
  rewrite_reasons: string[];
  divergence_prompt: string;      // Prompt addendum for the LLM to force divergence
}

// ── Archetype-driven summary framing ────────────────────────────
const ARCHETYPE_SUMMARY_FRAMING: Record<string, {
  lead_with: string;
  tone: string;
  opening_pattern: string;
  avoid: string[];
}> = {
  governance_standardization: {
    lead_with: "control, reporting rigor, operating discipline, metric standardization",
    tone: "Governance-first: emphasize frameworks, compliance, data quality, and metric discipline",
    opening_pattern: "[Domain] leader who has established governance frameworks and standardized reporting across [scale] — delivering [metric rigor outcome].",
    avoid: ["platform modernization", "dashboard design", "founder alignment", "architecture"],
  },
  bi_platform_modernization: {
    lead_with: "architecture, data platform modernization, cloud migration, infrastructure design",
    tone: "Architecture-first: emphasize platform decisions, migration outcomes, and technical leadership at scale",
    opening_pattern: "[Domain] executive who has architected and modernized enterprise data platforms serving [scale] — [migration/modernization outcome].",
    avoid: ["governance frameworks", "reporting cadence", "founder alignment", "KPI clarity"],
  },
  insight_delivery_automation: {
    lead_with: "insight delivery, stakeholder clarity, reporting cadence, self-service analytics",
    tone: "Delivery-first: emphasize how insights reach decision-makers, reporting automation, and stakeholder satisfaction",
    opening_pattern: "[Domain] leader who has transformed how [org scale] consumes data — shifting from [old model] to [new model] and delivering [outcome].",
    avoid: ["platform architecture", "governance frameworks", "founder alignment", "pricing optimization"],
  },
  founder_adjacent_builder: {
    lead_with: "dashboard design, KPI clarity, founder alignment, zero-to-one analytics",
    tone: "Builder-first: emphasize what was created from scratch, speed of execution, and direct founder/CEO partnership",
    opening_pattern: "[Domain] builder who has stood up analytics functions from zero — [what was built] — partnering directly with [founders/CEO] to [outcome].",
    avoid: ["enterprise governance", "platform migration", "reporting cadence", "board advisory"],
  },
  revenue_ops_forecasting: {
    lead_with: "revenue optimization, demand forecasting, pricing analytics, P&L influence",
    tone: "Revenue-first: emphasize financial outcomes, forecasting accuracy, and commercial impact",
    opening_pattern: "[Domain] executive who has driven [revenue/margin outcome] through [analytics approach] across [scale].",
    avoid: ["governance frameworks", "platform architecture", "dashboard design", "founder alignment"],
  },
  operating_model_transformation: {
    lead_with: "operating model transformation, embedded analytics, data democratization",
    tone: "Transformation-first: emphasize before/after operating model shift and organizational change",
    opening_pattern: "[Domain] executive who has transformed how [org] operates — from [old model] to [new model] — delivering [outcome] across [scale].",
    avoid: ["governance compliance", "platform migration", "founder alignment", "reporting cadence"],
  },
  product_gtm_analytics: {
    lead_with: "product analytics, go-to-market measurement, user journey optimization",
    tone: "Product-first: emphasize product metrics, feature adoption, and GTM analytics",
    opening_pattern: "[Domain] leader who has built product analytics capabilities driving [adoption/engagement outcome] across [scale].",
    avoid: ["enterprise governance", "platform migration", "reporting cadence", "founder alignment"],
  },
  growth_monetization: {
    lead_with: "growth analytics, experimentation velocity, conversion optimization, monetization",
    tone: "Growth-first: emphasize experimentation, conversion rates, and monetization outcomes",
    opening_pattern: "[Domain] leader who has scaled experimentation and growth analytics — driving [conversion/revenue outcome] across [scale].",
    avoid: ["enterprise governance", "platform architecture", "reporting cadence", "board advisory"],
  },
  executive_storytelling: {
    lead_with: "board advisory, executive influence, data-driven storytelling, strategic alignment",
    tone: "Advisory-first: emphasize board-level presentations, C-suite partnership, and strategic influence",
    opening_pattern: "[Domain] executive who partners with [C-suite/board] to translate [data capability] into [strategic outcome] across [scale].",
    avoid: ["platform architecture", "dashboard design", "founder alignment", "experimentation"],
  },
  team_leadership_scale: {
    lead_with: "team building, organizational design, talent strategy, scaling analytics functions",
    tone: "Leadership-first: emphasize team growth, org design, and talent development at scale",
    opening_pattern: "[Domain] leader who has built and scaled analytics organizations from [start size] to [end size] — [talent/org outcome] across [sectors].",
    avoid: ["platform architecture", "governance compliance", "founder alignment", "experimentation"],
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
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
    exp.bullets.slice(0, 2).map(b => typeof b === "string" ? b : b.text),
  );

  const competencies = (resume as any).core_competencies || [];

  try {
    await query(
      `INSERT INTO resume_history (job_id, target_company, target_role, summary_text, competencies, top_bullets_by_role, archetype_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        jobId,
        resume.target_company,
        resume.target_role,
        resume.professional_summary,
        JSON.stringify(competencies),
        JSON.stringify(topBulletsByRole),
        archetypePrimary,
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
      `SELECT job_id, target_company, target_role, summary_text, competencies, top_bullets_by_role, archetype_primary, created_at
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
      created_at: row.created_at,
    }));
  } catch {
    return []; // DB unavailable — no history to compare
  }
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
 * Check how many roles have identical top-2 bullets between two resumes.
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

    // Both top bullets match = unchanged
    const top1Same = currentTop[0] && priorTop[0] && textOverlap(currentTop[0], priorTop[0]) > 0.8;
    const top2Same = currentTop[1] && priorTop[1] && textOverlap(currentTop[1], priorTop[1]) > 0.8;

    if (top1Same && top2Same) unchanged++;
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
    needs_rewrite: false,
    rewrite_reasons: [],
    divergence_prompt: "",
  };

  if (priorResumes.length === 0) {
    return result; // No history — nothing to compare
  }

  const currentCompetencies = (resume as any).core_competencies || [];
  const currentTopBullets = resume.experience.map(exp =>
    exp.bullets.slice(0, 2).map(b => typeof b === "string" ? b : b.text),
  );

  let worstSummaryOverlap = 0;
  let worstCompOverlap = 0;
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

    // Bullet staleness
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

  // Determine if rewrite is needed
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

  if (anyBulletsStale) {
    result.needs_rewrite = true;
    result.rewrite_reasons.push(
      "Top 2 bullets per role are unchanged from a prior resume — force reorder",
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

**Lead the Executive Summary with:** ${archetypeFraming.lead_with}
**Tone:** ${archetypeFraming.tone}
**Opening pattern:** ${archetypeFraming.opening_pattern}

**AVOID these themes in the summary** (they belong to OTHER archetypes):
${archetypeFraming.avoid.map(a => `  - ${a}`).join("\n")}
`;
  }

  prompt += `
### DIVERGENCE TARGETS
- Summary word overlap with ANY prior resume: < 50%
- Competency cluster overlap with ANY prior resume: < 70%
- At least 50% of roles must have DIFFERENT top-2 bullets than any prior resume
- Opening sentence of Executive Summary must be UNIQUE

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

**Lead the Executive Summary with:** ${framing.lead_with}
**Tone:** ${framing.tone}
**Opening pattern (adapt to candidate's actual facts):** ${framing.opening_pattern}

**AVOID these themes as the lead** (they belong to OTHER archetypes):
${framing.avoid.map(a => `  - ${a}`).join("\n")}

Do NOT reuse prior summary phrasing. Each resume must have a distinct narrative arc.`;
}
