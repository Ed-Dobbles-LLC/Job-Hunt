/**
 * Stage 3: Bullet Scoring
 *
 * Extracts and enhances bullet scoring into a standalone pipeline stage.
 * Wraps the existing mandate-based keyword scoring from mandateClassifier.ts,
 * adds claim ID linkage from the claims ledger, and provides optional
 * embedding-based semantic scoring via OpenAI text-embedding-3-small.
 *
 * Exports:
 *   - scoreBullets()           — full scoring pipeline producing ScoredBulletPlan
 *   - computeEmbeddingScores() — optional embedding-based semantic similarity
 *   - linkClaimIds()           — claim ledger linkage for a single bullet
 */

import {
  scoreBulletsAgainstMandate,
  reorderBulletsPerRole,
  identifyMandateGaps,
  analyzeRequirementGaps,
  type GapAnalysisResult,
} from "../../mastra/tools/mandateClassifier";
import type {
  ScoredBullet,
  ScoredBulletPlan,
  ReorderedRole,
  MandateGap,
  ClarificationQuestion,
  ClaimsLedger,
  Claim,
  MandateProfile,
  EmbeddingConfig,
} from "../types";
import type { JDRequirements, RequirementItem } from "../../mastra/tools/extractJDRequirementsTool";

// ── Lazy OpenAI Client (for embeddings) ─────────────────────────

let _openaiClient: import("openai").default | null = null;

function getOpenAIClient(): import("openai").default {
  if (!_openaiClient) {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY env var.");
    }
    // Dynamic require avoids import-time side effects; the openai package
    // is already a declared dependency.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: OpenAI } = require("openai") as typeof import("openai");
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

// ── Text Normalization ──────────────────────────────────────────

/**
 * Normalize a string for fuzzy substring comparison: lowercase, collapse
 * whitespace, strip punctuation that is irrelevant for matching.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''""]/g, "'")
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Claim ID Linkage ────────────────────────────────────────────

/**
 * Find all claim IDs in the ledger that relate to a given bullet.
 *
 * Matching strategy (OR — any match counts):
 *   1. The claim's `id` equals the bullet's `bullet_id` (direct hash match).
 *   2. The normalized claim `value` is a substring of the normalized bullet text.
 *   3. The normalized bullet text is a substring of the normalized claim value
 *      (covers cases where the bullet is a truncated version of the claim).
 *   4. The claim's `source_span.original_text` overlaps with the bullet text.
 *
 * Returns de-duplicated claim IDs.
 */
export function linkClaimIds(
  bulletId: string,
  bulletText: string,
  ledger: ClaimsLedger,
): string[] {
  const matched = new Set<string>();
  const normalizedBullet = normalize(bulletText);

  // Skip matching when bullet text is too short to be meaningful
  if (normalizedBullet.length < 5) return [];

  for (const claim of ledger.claims) {
    // Strategy 1: Direct ID match
    if (claim.id === bulletId) {
      matched.add(claim.id);
      continue;
    }

    const normalizedValue = normalize(claim.value);

    // Strategy 2: Claim value is a substring of bullet text
    if (normalizedValue.length >= 4 && normalizedBullet.includes(normalizedValue)) {
      matched.add(claim.id);
      continue;
    }

    // Strategy 3: Bullet text is a substring of claim value
    if (normalizedBullet.length >= 8 && normalizedValue.includes(normalizedBullet)) {
      matched.add(claim.id);
      continue;
    }

    // Strategy 4: Source span overlap
    if (claim.source_span?.original_text) {
      const normalizedSpan = normalize(claim.source_span.original_text);
      if (
        (normalizedSpan.length >= 8 && normalizedBullet.includes(normalizedSpan)) ||
        (normalizedBullet.length >= 8 && normalizedSpan.includes(normalizedBullet))
      ) {
        matched.add(claim.id);
      }
    }
  }

  return Array.from(matched);
}

// ── Embedding-Based Scoring ─────────────────────────────────────

/**
 * Compute cosine similarity between two vectors of equal length.
 * Returns 0 if either vector is zero-length or all zeros.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute embedding-based semantic similarity scores between each bullet
 * and the job description text.
 *
 * Uses OpenAI's text-embedding-3-small (or the model specified in config).
 * Returns a Map<bulletText, score> with scores normalized to [0, 1].
 *
 * Falls back gracefully on API errors: logs a warning and returns an empty
 * map so the pipeline continues with mandate-only scoring.
 */
export async function computeEmbeddingScores(
  bullets: string[],
  jdText: string,
  config: EmbeddingConfig,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();

  if (!config.enabled || bullets.length === 0 || !jdText.trim()) {
    return scores;
  }

  try {
    const client = getOpenAIClient();

    // Embed all texts in a single batch: [jdText, ...bullets]
    // The first embedding is the JD; the rest are bullets.
    const allTexts = [jdText, ...bullets];

    const response = await client.embeddings.create({
      model: config.model || "text-embedding-3-small",
      input: allTexts,
    });

    // OpenAI returns embeddings in the same order as input
    const embeddings = response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);

    const jdEmbedding = embeddings[0];

    for (let i = 0; i < bullets.length; i++) {
      const bulletEmbedding = embeddings[i + 1];
      const similarity = cosineSimilarity(jdEmbedding, bulletEmbedding);
      // Clamp to [0, 1] — cosine similarity for normalized embeddings is
      // already in [-1, 1] but negative values are irrelevant for us.
      scores.set(bullets[i], Math.max(0, Math.min(1, similarity)));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[stage3-bullet-scoring] Embedding scoring failed, falling back to mandate-only scoring: ${message}`,
    );
    // Return empty map — the pipeline blends with weight 0 for embeddings
  }

  return scores;
}

// ── Gap → Clarification Question Conversion ─────────────────────

/**
 * Determine whether a requirement string originated from a must_have
 * or nice_to_have section of the JD requirements.
 */
function classifyGapSeverity(
  requirementText: string,
  jdRequirements?: JDRequirements,
): ClarificationQuestion["gap_severity"] {
  if (!jdRequirements) return "nice_to_have";

  const reqLower = requirementText.toLowerCase();

  // Check must_have items
  for (const item of jdRequirements.must_have || []) {
    const itemText = typeof item === "string" ? item : (item as RequirementItem).text || "";
    if (itemText.toLowerCase().includes(reqLower) || reqLower.includes(itemText.toLowerCase())) {
      return "must_have";
    }
  }

  // Check leadership_scope (treated as must_have since it defines role scope)
  for (const item of jdRequirements.leadership_scope || []) {
    const itemText = typeof item === "string" ? item : (item as RequirementItem).text || "";
    if (itemText.toLowerCase().includes(reqLower) || reqLower.includes(itemText.toLowerCase())) {
      return "must_have";
    }
  }

  return "nice_to_have";
}

/**
 * Convert the existing GapAnalysisResult format into ClarificationQuestion format.
 * Only converts gaps where the requirement is NOT in the ledger.
 */
function convertGapsToQuestions(
  gaps: GapAnalysisResult[],
  jdRequirements?: JDRequirements,
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  for (const gap of gaps) {
    // Only generate questions for items not found in the ledger
    if (gap.in_ledger) continue;

    const severity = classifyGapSeverity(gap.requirement, jdRequirements);

    // Use the existing clarification question if available, otherwise
    // generate an actionable "Do you have...?" format question.
    const question = gap.clarification_question
      ? gap.clarification_question
      : `Do you have direct experience with ${gap.requirement}? If so, what specific results did you achieve?`;

    questions.push({
      jd_requirement: gap.requirement,
      question,
      closest_ledger_match: gap.closest_match,
      gap_severity: severity,
    });
  }

  return questions;
}

// ── Mandate Gap Adaptation ──────────────────────────────────────

/**
 * Adapt the raw mandate gap format from identifyMandateGaps into the
 * pipeline's MandateGap type (they are structurally identical but this
 * ensures type safety across the pipeline boundary).
 */
function adaptMandateGaps(
  rawGaps: ReturnType<typeof identifyMandateGaps>,
): MandateGap[] {
  return rawGaps.map((g) => ({
    dimension_id: g.dimension_id,
    label: g.label,
    weight: g.weight,
    best_coverage: g.best_coverage,
    suggestion: g.suggestion,
  }));
}

// ── Revenue Detection ────────────────────────────────────────────

const REVENUE_KEYWORDS = [
  "revenue", "arr", "mrr", "gmv", "sales", "bookings", "margin",
  "profit", "monetiz", "pricing", "p&l", "yield", "arpu", "ltv",
  "conversion", "upsell", "cross-sell",
];

const REVENUE_MANDATE_IDS = [
  "revenue_ops_forecasting",
  "growth_monetization",
];

/**
 * Detect whether a bullet is primarily about revenue/financial outcomes.
 * Returns true if ≥2 revenue keywords are present.
 */
function isRevenueDominantBullet(bulletText: string): boolean {
  const lower = bulletText.toLowerCase();
  let hits = 0;
  for (const kw of REVENUE_KEYWORDS) {
    if (lower.includes(kw)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// ── Recency Scoring ─────────────────────────────────────────────

/**
 * Compute a recency factor for a bullet based on which role it belongs to.
 * Most recent role = 1.0, each older role decays by 0.1.
 * Range: [0.3, 1.0]
 */
function computeRecencyScore(
  experienceId: string,
  inventory: Record<string, any>,
): number {
  const experience = inventory.experience || [];
  // Experience is assumed reverse-chronological (most recent first)
  const index = experience.findIndex((e: any) => e.id === experienceId);
  if (index < 0) return 0.5; // Unknown role gets a neutral score
  // Decay: 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3 (floor)
  return Math.max(0.3, 1.0 - index * 0.1);
}

// ── Impact Scoring ──────────────────────────────────────────────

/**
 * Compute an impact score based on presence of quantifiable outcomes.
 * Checks for: dollar amounts, percentages, multipliers, large counts.
 * Range: [0.0, 1.0]
 */
function computeImpactScore(bulletText: string): number {
  let score = 0;

  // Dollar amounts
  if (/\$[\d,.]+[MBK]?/i.test(bulletText)) score += 0.35;

  // Percentages
  if (/\d+[\d,.]*%/.test(bulletText)) score += 0.25;

  // Multipliers (3x, 5x, etc.)
  if (/\b\d+[xX]\b/.test(bulletText)) score += 0.2;

  // Large counts (100+ of anything)
  if (/\b\d{3,}[\d,]*\+?\s*(?:person|people|team|member|engineer|analyst|report|user|client|stakeholder|dashboard|pipeline|model)/i.test(bulletText)) {
    score += 0.2;
  }

  return Math.min(1.0, score);
}

// ── Scored Bullet Adaptation ────────────────────────────────────

/**
 * Convert the mandate classifier's ScoredBullet (which lacks claim_ids)
 * into the pipeline's ScoredBullet type, enriched with claim linkage,
 * optional embedding scores, and the new scoring formula:
 *
 *   score = (mandate_alignment × 2) + impact + recency
 *
 * mandate_alignment specifically weights the PRIMARY mandate dimension.
 * Revenue bullets are penalized unless the job explicitly centers on revenue.
 */
function adaptScoredBullet(
  raw: ReturnType<typeof scoreBulletsAgainstMandate>[number],
  ledger: ClaimsLedger,
  embeddingScores: Map<string, number>,
  embeddingWeight: number,
  mandate: MandateProfile,
  inventory: Record<string, any>,
): ScoredBullet {
  const claimIds = linkClaimIds(raw.bullet_id, raw.bullet_text, ledger);
  const embeddingScore = embeddingScores.get(raw.bullet_text);

  // ── New scoring formula: (mandate_alignment × 2) + impact + recency ──

  // 1. Mandate alignment: score against the PRIMARY mandate dimension × 2
  const primaryDimId = mandate.primary_mandate;
  const primaryMandateScore = raw.mandate_scores[primaryDimId] || 0;

  // Also consider secondary mandates (weight × 1)
  const secondaryIds = mandate.secondary_mandates || [];
  let secondaryMandateScore = 0;
  for (const secId of secondaryIds) {
    secondaryMandateScore += (raw.mandate_scores[secId] || 0);
  }
  secondaryMandateScore = secondaryIds.length > 0
    ? secondaryMandateScore / secondaryIds.length
    : 0;

  // Mandate alignment = primary × 2 + secondary × 1
  const mandateAlignment = (primaryMandateScore * 2) + secondaryMandateScore;

  // 2. Impact: quantifiable outcome presence
  const impact = computeImpactScore(raw.bullet_text);

  // 3. Recency: newer roles score higher
  const recency = computeRecencyScore(raw.experience_id, inventory);

  // 4. Revenue gravity penalty: if bullet is revenue-heavy but job mandate
  //    does NOT center on revenue, apply a dampening factor
  let revenueAdjustment = 1.0;
  if (isRevenueDominantBullet(raw.bullet_text)) {
    const jobIsRevenueFocused = REVENUE_MANDATE_IDS.includes(primaryDimId) ||
      secondaryIds.some(id => REVENUE_MANDATE_IDS.includes(id));
    if (!jobIsRevenueFocused) {
      // Dampen revenue bullets when job doesn't center on revenue
      revenueAdjustment = 0.6;
    }
  }

  // Final composite: (mandate_alignment × 2) + impact + recency
  // Normalized to a 0-5 scale for compatibility with downstream consumers
  let totalRelevance = (mandateAlignment * 2 + impact + recency) * revenueAdjustment;

  // Blend with embedding score when available
  if (embeddingScore !== undefined && embeddingWeight > 0) {
    const mandateWeight = 1 - embeddingWeight;
    totalRelevance = totalRelevance * mandateWeight + embeddingScore * 3 * embeddingWeight;
  }

  totalRelevance = Math.round(totalRelevance * 1000) / 1000;

  return {
    bullet_id: raw.bullet_id,
    bullet_text: raw.bullet_text,
    experience_id: raw.experience_id,
    claim_ids: claimIds,
    mandate_scores: raw.mandate_scores,
    embedding_score: embeddingScore,
    total_relevance: totalRelevance,
    rank: 0, // Assigned after global re-sort
  };
}

// ── Reordered Role Adaptation ───────────────────────────────────

/**
 * Adapt the mandate classifier's ReorderedRole format, replacing each
 * inner ScoredBullet with the enriched pipeline ScoredBullet.
 */
function adaptReorderedRoles(
  rawRoles: ReturnType<typeof reorderBulletsPerRole>,
  enrichedBullets: Map<string, ScoredBullet>,
): ReorderedRole[] {
  return rawRoles.map((role) => ({
    experience_id: role.experience_id,
    employer: role.employer,
    title: role.title,
    ordered_bullets: role.ordered_bullets.map(
      (b) => enrichedBullets.get(b.bullet_id) ?? adaptFallbackBullet(b),
    ),
    dropped_bullets: role.dropped_bullets.map((d) => ({
      bullet: enrichedBullets.get(d.bullet.bullet_id) ?? adaptFallbackBullet(d.bullet),
      reason: d.reason,
    })),
  }));
}

/**
 * Fallback adapter for bullets that are not in the enriched map
 * (should not happen in practice, but ensures type safety).
 */
function adaptFallbackBullet(
  raw: ReturnType<typeof scoreBulletsAgainstMandate>[number],
): ScoredBullet {
  return {
    bullet_id: raw.bullet_id,
    bullet_text: raw.bullet_text,
    experience_id: raw.experience_id,
    claim_ids: [],
    mandate_scores: raw.mandate_scores,
    total_relevance: raw.total_relevance,
    rank: raw.rank,
  };
}

// ── Main Scoring Pipeline ───────────────────────────────────────

/**
 * Full bullet scoring pipeline for Stage 3.
 *
 * 1. Runs mandate-based keyword scoring (existing logic).
 * 2. Optionally computes embedding-based semantic scores.
 * 3. Links each bullet to claim IDs from the claims ledger.
 * 4. Blends mandate + embedding scores into a single total_relevance.
 * 5. Re-ranks and reorders bullets per role.
 * 6. Identifies mandate coverage gaps.
 * 7. Generates clarification questions for unsupported JD requirements.
 *
 * @param inventory  - Resume inventory (experience, skills, etc.)
 * @param mandate    - Mandate profile from Stage 2
 * @param ledger     - Claims ledger from Stage 1
 * @param jdRequirements - Extracted JD requirements (for gap analysis + severity)
 * @param embeddingConfig - Optional embedding scoring configuration
 * @returns ScoredBulletPlan with scored bullets, reordered roles, gaps, and questions
 */
export async function scoreBullets(
  inventory: Record<string, any>,
  mandate: MandateProfile,
  ledger: ClaimsLedger,
  jdRequirements: JDRequirements,
  embeddingConfig?: EmbeddingConfig,
): Promise<ScoredBulletPlan> {
  // ── Step 1: Mandate-based keyword scoring ───────────────────
  const rawScoredBullets = scoreBulletsAgainstMandate(inventory, mandate);

  // ── Step 2: Optional embedding-based scoring ────────────────
  let embeddingScores = new Map<string, number>();
  const effectiveEmbeddingWeight = embeddingConfig?.enabled ? (embeddingConfig.weight ?? 0.3) : 0;

  if (embeddingConfig?.enabled) {
    const bulletTexts = rawScoredBullets.map((b) => b.bullet_text);
    // Reconstruct a representative JD text from requirements for embedding
    const jdText = buildJDTextForEmbedding(jdRequirements);
    embeddingScores = await computeEmbeddingScores(bulletTexts, jdText, embeddingConfig);
  }

  // ── Step 3: Enrich with claim IDs + blend scores ────────────
  // Uses the new scoring formula: (mandate_alignment × 2) + impact + recency
  // Revenue bullets are dampened unless the job centers on monetization.
  const enrichedBullets: ScoredBullet[] = rawScoredBullets.map((raw) =>
    adaptScoredBullet(raw, ledger, embeddingScores, effectiveEmbeddingWeight, mandate, inventory),
  );

  // ── Step 4: Global re-rank by blended total_relevance ───────
  enrichedBullets.sort((a, b) => b.total_relevance - a.total_relevance);
  enrichedBullets.forEach((bullet, index) => {
    bullet.rank = index + 1;
  });

  // ── Step 5: Reorder bullets per role ────────────────────────
  // We need to pass enriched bullets back through the reorder logic.
  // Since reorderBulletsPerRole works on the raw ScoredBullet type from
  // mandateClassifier, we re-run it and then map to enriched versions.
  const rawReorderedRoles = reorderBulletsPerRole(inventory, rawScoredBullets, {
    dropLowest20Percent: true,
  });

  const enrichedMap = new Map<string, ScoredBullet>();
  for (const bullet of enrichedBullets) {
    enrichedMap.set(bullet.bullet_id, bullet);
  }

  const reorderedRoles = adaptReorderedRoles(rawReorderedRoles, enrichedMap);

  // Re-sort ordered bullets within each role by the blended total_relevance
  for (const role of reorderedRoles) {
    role.ordered_bullets.sort((a, b) => b.total_relevance - a.total_relevance);
  }

  // ── Step 6: Identify mandate coverage gaps ──────────────────
  const rawMandateGaps = identifyMandateGaps(mandate, rawScoredBullets);
  const mandateGaps = adaptMandateGaps(rawMandateGaps);

  // ── Step 7: Generate clarification questions ────────────────
  const allRequirementTexts = extractRequirementTexts(jdRequirements);
  const gapResults = analyzeRequirementGaps(allRequirementTexts, inventory);
  const clarificationQuestions = convertGapsToQuestions(gapResults, jdRequirements);

  return {
    scored_bullets: enrichedBullets,
    reordered_roles: reorderedRoles,
    mandate_gaps: mandateGaps,
    clarification_questions: clarificationQuestions,
  };
}

// ── Helper: Build JD Text for Embedding ─────────────────────────

/**
 * Reconstruct a representative JD text from structured requirements
 * for use as the embedding target. Prioritizes must_have and leadership
 * signals since those carry the most weight for relevance.
 */
function buildJDTextForEmbedding(jdRequirements: JDRequirements): string {
  const sections: string[] = [];

  const extract = (items: Array<string | RequirementItem>): string[] =>
    items.map((item) => (typeof item === "string" ? item : (item as RequirementItem).text || ""))
      .filter(Boolean);

  if (jdRequirements.must_have?.length) {
    sections.push("Required: " + extract(jdRequirements.must_have).join(". "));
  }
  if (jdRequirements.leadership_scope?.length) {
    sections.push("Leadership: " + extract(jdRequirements.leadership_scope).join(". "));
  }
  if (jdRequirements.nice_to_have?.length) {
    sections.push("Preferred: " + extract(jdRequirements.nice_to_have).join(". "));
  }
  if (jdRequirements.tech_keywords?.length) {
    sections.push("Technologies: " + extract(jdRequirements.tech_keywords).join(", "));
  }
  if (jdRequirements.domain_context?.length) {
    sections.push("Domain: " + extract(jdRequirements.domain_context).join(". "));
  }

  return sections.join("\n\n");
}

// ── Helper: Extract Flat Requirement Texts ──────────────────────

/**
 * Extract all requirement texts from structured JD requirements
 * into a flat string array for gap analysis.
 */
function extractRequirementTexts(jdRequirements: JDRequirements): string[] {
  const texts: string[] = [];

  const extract = (items: Array<string | RequirementItem> | undefined): void => {
    if (!items) return;
    for (const item of items) {
      const text = typeof item === "string" ? item : (item as RequirementItem).text || "";
      if (text) texts.push(text);
    }
  };

  extract(jdRequirements.must_have);
  extract(jdRequirements.nice_to_have);
  extract(jdRequirements.leadership_scope);
  extract(jdRequirements.tech_keywords);

  return texts;
}
