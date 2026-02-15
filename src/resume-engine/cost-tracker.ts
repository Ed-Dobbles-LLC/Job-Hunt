/**
 * LLM Cost Tracker
 *
 * Captures per-call token usage and cost, stores to DB, and provides
 * aggregate reporting. Designed to integrate with resilientGenerateObject
 * so every LLM call is automatically tracked.
 *
 * Key features:
 *   - Central pricing registry (cost per 1M tokens by model)
 *   - Per-call usage capture with fallback to character-based estimation
 *   - DB persistence to llm_usage table
 *   - Aggregate functions: per-job, per-stage, per-batch, per-day
 *   - Budget guardrails with configurable thresholds
 */

import type { AttemptTelemetry } from "./llm-retry";

// ── Pricing Registry ──────────────────────────────────────────

/**
 * Cost per 1M tokens for each model.
 * Updated to OpenAI pricing as of 2025-05.
 */
export interface ModelPricing {
  input_per_1m: number;
  output_per_1m: number;
  /** Friendly display name */
  display_name: string;
}

export const PRICING_REGISTRY: Record<string, ModelPricing> = {
  "gpt-4o": {
    input_per_1m: 2.50,
    output_per_1m: 10.00,
    display_name: "GPT-4o",
  },
  "gpt-4o-mini": {
    input_per_1m: 0.15,
    output_per_1m: 0.60,
    display_name: "GPT-4o Mini",
  },
  "gpt-4o-2024-08-06": {
    input_per_1m: 2.50,
    output_per_1m: 10.00,
    display_name: "GPT-4o (Aug 2024)",
  },
  "gpt-4-turbo": {
    input_per_1m: 10.00,
    output_per_1m: 30.00,
    display_name: "GPT-4 Turbo",
  },
};

/** Default fallback pricing if model not in registry. */
const FALLBACK_PRICING: ModelPricing = {
  input_per_1m: 5.00,
  output_per_1m: 15.00,
  display_name: "Unknown Model",
};

// ── Types ───────────────────────────────────────────────────────

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Whether these are actual values from the API or estimates */
  estimated: boolean;
}

export interface UsageEvent {
  request_id: string;
  job_id?: number;
  label: string;
  model: string;
  usage: TokenUsage;
  cost_usd: number;
  duration_ms: number;
  attempt: number;
  status: "success" | "retry" | "fatal";
  timestamp: string;
}

export interface CostSummary {
  total_cost_usd: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  call_count: number;
  avg_cost_per_call: number;
  by_stage: Record<string, { cost_usd: number; tokens: number; calls: number }>;
  by_model: Record<string, { cost_usd: number; tokens: number; calls: number }>;
  estimated_pct: number;
}

export interface BudgetGuardrail {
  /** Max cost per single packet (all stages) in USD */
  max_per_packet_usd?: number;
  /** Max cost per batch run in USD */
  max_per_batch_usd?: number;
  /** Max cost per day in USD */
  max_per_day_usd?: number;
}

// ── Token Estimation Fallback ───────────────────────────────────

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token usage from character counts when the API doesn't
 * return actual usage data.
 */
export function estimateTokenUsage(
  promptChars: number,
  completionChars: number,
): TokenUsage {
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const completionTokens = Math.ceil(completionChars / CHARS_PER_TOKEN);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated: true,
  };
}

// ── Cost Calculation ──────────────────────────────────────────

/**
 * Calculate USD cost for a given usage on a given model.
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = PRICING_REGISTRY[model] ?? FALLBACK_PRICING;
  const inputCost = (usage.prompt_tokens / 1_000_000) * pricing.input_per_1m;
  const outputCost = (usage.completion_tokens / 1_000_000) * pricing.output_per_1m;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Get the pricing info for a model (with fallback).
 */
export function getModelPricing(model: string): ModelPricing {
  return PRICING_REGISTRY[model] ?? FALLBACK_PRICING;
}

// ── In-Memory Event Buffer ──────────────────────────────────────

/**
 * Accumulates usage events in memory for the current pipeline run.
 * Flushed to DB at end of pipeline or on demand.
 */
export class CostAccumulator {
  private events: UsageEvent[] = [];
  private jobId?: number;
  private logger?: any;

  constructor(opts?: { jobId?: number; logger?: any }) {
    this.jobId = opts?.jobId;
    this.logger = opts?.logger;
  }

  /**
   * Record a usage event from an LLM call.
   *
   * @param telemetry - AttemptTelemetry from resilientGenerateObject
   * @param apiUsage - Actual token usage from the API response (if available)
   * @param completionChars - Character count of the generated output (for estimation fallback)
   */
  recordCall(
    telemetry: AttemptTelemetry,
    apiUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
    completionChars?: number,
  ): UsageEvent {
    let usage: TokenUsage;

    if (apiUsage?.promptTokens != null && apiUsage?.completionTokens != null) {
      // Use actual API-reported usage
      usage = {
        prompt_tokens: apiUsage.promptTokens,
        completion_tokens: apiUsage.completionTokens,
        total_tokens: apiUsage.totalTokens ?? (apiUsage.promptTokens + apiUsage.completionTokens),
        estimated: false,
      };
    } else {
      // Fall back to character-based estimation
      usage = estimateTokenUsage(
        telemetry.prompt_chars,
        completionChars ?? Math.ceil(telemetry.prompt_chars * 0.3), // rough output estimate
      );
    }

    const cost = calculateCost(telemetry.model, usage);

    const event: UsageEvent = {
      request_id: telemetry.request_id,
      job_id: this.jobId,
      label: telemetry.label,
      model: telemetry.model,
      usage,
      cost_usd: cost,
      duration_ms: telemetry.duration_ms,
      attempt: telemetry.attempt,
      status: telemetry.status,
      timestamp: telemetry.timestamp,
    };

    this.events.push(event);

    this.logger?.info(
      `💰 [cost] ${telemetry.label} attempt=${telemetry.attempt + 1}: ` +
      `${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens} tokens` +
      `${usage.estimated ? " (est)" : ""}, $${cost.toFixed(6)}, ${telemetry.duration_ms}ms`,
    );

    return event;
  }

  /** Get all recorded events. */
  getEvents(): UsageEvent[] {
    return [...this.events];
  }

  /** Get event count. */
  get size(): number {
    return this.events.length;
  }

  /** Calculate running totals. */
  getSummary(): CostSummary {
    return summarizeEvents(this.events);
  }

  /**
   * Check if accumulated cost exceeds a guardrail threshold.
   * Returns null if within budget, or a message describing the breach.
   */
  checkBudget(guardrails: BudgetGuardrail): string | null {
    const summary = this.getSummary();

    if (guardrails.max_per_packet_usd != null && summary.total_cost_usd > guardrails.max_per_packet_usd) {
      return `Packet cost $${summary.total_cost_usd.toFixed(4)} exceeds budget $${guardrails.max_per_packet_usd.toFixed(4)}`;
    }

    return null;
  }

  /**
   * Build the SQL INSERT values for flushing to the llm_usage table.
   * Returns { sql, params } for a single multi-row INSERT.
   */
  buildInsertSQL(): { sql: string; params: any[] } | null {
    const successEvents = this.events.filter(e => e.status === "success" || e.status === "fatal");
    if (successEvents.length === 0) return null;

    const valuePlaceholders: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    for (const event of successEvents) {
      valuePlaceholders.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
      );
      params.push(
        event.request_id,
        event.job_id ?? null,
        event.label,
        event.model,
        event.usage.prompt_tokens,
        event.usage.completion_tokens,
        event.usage.total_tokens,
        event.usage.estimated,
        event.cost_usd,
        event.duration_ms,
        event.status,
      );
    }

    const sql = `INSERT INTO llm_usage (request_id, job_id, label, model, prompt_tokens, completion_tokens, total_tokens, estimated, cost_usd, duration_ms, status) VALUES ${valuePlaceholders.join(", ")}`;

    return { sql, params };
  }

  /** Reset the accumulator (after flush). */
  clear(): void {
    this.events = [];
  }
}

// ── Aggregation Functions ────────────────────────────────────────

/**
 * Summarize a list of usage events into a cost breakdown.
 */
export function summarizeEvents(events: UsageEvent[]): CostSummary {
  const byStage: Record<string, { cost_usd: number; tokens: number; calls: number }> = {};
  const byModel: Record<string, { cost_usd: number; tokens: number; calls: number }> = {};

  let totalCost = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let estimatedCount = 0;

  for (const event of events) {
    totalCost += event.cost_usd;
    totalPrompt += event.usage.prompt_tokens;
    totalCompletion += event.usage.completion_tokens;
    totalTokens += event.usage.total_tokens;
    if (event.usage.estimated) estimatedCount++;

    // By stage (extract stage label, e.g., "Stage 4: Resume Generation" → "Stage 4")
    const stageKey = extractStageKey(event.label);
    if (!byStage[stageKey]) byStage[stageKey] = { cost_usd: 0, tokens: 0, calls: 0 };
    byStage[stageKey].cost_usd += event.cost_usd;
    byStage[stageKey].tokens += event.usage.total_tokens;
    byStage[stageKey].calls++;

    // By model
    if (!byModel[event.model]) byModel[event.model] = { cost_usd: 0, tokens: 0, calls: 0 };
    byModel[event.model].cost_usd += event.cost_usd;
    byModel[event.model].tokens += event.usage.total_tokens;
    byModel[event.model].calls++;
  }

  return {
    total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
    total_prompt_tokens: totalPrompt,
    total_completion_tokens: totalCompletion,
    total_tokens: totalTokens,
    call_count: events.length,
    avg_cost_per_call: events.length > 0 ? totalCost / events.length : 0,
    by_stage: byStage,
    by_model: byModel,
    estimated_pct: events.length > 0 ? Math.round((estimatedCount / events.length) * 100) : 0,
  };
}

/**
 * Extract a normalized stage key from a label.
 * "Stage 4: Resume Generation" → "Stage 4"
 * "Stage 8: recruiter-review" → "Stage 8"
 */
function extractStageKey(label: string): string {
  const match = label.match(/^(Stage \d+)/i);
  return match ? match[1] : label;
}

/**
 * Format a cost summary for logging.
 */
export function formatCostSummary(summary: CostSummary): string {
  const lines: string[] = [
    `💰 LLM Cost Summary:`,
    `   Total: $${summary.total_cost_usd.toFixed(4)} across ${summary.call_count} call(s)`,
    `   Tokens: ${summary.total_prompt_tokens.toLocaleString()} in + ${summary.total_completion_tokens.toLocaleString()} out = ${summary.total_tokens.toLocaleString()} total`,
  ];

  if (summary.estimated_pct > 0) {
    lines.push(`   ⚠️ ${summary.estimated_pct}% of calls used estimated token counts`);
  }

  // By stage breakdown
  const stageEntries = Object.entries(summary.by_stage).sort();
  if (stageEntries.length > 0) {
    lines.push(`   By stage:`);
    for (const [stage, data] of stageEntries) {
      lines.push(`     ${stage}: $${data.cost_usd.toFixed(4)} (${data.tokens.toLocaleString()} tokens, ${data.calls} call${data.calls > 1 ? "s" : ""})`);
    }
  }

  return lines.join("\n");
}

// ── DB Query Helpers (for aggregate reporting) ────────────────────

/**
 * SQL to get cost summary for a specific job.
 */
export const COST_QUERY_BY_JOB = `
  SELECT
    COUNT(*) as call_count,
    SUM(prompt_tokens) as total_prompt_tokens,
    SUM(completion_tokens) as total_completion_tokens,
    SUM(total_tokens) as total_tokens,
    SUM(cost_usd) as total_cost_usd,
    SUM(duration_ms) as total_duration_ms
  FROM llm_usage
  WHERE job_id = $1
`;

/**
 * SQL to get daily cost breakdown.
 */
export const COST_QUERY_DAILY = `
  SELECT
    DATE(created_at) as day,
    COUNT(*) as call_count,
    SUM(total_tokens) as total_tokens,
    SUM(cost_usd) as total_cost_usd,
    COUNT(DISTINCT job_id) as jobs_processed
  FROM llm_usage
  GROUP BY DATE(created_at)
  ORDER BY day DESC
  LIMIT $1
`;

/**
 * SQL to get cost breakdown by label/stage.
 */
export const COST_QUERY_BY_STAGE = `
  SELECT
    label,
    COUNT(*) as call_count,
    AVG(prompt_tokens) as avg_prompt_tokens,
    AVG(completion_tokens) as avg_completion_tokens,
    SUM(cost_usd) as total_cost_usd,
    AVG(duration_ms) as avg_duration_ms
  FROM llm_usage
  WHERE job_id = $1
  GROUP BY label
  ORDER BY total_cost_usd DESC
`;

// ── Global Accumulator Singleton ──────────────────────────────────

/**
 * Global cost accumulator that resilientGenerateObject auto-records to.
 * Set before a pipeline run, read after completion.
 */
let _globalAccumulator: CostAccumulator | null = null;

export function setGlobalCostAccumulator(acc: CostAccumulator | null): void {
  _globalAccumulator = acc;
}

export function getGlobalCostAccumulator(): CostAccumulator | null {
  return _globalAccumulator;
}
