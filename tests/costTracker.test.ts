/**
 * Tests for the LLM Cost Tracker module.
 *
 * Covers: pricing registry (incl. env overrides), cost calculation,
 * estimateCostUSD, token estimation, CostAccumulator (with run_id,
 * retry persistence, error_type), BatchCostAccumulator, summarization,
 * formatting, budget guardrails, global accumulator singleton,
 * DB query constants, and integration test for batch cost tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PRICING_REGISTRY,
  calculateCost,
  estimateCostUSD,
  estimateTokenUsage,
  getModelPricing,
  CostAccumulator,
  BatchCostAccumulator,
  summarizeEvents,
  formatCostSummary,
  formatBatchCostSummary,
  setGlobalCostAccumulator,
  getGlobalCostAccumulator,
  extractStageKey,
  COST_QUERY_BY_JOB,
  COST_QUERY_BY_RUN,
  COST_QUERY_DAILY,
  COST_QUERY_BY_STAGE,
  type TokenUsage,
  type UsageEvent,
  type ModelPricing,
  type CostSummary,
  type BatchCostSummary,
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

// ── estimateCostUSD Convenience ──────────────────────────────────

describe("estimateCostUSD", () => {
  it("returns same result as calculateCost with equivalent inputs", () => {
    const convenience = estimateCostUSD("gpt-4o", 1000, 500);
    const direct = calculateCost("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      estimated: false,
    });
    expect(convenience).toEqual(direct);
  });

  it("calculates known cost correctly", () => {
    // gpt-4o: $2.50/1M input, $10.00/1M output
    const cost = estimateCostUSD("gpt-4o", 10000, 2000);
    // Input: 10000/1M * $2.50 = $0.025
    // Output: 2000/1M * $10.00 = $0.02
    expect(cost).toBeCloseTo(0.045, 6);
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
    acc = new CostAccumulator({ jobId: 42, runId: "test-run-1" });
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
    expect(event.run_id).toBe("test-run-1");
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

  it("tracks retry count", () => {
    acc.recordCall(makeTelemetry({ status: "retry", error_type: "rate_limit" }));
    acc.recordCall(makeTelemetry({ status: "retry", error_type: "server_error" }));
    acc.recordCall(makeTelemetry({ status: "success" }), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });

    const summary = acc.getSummary();
    expect(summary.call_count).toBe(3);
    expect(summary.retry_count).toBe(2);
  });

  it("records error_type on events", () => {
    const retryTelemetry = makeTelemetry({ status: "retry", error_type: "rate_limit" });
    const event = acc.recordCall(retryTelemetry);

    expect(event.error_type).toBe("rate_limit");
    expect(event.status).toBe("retry");
  });

  it("includes elapsed_ms in summary", () => {
    acc.recordCall(makeTelemetry(), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    const summary = acc.getSummary();
    expect(summary.elapsed_ms).toBeDefined();
    expect(summary.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("clears events and resets start time", () => {
    acc.recordCall(makeTelemetry(), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    expect(acc.size).toBe(1);

    acc.clear();
    expect(acc.size).toBe(0);
    expect(acc.getEvents()).toEqual([]);
  });

  it("builds correct SQL for DB flush (all events including retries)", () => {
    acc.recordCall(makeTelemetry({ status: "retry", error_type: "rate_limit" }));
    acc.recordCall(makeTelemetry({ status: "success" }), { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    acc.recordCall(makeTelemetry({ status: "fatal", error_type: "auth_error" }));

    const insert = acc.buildInsertSQL();
    expect(insert).not.toBeNull();
    expect(insert!.sql).toContain("INSERT INTO llm_usage");
    expect(insert!.sql).toContain("request_id");
    expect(insert!.sql).toContain("run_id");
    expect(insert!.sql).toContain("attempt");
    expect(insert!.sql).toContain("error_type");
    expect(insert!.sql).toContain("cost_usd");
    // 3 events × 14 params each = 42
    expect(insert!.params.length).toBe(42);
  });

  it("returns null SQL when no events", () => {
    expect(acc.buildInsertSQL()).toBeNull();
  });

  it("persists retry events in SQL (no longer filters them out)", () => {
    acc.recordCall(makeTelemetry({ status: "retry" }));

    const insert = acc.buildInsertSQL();
    expect(insert).not.toBeNull();
    expect(insert!.params.length).toBe(14); // 1 event × 14 params
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

// ── BatchCostAccumulator ─────────────────────────────────────────

describe("BatchCostAccumulator", () => {
  it("starts with a generated run ID", () => {
    const batch = new BatchCostAccumulator();
    expect(batch.id).toMatch(/^batch-/);
  });

  it("uses provided run ID", () => {
    const batch = new BatchCostAccumulator({ runId: "my-run-123" });
    expect(batch.id).toBe("my-run-123");
  });

  it("aggregates costs from multiple packets", () => {
    const batch = new BatchCostAccumulator({ runId: "test-batch" });

    const summary1: CostSummary = {
      total_cost_usd: 0.05,
      total_prompt_tokens: 3000,
      total_completion_tokens: 1000,
      total_tokens: 4000,
      call_count: 3,
      retry_count: 1,
      avg_cost_per_call: 0.0167,
      by_stage: { "Stage 4": { cost_usd: 0.04, tokens: 3500, calls: 2 }, "Stage 8": { cost_usd: 0.01, tokens: 500, calls: 1 } },
      by_model: { "gpt-4o": { cost_usd: 0.05, tokens: 4000, calls: 3 } },
      estimated_pct: 0,
    };

    const summary2: CostSummary = {
      total_cost_usd: 0.03,
      total_prompt_tokens: 2000,
      total_completion_tokens: 800,
      total_tokens: 2800,
      call_count: 2,
      retry_count: 0,
      avg_cost_per_call: 0.015,
      by_stage: { "Stage 4": { cost_usd: 0.025, tokens: 2300, calls: 1 }, "Stage 8": { cost_usd: 0.005, tokens: 500, calls: 1 } },
      by_model: { "gpt-4o": { cost_usd: 0.03, tokens: 2800, calls: 2 } },
      estimated_pct: 50,
    };

    batch.addPacketCost(100, summary1);
    batch.addPacketCost(200, summary2);

    const batchSummary = batch.getSummary();

    expect(batchSummary.packet_count).toBe(2);
    expect(batchSummary.total_cost_usd).toBeCloseTo(0.08, 4);
    expect(batchSummary.avg_cost_per_packet).toBeCloseTo(0.04, 4);
    expect(batchSummary.total_tokens).toBe(6800);
    expect(batchSummary.call_count).toBe(5);
    expect(batchSummary.retry_count).toBe(1);
    expect(batchSummary.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(batchSummary.packet_costs.length).toBe(2);
    expect(batchSummary.packet_costs[0].job_id).toBe(100);
    expect(batchSummary.packet_costs[1].job_id).toBe(200);
  });

  it("merges stage breakdowns across packets", () => {
    const batch = new BatchCostAccumulator();

    const s1: CostSummary = {
      total_cost_usd: 0.05,
      total_prompt_tokens: 3000, total_completion_tokens: 1000, total_tokens: 4000,
      call_count: 2, retry_count: 0, avg_cost_per_call: 0.025,
      by_stage: { "Stage 4": { cost_usd: 0.04, tokens: 3500, calls: 1 }, "Stage 8": { cost_usd: 0.01, tokens: 500, calls: 1 } },
      by_model: {}, estimated_pct: 0,
    };
    const s2: CostSummary = {
      total_cost_usd: 0.03,
      total_prompt_tokens: 2000, total_completion_tokens: 800, total_tokens: 2800,
      call_count: 1, retry_count: 0, avg_cost_per_call: 0.03,
      by_stage: { "Stage 4": { cost_usd: 0.03, tokens: 2800, calls: 1 } },
      by_model: {}, estimated_pct: 0,
    };

    batch.addPacketCost(1, s1);
    batch.addPacketCost(2, s2);

    const summary = batch.getSummary();
    expect(summary.by_stage["Stage 4"].calls).toBe(2);
    expect(summary.by_stage["Stage 4"].cost_usd).toBeCloseTo(0.07, 4);
    expect(summary.by_stage["Stage 8"].calls).toBe(1);
  });

  it("handles empty batch", () => {
    const batch = new BatchCostAccumulator();
    const summary = batch.getSummary();
    expect(summary.packet_count).toBe(0);
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.avg_cost_per_packet).toBe(0);
  });
});

// ── Integration: Total Cost = Sum of Packet Costs ────────────────

describe("Integration: batch total equals sum of packets", () => {
  it("2 packets: total cost matches sum of individual costs", () => {
    const batch = new BatchCostAccumulator();

    // Simulate packet 1: 2 LLM calls
    const acc1 = new CostAccumulator({ jobId: 1, runId: batch.id });
    acc1.recordCall(makeTelemetry({ label: "Stage 2: Mandate Classifier" }), { promptTokens: 1500, completionTokens: 400, totalTokens: 1900 });
    acc1.recordCall(makeTelemetry({ label: "Stage 4: Resume Generation" }), { promptTokens: 3000, completionTokens: 1200, totalTokens: 4200 });
    const summary1 = acc1.getSummary();

    // Simulate packet 2: 3 LLM calls (1 retry + 2 success)
    const acc2 = new CostAccumulator({ jobId: 2, runId: batch.id });
    acc2.recordCall(makeTelemetry({ label: "Stage 2: Mandate Classifier", status: "retry", error_type: "rate_limit" }));
    acc2.recordCall(makeTelemetry({ label: "Stage 2: Mandate Classifier" }), { promptTokens: 1500, completionTokens: 400, totalTokens: 1900 });
    acc2.recordCall(makeTelemetry({ label: "Stage 4: Resume Generation" }), { promptTokens: 2800, completionTokens: 1000, totalTokens: 3800 });
    const summary2 = acc2.getSummary();

    batch.addPacketCost(1, summary1);
    batch.addPacketCost(2, summary2);

    const batchSummary = batch.getSummary();

    // Total should equal sum
    expect(batchSummary.total_cost_usd).toBeCloseTo(summary1.total_cost_usd + summary2.total_cost_usd, 4);
    expect(batchSummary.total_tokens).toBe(summary1.total_tokens + summary2.total_tokens);
    expect(batchSummary.call_count).toBe(summary1.call_count + summary2.call_count);
    expect(batchSummary.retry_count).toBe(1); // 1 retry in packet 2
    expect(batchSummary.packet_count).toBe(2);
    expect(batchSummary.avg_cost_per_packet).toBeCloseTo(batchSummary.total_cost_usd / 2, 4);
  });

  it("retry events are included in totals", () => {
    const acc = new CostAccumulator({ jobId: 1 });

    // Record retry + success
    const retryEvent = acc.recordCall(
      makeTelemetry({ status: "retry", error_type: "rate_limit", attempt: 0 }),
    );
    const successEvent = acc.recordCall(
      makeTelemetry({ status: "success", attempt: 1 }),
      { promptTokens: 2000, completionTokens: 800, totalTokens: 2800 },
    );

    const summary = acc.getSummary();

    // Both events contribute to totals
    expect(summary.call_count).toBe(2);
    expect(summary.retry_count).toBe(1);
    expect(summary.total_cost_usd).toBeCloseTo(retryEvent.cost_usd + successEvent.cost_usd, 6);
    expect(summary.total_tokens).toBe(retryEvent.usage.total_tokens + successEvent.usage.total_tokens);

    // SQL should include both
    const insert = acc.buildInsertSQL();
    expect(insert).not.toBeNull();
    expect(insert!.params.length).toBe(28); // 2 events × 14 params
  });
});

// ── Summarization ────────────────────────────────────────────────

describe("summarizeEvents", () => {
  it("handles empty event list", () => {
    const summary = summarizeEvents([]);
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.call_count).toBe(0);
    expect(summary.retry_count).toBe(0);
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
    expect(summary.retry_count).toBe(0);
    expect(summary.total_prompt_tokens).toBe(3000);
    expect(summary.total_completion_tokens).toBe(1100);
    expect(summary.total_tokens).toBe(4100);
    expect(summary.total_cost_usd).toBeCloseTo(0.0185, 4);
    expect(summary.estimated_pct).toBe(50);
  });

  it("counts retry events separately", () => {
    const events: UsageEvent[] = [
      {
        request_id: "r1", job_id: 1, label: "Stage 4: Resume", model: "gpt-4o",
        usage: { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000, estimated: true },
        cost_usd: 0.003, duration_ms: 1000, attempt: 0, status: "retry", error_type: "rate_limit",
        timestamp: new Date().toISOString(),
      },
      {
        request_id: "r1", job_id: 1, label: "Stage 4: Resume", model: "gpt-4o",
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, estimated: false },
        cost_usd: 0.0075, duration_ms: 3000, attempt: 1, status: "success",
        timestamp: new Date().toISOString(),
      },
    ];

    const summary = summarizeEvents(events);
    expect(summary.call_count).toBe(2);
    expect(summary.retry_count).toBe(1);
  });
});

// ── extractStageKey ──────────────────────────────────────────────

describe("extractStageKey", () => {
  it("extracts 'Stage 4' from full label", () => {
    expect(extractStageKey("Stage 4: Resume Generation")).toBe("Stage 4");
  });

  it("extracts 'Stage 8' from full label", () => {
    expect(extractStageKey("Stage 8: recruiter-review")).toBe("Stage 8");
  });

  it("returns full label if no stage prefix", () => {
    expect(extractStageKey("Custom Label")).toBe("Custom Label");
  });

  it("is case-insensitive", () => {
    expect(extractStageKey("stage 2: Mandate")).toBe("stage 2");
  });
});

// ── Format Cost Summary ──────────────────────────────────────────

describe("formatCostSummary", () => {
  it("produces readable output with retry info", () => {
    const summary: CostSummary = {
      total_cost_usd: 0.0475,
      total_prompt_tokens: 5000,
      total_completion_tokens: 2000,
      total_tokens: 7000,
      call_count: 3,
      retry_count: 1,
      avg_cost_per_call: 0.0158,
      by_stage: {
        "Stage 4": { cost_usd: 0.035, tokens: 5000, calls: 2 },
        "Stage 8": { cost_usd: 0.0125, tokens: 2000, calls: 1 },
      },
      by_model: {
        "gpt-4o": { cost_usd: 0.0475, tokens: 7000, calls: 3 },
      },
      estimated_pct: 0,
      elapsed_ms: 12500,
    };

    const output = formatCostSummary(summary);
    expect(output).toContain("LLM Cost Summary");
    expect(output).toContain("$0.0475");
    expect(output).toContain("3 call(s)");
    expect(output).toContain("1 retries");
    expect(output).toContain("12.5s");
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
      retry_count: 0,
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

// ── Format Batch Cost Summary ────────────────────────────────────

describe("formatBatchCostSummary", () => {
  it("produces readable batch output", () => {
    const summary: BatchCostSummary = {
      total_cost_usd: 0.12,
      total_prompt_tokens: 10000,
      total_completion_tokens: 4000,
      total_tokens: 14000,
      call_count: 6,
      retry_count: 2,
      avg_cost_per_call: 0.02,
      by_stage: {},
      by_model: {},
      estimated_pct: 0,
      elapsed_ms: 45000,
      packet_count: 3,
      avg_cost_per_packet: 0.04,
      packet_costs: [
        { job_id: 1, cost_usd: 0.05, tokens: 5000, calls: 2 },
        { job_id: 2, cost_usd: 0.04, tokens: 5000, calls: 2 },
        { job_id: 3, cost_usd: 0.03, tokens: 4000, calls: 2 },
      ],
    };

    const output = formatBatchCostSummary(summary);
    expect(output).toContain("Batch LLM Cost Summary");
    expect(output).toContain("$0.1200");
    expect(output).toContain("3 packet(s)");
    expect(output).toContain("Avg per packet: $0.0400");
    expect(output).toContain("Retries: 2");
    expect(output).toContain("Job 1:");
    expect(output).toContain("Job 2:");
    expect(output).toContain("Job 3:");
    expect(output).toContain("45.0s");
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
  it("exports COST_QUERY_BY_JOB with retry_count", () => {
    expect(COST_QUERY_BY_JOB).toContain("llm_usage");
    expect(COST_QUERY_BY_JOB).toContain("job_id = $1");
    expect(COST_QUERY_BY_JOB).toContain("retry");
  });

  it("exports COST_QUERY_BY_RUN", () => {
    expect(COST_QUERY_BY_RUN).toContain("run_id = $1");
    expect(COST_QUERY_BY_RUN).toContain("packet_count");
    expect(COST_QUERY_BY_RUN).toContain("retry");
  });

  it("exports COST_QUERY_DAILY", () => {
    expect(COST_QUERY_DAILY).toContain("DATE(created_at)");
    expect(COST_QUERY_DAILY).toContain("LIMIT $1");
    expect(COST_QUERY_DAILY).toContain("retry");
  });

  it("exports COST_QUERY_BY_STAGE", () => {
    expect(COST_QUERY_BY_STAGE).toContain("GROUP BY label");
    expect(COST_QUERY_BY_STAGE).toContain("job_id = $1");
    expect(COST_QUERY_BY_STAGE).toContain("retry");
  });
});

// ── Module Exports ───────────────────────────────────────────────

describe("Module Exports", () => {
  it("exports all expected types and functions", () => {
    expect(typeof PRICING_REGISTRY).toBe("object");
    expect(typeof calculateCost).toBe("function");
    expect(typeof estimateCostUSD).toBe("function");
    expect(typeof estimateTokenUsage).toBe("function");
    expect(typeof getModelPricing).toBe("function");
    expect(typeof CostAccumulator).toBe("function");
    expect(typeof BatchCostAccumulator).toBe("function");
    expect(typeof summarizeEvents).toBe("function");
    expect(typeof formatCostSummary).toBe("function");
    expect(typeof formatBatchCostSummary).toBe("function");
    expect(typeof extractStageKey).toBe("function");
    expect(typeof setGlobalCostAccumulator).toBe("function");
    expect(typeof getGlobalCostAccumulator).toBe("function");
  });
});
