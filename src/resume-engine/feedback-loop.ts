/**
 * Feedback Loop — Learn From Rated Outputs
 *
 * Phase 4 of the pipeline architecture overhaul.
 *
 * When a user rates a generated packet (good/bad + optional reason),
 * this module:
 * 1. Stores the rating alongside the positioning brief and mandate
 * 2. Extracts successful patterns from highly-rated outputs
 * 3. Feeds those patterns into future positioning briefs (Stage 2b)
 *
 * Over time, the system learns which narrative angles, story arcs,
 * and positioning strategies work for which types of roles —
 * not from hardcoded rules, but from the user's actual preferences.
 *
 * The feedback is stored per-mandate so patterns are mandate-scoped:
 * "What works for governance roles" vs "what works for revenue roles."
 *
 * Type: DATABASE (no LLM calls)
 */

// ── Types ───────────────────────────────────────────────────────

export interface PacketFeedback {
  job_id: number;
  /** 1-5 rating (5 = excellent, would send as-is) */
  rating: number;
  /** Free-text reason for the rating */
  reason?: string;
  /** Which aspect was good/bad: positioning, tone, specificity, relevance */
  aspect?: "positioning" | "tone" | "specificity" | "relevance" | "overall";
  /** The mandate archetype this packet was generated for */
  mandate: string;
  /** The positioning brief that guided generation (if available) */
  positioning_brief?: Record<string, any>;
  /** The narrative angle used */
  narrative_angle?: string;
  /** The story arc used */
  story_arc?: string;
  /** Timestamp */
  rated_at?: string;
}

export interface SuccessPattern {
  mandate: string;
  pattern_type: "narrative_angle" | "story_arc" | "de_emphasis" | "rare_combination";
  pattern_text: string;
  frequency: number;
  avg_rating: number;
  last_seen: string;
}

// ── Store Feedback ──────────────────────────────────────────────

/**
 * Record user feedback on a generated packet.
 * Stores the rating, reason, and the positioning strategy that was used.
 */
export async function recordFeedback(
  feedback: PacketFeedback,
  logger?: any,
): Promise<void> {
  try {
    const { query } = await import("../mastra/tools/db");

    await query(
      `INSERT INTO packet_feedback
       (job_id, rating, reason, aspect, mandate, narrative_angle, story_arc, positioning_brief_json, rated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        feedback.job_id,
        feedback.rating,
        feedback.reason || null,
        feedback.aspect || "overall",
        feedback.mandate,
        feedback.narrative_angle || null,
        feedback.story_arc || null,
        feedback.positioning_brief ? JSON.stringify(feedback.positioning_brief) : null,
        feedback.rated_at || new Date().toISOString(),
      ],
    );

    logger?.info(`📝 [Feedback] Recorded rating=${feedback.rating} for job_id=${feedback.job_id} (${feedback.mandate})`);
  } catch (err: any) {
    // Non-fatal — feedback storage is optional
    logger?.warn(`⚠️ [Feedback] Failed to store feedback: ${err.message}`);
  }
}

// ── Retrieve Success Patterns ───────────────────────────────────

/**
 * Get successful positioning patterns for a given mandate.
 *
 * Returns patterns from packets rated 4+ for this mandate type.
 * These are fed into the Stage 2b positioning strategist to guide
 * future positioning decisions.
 *
 * @param mandate - The mandate archetype (e.g., "governance_standardization")
 * @param limit - Max patterns to return (default: 5)
 */
export async function getSuccessPatterns(
  mandate: string,
  limit: number = 5,
  logger?: any,
): Promise<string[]> {
  try {
    const { queryWithTimeout } = await import("../mastra/tools/db");

    // Get highly-rated narrative angles for this mandate
    const result = await queryWithTimeout(
      `SELECT narrative_angle, story_arc, AVG(rating) as avg_rating, COUNT(*) as frequency
       FROM packet_feedback
       WHERE mandate = $1
         AND rating >= 4
         AND narrative_angle IS NOT NULL
       GROUP BY narrative_angle, story_arc
       ORDER BY avg_rating DESC, frequency DESC
       LIMIT $2`,
      [mandate, limit],
      5000,
    );

    const patterns: string[] = [];
    for (const row of result.rows) {
      if (row.narrative_angle) {
        patterns.push(`[angle, avg ${row.avg_rating}] ${row.narrative_angle}`);
      }
      if (row.story_arc) {
        patterns.push(`[arc, avg ${row.avg_rating}] ${row.story_arc}`);
      }
    }

    // Also get negative patterns (what to avoid)
    const negResult = await queryWithTimeout(
      `SELECT narrative_angle, reason, AVG(rating) as avg_rating
       FROM packet_feedback
       WHERE mandate = $1
         AND rating <= 2
         AND reason IS NOT NULL
       GROUP BY narrative_angle, reason
       ORDER BY avg_rating ASC
       LIMIT 3`,
      [mandate],
      5000,
    );

    for (const row of negResult.rows) {
      if (row.reason) {
        patterns.push(`[AVOID, avg ${row.avg_rating}] ${row.reason}`);
      }
    }

    if (patterns.length > 0) {
      logger?.info(`📝 [Feedback] Found ${patterns.length} success patterns for ${mandate}`);
    }

    return patterns;
  } catch {
    // Table may not exist yet — return empty
    return [];
  }
}

// ── Aggregate Statistics ────────────────────────────────────────

export interface FeedbackStats {
  total_rated: number;
  avg_rating: number;
  mandate_breakdown: Record<string, { count: number; avg_rating: number }>;
  top_patterns: SuccessPattern[];
  improvement_areas: string[];
}

/**
 * Get aggregate feedback statistics across all rated packets.
 * Used for dashboard display and pipeline tuning.
 */
export async function getFeedbackStats(logger?: any): Promise<FeedbackStats | null> {
  try {
    const { queryWithTimeout } = await import("../mastra/tools/db");

    const overallResult = await queryWithTimeout(
      `SELECT COUNT(*) as total, AVG(rating) as avg_rating FROM packet_feedback`,
      [],
      5000,
    );

    if (!overallResult.rows[0] || overallResult.rows[0].total === "0") {
      return null;
    }

    const mandateResult = await queryWithTimeout(
      `SELECT mandate, COUNT(*) as count, AVG(rating) as avg_rating
       FROM packet_feedback
       GROUP BY mandate
       ORDER BY count DESC`,
      [],
      5000,
    );

    const mandateBreakdown: Record<string, { count: number; avg_rating: number }> = {};
    for (const row of mandateResult.rows) {
      mandateBreakdown[row.mandate] = {
        count: parseInt(row.count, 10),
        avg_rating: parseFloat(row.avg_rating),
      };
    }

    // Find areas needing improvement (mandates with low avg ratings)
    const improvementAreas: string[] = [];
    for (const [mandate, stats] of Object.entries(mandateBreakdown)) {
      if (stats.avg_rating < 3 && stats.count >= 3) {
        improvementAreas.push(`${mandate}: avg ${stats.avg_rating.toFixed(1)} across ${stats.count} packets`);
      }
    }

    return {
      total_rated: parseInt(overallResult.rows[0].total, 10),
      avg_rating: parseFloat(overallResult.rows[0].avg_rating),
      mandate_breakdown: mandateBreakdown,
      top_patterns: [],
      improvement_areas: improvementAreas,
    };
  } catch {
    return null;
  }
}

// ── Database Migration ──────────────────────────────────────────

/**
 * Create the feedback tables if they don't exist.
 * Called during pipeline initialization.
 */
export async function ensureFeedbackTables(logger?: any): Promise<void> {
  try {
    const { query } = await import("../mastra/tools/db");

    await query(`
      CREATE TABLE IF NOT EXISTS packet_feedback (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        reason TEXT,
        aspect VARCHAR(50) DEFAULT 'overall',
        mandate VARCHAR(100) NOT NULL,
        narrative_angle TEXT,
        story_arc TEXT,
        positioning_brief_json JSONB,
        rated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS company_research (
        company_name VARCHAR(255) PRIMARY KEY,
        research_json JSONB NOT NULL,
        researched_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_feedback_mandate ON packet_feedback(mandate)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON packet_feedback(rating)
    `);

    logger?.info(`📝 [Feedback] Tables verified`);
  } catch (err: any) {
    logger?.warn(`⚠️ [Feedback] Table creation failed (non-fatal): ${err.message}`);
  }
}
