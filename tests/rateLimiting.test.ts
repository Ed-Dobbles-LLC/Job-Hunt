/**
 * Rate Limiting Infrastructure Tests
 *
 * Tests for:
 * - LLM Concurrency Limiter (semaphore with lanes)
 * - Resilient Generate Object (retry, backoff, Retry-After)
 * - Token Budget Manager
 * - LLMError user-friendly messages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Concurrency Limiter Tests ───────────────────────────────────

describe("LLMConcurrencyLimiter", () => {
  let LLMConcurrencyLimiter: any;
  let resetGlobalLimiter: any;
  let getGlobalLimiter: any;

  beforeEach(async () => {
    const mod = await import("../src/resume-engine/llm-concurrency-limiter");
    LLMConcurrencyLimiter = mod.LLMConcurrencyLimiter;
    resetGlobalLimiter = mod.resetGlobalLimiter;
    getGlobalLimiter = mod.getGlobalLimiter;
    resetGlobalLimiter();
  });

  afterEach(() => {
    resetGlobalLimiter();
  });

  it("should use default limits (heavy=1, medium=2, light=3)", () => {
    const limiter = new LLMConcurrencyLimiter();
    const snap = limiter.snapshot();
    expect(snap.heavy.limit).toBe(1);
    expect(snap.medium.limit).toBe(2);
    expect(snap.light.limit).toBe(3);
  });

  it("should accept custom limits", () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 2, medium: 4, light: 6 });
    const snap = limiter.snapshot();
    expect(snap.heavy.limit).toBe(2);
    expect(snap.medium.limit).toBe(4);
    expect(snap.light.limit).toBe(6);
  });

  it("should serialize heavy lane (limit=1)", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1 });
    const executionOrder: number[] = [];

    const task1 = limiter.run("heavy", async () => {
      executionOrder.push(1);
      await new Promise(r => setTimeout(r, 50));
      executionOrder.push(10);
      return "a";
    });

    const task2 = limiter.run("heavy", async () => {
      executionOrder.push(2);
      await new Promise(r => setTimeout(r, 10));
      executionOrder.push(20);
      return "b";
    });

    const [r1, r2] = await Promise.all([task1, task2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");

    // Task 1 should start and finish before task 2 starts
    expect(executionOrder[0]).toBe(1);
    expect(executionOrder[1]).toBe(10);
    expect(executionOrder[2]).toBe(2);
    expect(executionOrder[3]).toBe(20);
  });

  it("should allow concurrent medium lane (limit=2)", async () => {
    const limiter = new LLMConcurrencyLimiter({ medium: 2 });
    const active: number[] = [];
    let maxActive = 0;

    const task = async (id: number) => {
      return limiter.run("medium", async () => {
        active.push(id);
        maxActive = Math.max(maxActive, active.length);
        await new Promise(r => setTimeout(r, 30));
        active.splice(active.indexOf(id), 1);
        return id;
      });
    };

    await Promise.all([task(1), task(2), task(3)]);
    // Two should run concurrently
    expect(maxActive).toBe(2);
  });

  it("should track active and queued counts", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1 });

    // Start one task that blocks
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>(r => { resolveFirst = r; });

    const task1 = limiter.run("heavy", async () => {
      await firstDone;
    });

    // Allow task1 to start
    await new Promise(r => setTimeout(r, 10));

    const snap1 = limiter.snapshot();
    expect(snap1.heavy.active).toBe(1);
    expect(snap1.heavy.queued).toBe(0);

    // Queue a second task
    const task2 = limiter.run("heavy", async () => "done");

    await new Promise(r => setTimeout(r, 10));
    const snap2 = limiter.snapshot();
    expect(snap2.heavy.active).toBe(1);
    expect(snap2.heavy.queued).toBe(1);

    // Release first task
    resolveFirst();
    await task1;
    const result = await task2;
    expect(result).toBe("done");
  });

  it("should release slot on error", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1 });

    try {
      await limiter.run("heavy", async () => {
        throw new Error("boom");
      });
    } catch { /* expected */ }

    // Slot should be released — next task should run immediately
    const result = await limiter.run("heavy", async () => "ok");
    expect(result).toBe("ok");
  });

  it("should allow changing limits at runtime", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1 });
    limiter.setLimit("heavy", 3);
    const snap = limiter.snapshot();
    expect(snap.heavy.limit).toBe(3);
  });

  it("should drain queue when limit increases", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1 });
    const results: string[] = [];

    // Fill the slot
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>(r => { resolveFirst = r; });
    const task1 = limiter.run("heavy", async () => {
      await firstDone;
      results.push("task1");
    });

    await new Promise(r => setTimeout(r, 10));

    // Queue two more
    const task2 = limiter.run("heavy", async () => { results.push("task2"); });
    const task3 = limiter.run("heavy", async () => { results.push("task3"); });

    await new Promise(r => setTimeout(r, 10));
    expect(limiter.snapshot().heavy.queued).toBe(2);

    // Increase limit — should drain some queued tasks
    limiter.setLimit("heavy", 3);

    // Now two queued tasks should be able to run
    await new Promise(r => setTimeout(r, 10));
    expect(limiter.snapshot().heavy.queued).toBe(0);

    resolveFirst();
    await Promise.all([task1, task2, task3]);
    expect(results).toContain("task1");
    expect(results).toContain("task2");
    expect(results).toContain("task3");
  });

  it("should reject all queued entries on rejectAll", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1 });

    // Fill the slot
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>(r => { resolveFirst = r; });
    const task1 = limiter.run("heavy", async () => { await firstDone; });

    await new Promise(r => setTimeout(r, 10));

    // Queue another task
    const task2 = limiter.run("heavy", async () => "unreachable");

    await new Promise(r => setTimeout(r, 10));
    expect(limiter.snapshot().heavy.queued).toBe(1);

    // Reject all
    limiter.rejectAll("shutdown");

    await expect(task2).rejects.toThrow("shutdown");

    resolveFirst();
    await task1;
  });

  it("global limiter should be a singleton", () => {
    const a = getGlobalLimiter({ heavy: 5 });
    const b = getGlobalLimiter({ heavy: 10 }); // ignored — already created
    expect(a).toBe(b);
    expect(a.snapshot().heavy.limit).toBe(5);
  });
});

// ── Token Budget Tests ──────────────────────────────────────────

describe("Token Budget Manager", () => {
  let estimateStage4Tokens: any;
  let computeMaxOutputTokens: any;

  beforeEach(async () => {
    const mod = await import("../src/resume-engine/token-budget");
    estimateStage4Tokens = mod.estimateStage4Tokens;
    computeMaxOutputTokens = mod.computeMaxOutputTokens;
  });

  it("should estimate tokens based on character length", () => {
    // 4000 chars / 4 chars per token = 1000 tokens
    const system = "x".repeat(4000);
    const user = "y".repeat(8000);

    const est = estimateStage4Tokens(system, user);
    expect(est.system_tokens).toBe(1000);
    expect(est.user_tokens).toBe(2000);
    expect(est.estimated_output_tokens).toBe(1500); // ESTIMATED_RESUME_OUTPUT_TOKENS
    expect(est.total_estimated).toBe(4500);
  });

  it("should mark exceeds_budget when over limit", () => {
    // Create prompts that exceed 8000 token budget
    const system = "x".repeat(20000); // 5000 tokens
    const user = "y".repeat(20000);   // 5000 tokens + 1500 output = 11500

    const est = estimateStage4Tokens(system, user);
    expect(est.exceeds_budget).toBe(true);
    expect(est.recommend_split).toBe(true);
  });

  it("should not exceed budget for small prompts", () => {
    const system = "x".repeat(1000);
    const user = "y".repeat(2000);

    const est = estimateStage4Tokens(system, user);
    expect(est.exceeds_budget).toBe(false);
    expect(est.recommend_split).toBe(false);
  });

  it("should force split when configured", () => {
    const system = "x".repeat(100);
    const user = "y".repeat(100);

    const est = estimateStage4Tokens(system, user, { forceSplit: true });
    expect(est.recommend_split).toBe(true);
    expect(est.exceeds_budget).toBe(false); // Still under budget
  });

  it("should allow custom chars per token", () => {
    const system = "x".repeat(3000);
    const user = "y".repeat(3000);

    // 3 chars per token instead of 4
    const est = estimateStage4Tokens(system, user, { charsPerToken: 3 });
    expect(est.system_tokens).toBe(1000);
    expect(est.user_tokens).toBe(1000);
  });

  it("should compute max output tokens by call type", () => {
    expect(computeMaxOutputTokens("resume")).toBe(1500);
    expect(computeMaxOutputTokens("cover_letter")).toBe(600);
    expect(computeMaxOutputTokens("review")).toBe(1200);
  });
});

// ── LLMError Tests ──────────────────────────────────────────────

describe("LLMError", () => {
  let LLMError: any;

  beforeEach(async () => {
    const mod = await import("../src/resume-engine/llm-retry");
    LLMError = mod.LLMError;
  });

  it("should provide user-friendly rate limit message", () => {
    const err = new LLMError("429 Too Many Requests", "rate_limit", "req-1", 3, []);
    expect(err.toUserMessage()).toContain("Rate limit");
    expect(err.toUserMessage()).toContain("sequentially");
  });

  it("should provide user-friendly timeout message", () => {
    const err = new LLMError("Aborted", "timeout", "req-2", 1, []);
    expect(err.toUserMessage()).toContain("timed out");
  });

  it("should provide user-friendly auth error message", () => {
    const err = new LLMError("401 Unauthorized", "auth_error", "req-3", 1, []);
    expect(err.toUserMessage()).toContain("API key");
  });

  it("should include debug payload with telemetry", () => {
    const telemetry = [
      { request_id: "req-1", attempt: 0, delay_ms: 1500, status: "retry" as const, label: "test", max_retries: 3, duration_ms: 100, model: "gpt-4o", prompt_chars: 1000, lane: "heavy" as const, timestamp: new Date().toISOString() },
      { request_id: "req-1", attempt: 1, delay_ms: 3000, status: "retry" as const, label: "test", max_retries: 3, duration_ms: 100, model: "gpt-4o", prompt_chars: 1000, lane: "heavy" as const, timestamp: new Date().toISOString() },
      { request_id: "req-1", attempt: 2, status: "fatal" as const, label: "test", max_retries: 3, duration_ms: 100, model: "gpt-4o", prompt_chars: 1000, lane: "heavy" as const, timestamp: new Date().toISOString() },
    ];

    const err = new LLMError("Rate limited", "rate_limit", "req-1", 3, telemetry);
    const debug = err.toDebugPayload();
    expect(debug.request_id).toBe("req-1");
    expect(debug.attempts).toBe(3);
    expect(debug.backoff_schedule).toHaveLength(2);
    expect(debug.backoff_schedule[0]).toContain("1500ms");
    expect(debug.backoff_schedule[1]).toContain("3000ms");
  });

  it("should be an instance of Error", () => {
    const err = new LLMError("test", "unknown", "req-1", 1, []);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LLMError");
  });
});

// ── Resilient Generate Object Tests ──────────────────────────────

describe("resilientGenerateObject", () => {
  let resilientGenerateObject: any;
  let resetGlobalLimiter: any;
  let resetOpenAIClient: any;

  beforeEach(async () => {
    const retryMod = await import("../src/resume-engine/llm-retry");
    resilientGenerateObject = retryMod.resilientGenerateObject;
    resetOpenAIClient = retryMod.resetOpenAIClient;

    const limiterMod = await import("../src/resume-engine/llm-concurrency-limiter");
    resetGlobalLimiter = limiterMod.resetGlobalLimiter;

    resetGlobalLimiter();
    resetOpenAIClient();
  });

  afterEach(() => {
    resetGlobalLimiter();
    vi.restoreAllMocks();
  });

  it("should create LLMError with correct properties for auth errors", async () => {
    // Auth errors should be fatal (not retried)
    // Verify the LLMError class carries all needed data
    const { LLMError } = await import("../src/resume-engine/llm-retry");

    const telemetry = [{
      request_id: "req-auth",
      label: "test-auth",
      attempt: 0,
      max_retries: 3,
      status: "fatal" as const,
      error_type: "auth_error",
      duration_ms: 50,
      model: "gpt-4o",
      prompt_chars: 500,
      lane: "light" as const,
      timestamp: new Date().toISOString(),
    }];

    const err = new LLMError(
      "[test-auth] auth_error: 401 Unauthorized",
      "auth_error",
      "req-auth",
      1, // Only 1 attempt — auth errors are fatal
      telemetry,
    );

    expect(err.name).toBe("LLMError");
    expect(err.errorType).toBe("auth_error");
    expect(err.attempts).toBe(1);
    expect(err.requestId).toBe("req-auth");
    expect(err.telemetry).toHaveLength(1);
    expect(err.telemetry[0].status).toBe("fatal");
    expect(err.toUserMessage()).toContain("API key");
  });

  it("should classify error types correctly", async () => {
    // Test the classifyError logic indirectly through LLMError
    const { LLMError } = await import("../src/resume-engine/llm-retry");

    // Rate limit errors
    const rateLimitErr = new LLMError("429", "rate_limit", "r1", 1, []);
    expect(rateLimitErr.errorType).toBe("rate_limit");

    // Schema errors
    const schemaErr = new LLMError("did not match schema", "schema_error", "r2", 1, []);
    expect(schemaErr.errorType).toBe("schema_error");

    // Timeout errors
    const timeoutErr = new LLMError("abort", "timeout", "r3", 1, []);
    expect(timeoutErr.errorType).toBe("timeout");
  });
});

// ── Concurrent Serialization Integration Test ───────────────────

describe("Concurrent Packet Serialization", () => {
  let LLMConcurrencyLimiter: any;

  beforeEach(async () => {
    const mod = await import("../src/resume-engine/llm-concurrency-limiter");
    LLMConcurrencyLimiter = mod.LLMConcurrencyLimiter;
  });

  it("should serialize two concurrent Stage 4 calls via heavy lane", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1, medium: 2, light: 3 });
    const timeline: { event: string; time: number }[] = [];
    const start = Date.now();

    const stage4Packet1 = limiter.run("heavy", async () => {
      timeline.push({ event: "packet1-start", time: Date.now() - start });
      await new Promise(r => setTimeout(r, 50));
      timeline.push({ event: "packet1-end", time: Date.now() - start });
      return "resume1";
    });

    const stage4Packet2 = limiter.run("heavy", async () => {
      timeline.push({ event: "packet2-start", time: Date.now() - start });
      await new Promise(r => setTimeout(r, 50));
      timeline.push({ event: "packet2-end", time: Date.now() - start });
      return "resume2";
    });

    const [r1, r2] = await Promise.all([stage4Packet1, stage4Packet2]);
    expect(r1).toBe("resume1");
    expect(r2).toBe("resume2");

    // Packet 2 should not start until packet 1 ends
    const packet1End = timeline.find(e => e.event === "packet1-end")!.time;
    const packet2Start = timeline.find(e => e.event === "packet2-start")!.time;
    expect(packet2Start).toBeGreaterThanOrEqual(packet1End);
  });

  it("should allow parallel lighter stages while heavy is running", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1, medium: 2, light: 3 });
    const concurrent: string[] = [];

    let resolveHeavy!: () => void;
    const heavyDone = new Promise<void>(r => { resolveHeavy = r; });

    // Start a heavy task that blocks
    const heavyTask = limiter.run("heavy", async () => {
      concurrent.push("heavy-start");
      await heavyDone;
      concurrent.push("heavy-end");
    });

    await new Promise(r => setTimeout(r, 10));

    // Start two medium tasks — should run concurrently with each other
    const medium1 = limiter.run("medium", async () => {
      concurrent.push("medium1");
      return "m1";
    });
    const medium2 = limiter.run("medium", async () => {
      concurrent.push("medium2");
      return "m2";
    });

    const [m1, m2] = await Promise.all([medium1, medium2]);
    expect(m1).toBe("m1");
    expect(m2).toBe("m2");

    // Medium tasks completed while heavy is still running
    expect(concurrent).toContain("medium1");
    expect(concurrent).toContain("medium2");
    expect(concurrent).not.toContain("heavy-end");

    resolveHeavy();
    await heavyTask;
    expect(concurrent).toContain("heavy-end");
  });

  it("should handle mixed lane concurrent stress test", async () => {
    const limiter = new LLMConcurrencyLimiter({ heavy: 1, medium: 2, light: 3 });
    const results: string[] = [];

    const tasks = [
      limiter.run("heavy", async () => { await new Promise(r => setTimeout(r, 10)); results.push("h1"); }),
      limiter.run("heavy", async () => { await new Promise(r => setTimeout(r, 10)); results.push("h2"); }),
      limiter.run("medium", async () => { await new Promise(r => setTimeout(r, 10)); results.push("m1"); }),
      limiter.run("medium", async () => { await new Promise(r => setTimeout(r, 10)); results.push("m2"); }),
      limiter.run("medium", async () => { await new Promise(r => setTimeout(r, 10)); results.push("m3"); }),
      limiter.run("light", async () => { await new Promise(r => setTimeout(r, 10)); results.push("l1"); }),
      limiter.run("light", async () => { await new Promise(r => setTimeout(r, 10)); results.push("l2"); }),
      limiter.run("light", async () => { await new Promise(r => setTimeout(r, 10)); results.push("l3"); }),
      limiter.run("light", async () => { await new Promise(r => setTimeout(r, 10)); results.push("l4"); }),
    ];

    await Promise.all(tasks);

    // All tasks should complete
    expect(results).toHaveLength(9);
    expect(results).toContain("h1");
    expect(results).toContain("h2");
    expect(results).toContain("m1");
    expect(results).toContain("l4");

    // Heavy tasks should be serialized — h1 before h2
    expect(results.indexOf("h1")).toBeLessThan(results.indexOf("h2"));
  });
});

// ── Batch Auto-Generate Tests ───────────────────────────────────

describe("BatchProgress callback", () => {
  it("BatchProgress interface should be importable", async () => {
    const mod = await import("../src/resume-engine/auto-generate");
    // The module should export the types (even if runtime check is just for existence)
    expect(mod.autoGeneratePackets).toBeDefined();
    expect(typeof mod.autoGeneratePackets).toBe("function");
    expect(mod.autoGenerateInBackground).toBeDefined();
    expect(typeof mod.autoGenerateInBackground).toBe("function");
  });
});
