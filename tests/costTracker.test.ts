/**
 * Tests for the LLM Cost Tracker module.
 *
 * Covers: pricing registry, cost calculation, token estimation,
 * CostAccumulator, summarization, formatting, budget guardrails,
 * and global accumulator singleton.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PRICING_REGISTRY,
  calculateCost,
  estimateTokenUsage,
  getModelPricing,
  CostAccumulator,
  summarizeEvents,
  formatCostSummary,
  setGlobalCostAccumulator,
  getGlobalCostAccumulator,
  COST_QUERY_BY_JOB,
  COST_QUERY_DAILY,
  COST_QUERY_BY_STAGE,
  type TokenUsage,
  type UsageEvent,
  type ModelPricing,
  type CostSummary,
  type BudgetGuardrail,
} from "../src/resume-engine/cost-tracker";
import type { AttemptTelemetry } from "../src/resume-engine/llm-retry";

// ── Helpers ──────────────────────────────────────────────────────

function makeTelemetry(overrides: Partial<AttemptTelemetry> = {}): AttemptTelemetry {
  return {
    request_id: "llm-test-1",
    label: "Stage 4: Resume Generation",
    attempt: 0,
    max_retries: 5,
    status: "success",
    duration_ms: 3500,
    model: "gpt-4o",
    prompt_chars: 10000,
    lane: "heavy",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Pricing Registry ─────────────────────────────────────────────

describe("Pricing Registry", () => {
  it("contains gpt-4o pricing", () => {
    const pricing = PRICING_REGISTRY["gpt-4o"];
    expect(pricing).toBeDefined();
    expect(pricing.input_per_1m).toBe(2.50);
    expect(pricing.output_per_1m).toBe(10.00);
    expect(pricing.display_name).toBe("GPT-4o");
  });

  it("contains gpt-4o-mini pricing", () => {
    const pricing = PRICING_REGISTRY["gpt-4o-mini"];
    expect(pricing).toBeDefined();
    expect(pricing.input_per_1m).toBe(0.15);
    expect(pricing.output_per_1m).toBe(0.60);
  });

  it("getModelPricing returns fallback for unknown models", () => {
    const pricing = getModelPricing("gpt-5-nonexistent");
    expect(pricing.display_name).toBe("Unknown Model");
    expect(pricing.input_per_1m).toBeGreaterThan(0);
    expect(pricing.output_per_1m).toBeGreaterThan(0);
  });

  it("getModelPricing returns actual pricing for known models", () => {
    const pricing = getModelPricing("gpt-4o");
    expect(pricing).toBe(PRICING_REGISTRY["gpt-4o"]);
  });
});

// ── Cost Calculation ─────────────────────────────────────────────

describe("Cost Calculation", () => {
  it("calculates correct cost for gpt-4o", () => {
    const usage: TokenUsage = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      estimated: false,
    };

    const cost = calculateCost("gpt-4o", usage);
    // Input: 1000/1M * $2.50 = $0.0025
    // Output: 500/1M * $10.00 = $0.005
    // Total: $0.0075
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it("calculates correct cost for gpt-4o-mini", () => {
    const usage: TokenUsage = {
      prompt_tokens: 5000,
      completion_tokens: 1000,
      total_tokens: 6000,
      estimated: false,
    };

    const cost = calculateCost("gpt-4o-mini", usage);
    // Input: 5000/1M * $0.15 = $0.00075
    // Output: 1000/1M * $0.60 = $0.0006
    // Total: $0.00135
    expect(cost).toBeCloseTo(0.00135, 6);
  });

  it("uses fallback pricing for unknown models", () => {
    const usage: TokenUsage = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      estimated: false,
    };

    const cost = calculateCost("unknown-model", usage);
    // Fallback: Input: 1000/1M * $5.00 = $0.005
    // Output: 500/1M * $15.00 = $0.0075
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  it("returns 0 for zero tokens", () => {
    const usage: TokenUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated: false,
    };

    expect(calculateCost("gpt-4o", usage)).toBe(0);
  });
});

// ── Token Estimation ─────────────────────────────────────────────

describe("Token Estimation", () => {
  it("estimates tokens from character counts (1 token ≈ 4 chars)", () => {
    const usage = estimateTokenUsage(4000, 2000);
    expect(usage.prompt_tokens).toBe(1000);
    expect(usage.completion_tokens).toBe(500);
    expect(usage.total_tokens).toBe(1500);
    expect(usage.estimated).toBe(true);
  });

  it("rounds up fractional token estimates", () => {
    const usage = estimateTokenUsage(5, 3);
    expect(usage.prompt_tokens).toBe(2); // ceil(5/4)
    expect(usage.completion_tokens).toBe(1); // ceil(3/4)
    expect(usage.total_tokens).toBe(3);
  });

  it("handles zero characters", () => {
    const usage = estimateTokenUsage(0, 0);
    expect(usage.total_tokens).toBe(0);
    expect(usage.estimated).toBe(true);
  });
});

// ── CostAccumulator ──────────────────────────────────────────────

describe("CostAccumulator", () => {
  let acc: CostAccumulator;

  beforeEach(() => {
    acc = new CostAccumulator({ jobId: 42 });
  });

  it("starts empty", () => {
    expect(acc.size).toBe(0);
    expect(acc.getEvents()).toEqual([]);
  });

  it("records a call with actual API usage", () => {
    const telemetry = makeTelemetry();
    const event = acc.recordCall(telemetry, {
      promptTokens: 2500,
      completionTokens: 800,
      totalTokens: 3300,
    });

    expect(acc.size).toBe(1);
    expect(event.usage.prompt_tokens).toBe(2500);
    expect(event.usage.completion_tokens).toBe(800);
    expect(event.usage.estimated).toBe(false);
    expect(event.job_id).toBe(42);
    expect(event.cost_usd).toBeGreaterThan(0);
  });

  it("falls back to estimation when API usage not available", () => {
    const telemetry = makeTelemetry({ prompt_chars: 8000 });
    const event = acc.recordCall(telemetry);

    expect(event.usage.estimated).toBe(true);
    expect(event.usage.prompt_tokens).toBe(2000); // 8000/4
    expect(event.usage.completion_tokens).toBeGreaterThan(0);
  });

  it("falls back to estimation with completion chars hint", () => {
    const telemetry = makeTelemetry({ prompt_chars: 8000 });
    const event = acc.recordCall(telemetry, undefined, 4000);

    expect(event.usage.estimated).toBe(true);
    expect(event.usage.completion_tokens).toBe(1000); // 4000/4
  });

  it("accumulates multiple calls", () => {
    acc.recordCall(makeTelemetry(), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    acc.recordCall(makeTelemetry({ label: "Stage 8: recruiter-review", lane: "medium" }), { promptTokens: 2000, completionTokens: 600, totalTokens: 2600 });

    expect(acc.size).toBe(2);

    const summary = acc.getSummary();
    expect(summary.call_count).toBe(2);
    expect(summary.total_tokens).toBe(4100);
    expect(summary.total_cost_usd).toBeGreaterThan(0);
  });

  it("provides per-stage breakdown in summary", () => {
    acc.recordCall(makeTelemetry({ label: "Stage 4: Resume Generation" }), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    acc.recordCall(makeTelemetry({ label: "Stage 4: CoverLetter Generation" }), { promptTokens: 800, completionTokens: 300, totalTokens: 1100 });
    acc.recordCall(makeTelemetry({ label: "Stage 8: recruiter-review" }), { promptTokens: 2000, completionTokens: 600, totalTokens: 2600 });

    const summary = acc.getSummary();
    expect(summary.by_stage["Stage 4"]).toBeDefined();
    expect(summary.by_stage["Stage 4"].calls).toBe(2);
    expect(summary.by_stage["Stage 8"]).toBeDefined();
    expect(summary.by_stage["Stage 8"].calls).toBe(1);
  });

  it("provides per-model breakdown in summary", () => {
    acc.recordCall(makeTelemetry({ model: "gpt-4o" }), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    acc.recordCall(makeTelemetry({ model: "gpt-4o-mini" }), { promptTokens: 2000, completionTokens: 600, totalTokens: 2600 });

    const summary = acc.getSummary();
    expect(summary.by_model["gpt-4o"]).toBeDefined();
    expect(summary.by_model["gpt-4o-mini"]).toBeDefined();
  });

  it("tracks estimated percentage", () => {
    acc.recordCall(makeTelemetry(), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    acc.recordCall(makeTelemetry()); // no API usage → estimated

    const summary = acc.getSummary();
    expect(summary.estimated_pct).toBe(50);
  });

  it("clears events", () => {
    acc.recordCall(makeTelemetry(), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    expect(acc.size).toBe(1);

    acc.clear();
    expect(acc.size).toBe(0);
    expect(acc.getEvents()).toEqual([]);
  });

  it("builds correct SQL for DB flush", () => {
    acc.recordCall(makeTelemetry({ status: "success" }), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    acc.recordCall(makeTelemetry({ status: "success" }), { promptTokens: 800, completionTokens: 300, totalTokens: 1100 });

    const insert = acc.buildInsertSQL();
    expect(insert).not.toBeNull();
    expect(insert!.sql).toContain("INSERT INTO llm_usage");
    expect(insert!.sql).toContain("request_id");
    expect(insert!.sql).toContain("cost_usd");
    expect(insert!.params.length).toBe(22); // 2 events × 11 params each
  });

  it("returns null SQL when no events", () => {
    expect(acc.buildInsertSQL()).toBeNull();
  });

  it("skips retry events in SQL (only success/fatal)", () => {
    acc.recordCall(makeTelemetry({ status: "retry" }), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });

    expect(acc.buildInsertSQL()).toBeNull();
  });
});

// ── Budget Guardrails ────────────────────────────────────────────

describe("Budget Guardrails", () => {
  it("returns null when within budget", () => {
    const acc = new CostAccumulator({ jobId: 1 });
    acc.recordCall(makeTelemetry(), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });

    const result = acc.checkBudget({ max_per_packet_usd: 1.00 });
    expect(result).toBeNull();
  });

  it("returns message when over budget", () => {
    const acc = new CostAccumulator({ jobId: 1 });
    // Record a very expensive call
    acc.recordCall(makeTelemetry(), { promptTokens: 100000, completionTokens: 50000, totalTokens: 150000 });

    const result = acc.checkBudget({ max_per_packet_usd: 0.01 });
    expect(result).toContain("exceeds budget");
  });

  it("ignores unset guardrails", () => {
    const acc = new CostAccumulator({ jobId: 1 });
    acc.recordCall(makeTelemetry(), { promptTokens: 100000, completionTokens: 50000, totalTokens: 150000 });

    const result = acc.checkBudget({});
    expect(result).toBeNull();
  });
});

// ── Summarization ────────────────────────────────────────────────

describe("summarizeEvents", () => {
  it("handles empty event list", () => {
    const summary = summarizeEvents([]);
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.call_count).toBe(0);
    expect(summary.avg_cost_per_call).toBe(0);
    expect(summary.estimated_pct).toBe(0);
  });

  it("correctly sums across multiple events", () => {
    const events: UsageEvent[] = [
      {
        request_id: "r1",
        job_id: 1,
        label: "Stage 4: Resume",
        model: "gpt-4o",
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, estimated: false },
        cost_usd: 0.0075,
        duration_ms: 3000,
        attempt: 0,
        status: "success",
        timestamp: new Date().toISOString(),
      },
      {
        request_id: "r2",
        job_id: 1,
        label: "Stage 8: Review",
        model: "gpt-4o",
        usage: { prompt_tokens: 2000, completion_tokens: 600, total_tokens: 2600, estimated: true },
        cost_usd: 0.011,
        duration_ms: 4000,
        attempt: 0,
        status: "success",
        timestamp: new Date().toISOString(),
      },
    ];

    const summary = summarizeEvents(events);
    expect(summary.call_count).toBe(2);
    expect(summary.total_prompt_tokens).toBe(3000);
    expect(summary.total_completion_tokens).toBe(1100);
    expect(summary.total_tokens).toBe(4100);
    expect(summary.total_cost_usd).toBeCloseTo(0.0185, 4);
    expect(summary.estimated_pct).toBe(50);
  });
});

// ── Format Cost Summary ──────────────────────────────────────────

describe("formatCostSummary", () => {
  it("produces readable output", () => {
    const summary: CostSummary = {
      total_cost_usd: 0.0475,
      total_prompt_tokens: 5000,
      total_completion_tokens: 2000,
      total_tokens: 7000,
      call_count: 3,
      avg_cost_per_call: 0.0158,
      by_stage: {
        "Stage 4": { cost_usd: 0.035, tokens: 5000, calls: 2 },
        "Stage 8": { cost_usd: 0.0125, tokens: 2000, calls: 1 },
      },
      by_model: {
        "gpt-4o": { cost_usd: 0.0475, tokens: 7000, calls: 3 },
      },
      estimated_pct: 0,
    };

    const output = formatCostSummary(summary);
    expect(output).toContain("LLM Cost Summary");
    expect(output).toContain("$0.0475");
    expect(output).toContain("3 call(s)");
    expect(output).toContain("Stage 4");
    expect(output).toContain("Stage 8");
  });

  it("shows estimation warning when present", () => {
    const summary: CostSummary = {
      total_cost_usd: 0.01,
      total_prompt_tokens: 1000,
      total_completion_tokens: 500,
      total_tokens: 1500,
      call_count: 2,
      avg_cost_per_call: 0.005,
      by_stage: {},
      by_model: {},
      estimated_pct: 50,
    };

    const output = formatCostSummary(summary);
    expect(output).toContain("50%");
    expect(output).toContain("estimated");
  });
});

// ── Global Accumulator Singleton ─────────────────────────────────

describe("Global Cost Accumulator", () => {
  beforeEach(() => {
    setGlobalCostAccumulator(null);
  });

  it("starts as null", () => {
    expect(getGlobalCostAccumulator()).toBeNull();
  });

  it("can be set and retrieved", () => {
    const acc = new CostAccumulator({ jobId: 99 });
    setGlobalCostAccumulator(acc);
    expect(getGlobalCostAccumulator()).toBe(acc);
  });

  it("can be cleared", () => {
    setGlobalCostAccumulator(new CostAccumulator());
    setGlobalCostAccumulator(null);
    expect(getGlobalCostAccumulator()).toBeNull();
  });
});

// ── SQL Query Constants ──────────────────────────────────────────

describe("SQL Query Constants", () => {
  it("exports COST_QUERY_BY_JOB", () => {
    expect(COST_QUERY_BY_JOB).toContain("llm_usage");
    expect(COST_QUERY_BY_JOB).toContain("job_id = $1");
  });

  it("exports COST_QUERY_DAILY", () => {
    expect(COST_QUERY_DAILY).toContain("DATE(created_at)");
    expect(COST_QUERY_DAILY).toContain("LIMIT $1");
  });

  it("exports COST_QUERY_BY_STAGE", () => {
    expect(COST_QUERY_BY_STAGE).toContain("GROUP BY label");
    expect(COST_QUERY_BY_STAGE).toContain("job_id = $1");
  });
});

// ── Module Exports ───────────────────────────────────────────────

describe("Module Exports", () => {
  it("exports all expected types and functions", () => {
    expect(typeof PRICING_REGISTRY).toBe("object");
    expect(typeof calculateCost).toBe("function");
    expect(typeof estimateTokenUsage).toBe("function");
    expect(typeof getModelPricing).toBe("function");
    expect(typeof CostAccumulator).toBe("function");
    expect(typeof summarizeEvents).toBe("function");
    expect(typeof formatCostSummary).toBe("function");
    expect(typeof setGlobalCostAccumulator).toBe("function");
    expect(typeof getGlobalCostAccumulator).toBe("function");
  });
});
