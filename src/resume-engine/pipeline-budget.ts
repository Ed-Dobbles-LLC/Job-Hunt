/**
 * Pipeline Budget Enforcer
 *
 * Centralized enforcement of all resource limits for a single pipeline run:
 *
 *   1. LLM Call Cap        — Max LLM calls per packet (default: 12)
 *   2. Repair Loop Cap     — Max total repair loops across all stages (default: 3)
 *   3. Token Budget        — Max total tokens per packet (default: 500K)
 *   4. Cost Ceiling        — Max USD per packet (default: $2.00)
 *   5. Wall-Clock Timeout  — Max elapsed time per packet (default: 10 min)
 *
 * The orchestrator checks the budget between stages. If any limit is
 * exceeded, the pipeline returns a structured BudgetExceeded error
 * and does NOT cascade retries.
 *
 * Configuration:
 *   - Defaults are defined here and can be overridden via PipelineInput.
 *   - Environment variables (PIPELINE_MAX_LLM_CALLS, PIPELINE_MAX_COST_USD,
 *     PIPELINE_MAX_TOKENS, PIPELINE_MAX_REPAIR_LOOPS, PIPELINE_TIMEOUT_MS)
 *     override constructor defaults.
 */

import type { CostAccumulator } from "./cost-tracker";

// ── Budget Configuration ─────────────────────────────────────────

export interface BudgetConfig {
  /** Max LLM calls per packet (default: 12) */
  max_llm_calls: number;
  /** Max total repair loops across all stages (default: 3) */
  max_repair_loops: number;
  /** Max total tokens per packet (default: 500,000) */
  max_tokens: number;
  /** Max cost in USD per packet (default: 2.00) */
  max_cost_usd: number;
  /** Max wall-clock time in ms (default: 600,000 = 10 min) */
  timeout_ms: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  max_llm_calls: 12,
  max_repair_loops: 3,
  max_tokens: 500_000,
  max_cost_usd: 2.00,
  timeout_ms: 600_000,
};

/**
 * Load budget config from env vars, falling back to defaults.
 */
export function loadBudgetConfig(overrides?: Partial<BudgetConfig>): BudgetConfig {
  const env = (key: string, fallback: number): number => {
    const val = process.env[key];
    return val != null ? parseFloat(val) : fallback;
  };

  return {
    max_llm_calls: overrides?.max_llm_calls ?? env("PIPELINE_MAX_LLM_CALLS", DEFAULT_BUDGET.max_llm_calls),
    max_repair_loops: overrides?.max_repair_loops ?? env("PIPELINE_MAX_REPAIR_LOOPS", DEFAULT_BUDGET.max_repair_loops),
    max_tokens: overrides?.max_tokens ?? env("PIPELINE_MAX_TOKENS", DEFAULT_BUDGET.max_tokens),
    max_cost_usd: overrides?.max_cost_usd ?? env("PIPELINE_MAX_COST_USD", DEFAULT_BUDGET.max_cost_usd),
    timeout_ms: overrides?.timeout_ms ?? env("PIPELINE_TIMEOUT_MS", DEFAULT_BUDGET.timeout_ms),
  };
}

// ── Budget Exceeded Error ────────────────────────────────────────

export type BudgetViolationType =
  | "llm_calls_exceeded"
  | "repair_loops_exceeded"
  | "tokens_exceeded"
  | "cost_exceeded"
  | "timeout_exceeded";

export interface BudgetViolation {
  type: BudgetViolationType;
  limit: number;
  actual: number;
  message: string;
}

export class BudgetExceededError extends Error {
  readonly violation: BudgetViolation;

  constructor(violation: BudgetViolation) {
    super(`Pipeline budget exceeded: ${violation.message}`);
    this.name = "BudgetExceededError";
    this.violation = violation;
  }
}

// ── Budget Tracker ───────────────────────────────────────────────

/**
 * Tracks resource consumption during a pipeline run and enforces limits.
 *
 * Usage:
 *   const budget = new PipelineBudget(config);
 *   budget.recordLLMCall();          // After each LLM call
 *   budget.recordRepairLoop();       // After each repair loop
 *   budget.check(costAccumulator);   // Between stages — throws on violation
 */
export class PipelineBudget {
  private config: BudgetConfig;
  private startTime: number;
  private llmCalls: number = 0;
  private repairLoops: number = 0;
  private logger?: any;

  constructor(config: BudgetConfig, logger?: any) {
    this.config = config;
    this.startTime = Date.now();
    this.logger = logger;
  }

  /** Record an LLM call. */
  recordLLMCall(count: number = 1): void {
    this.llmCalls += count;
  }

  /** Record a repair loop iteration. */
  recordRepairLoop(): void {
    this.repairLoops++;
  }

  /** Get current consumption snapshot. */
  getSnapshot(): {
    llm_calls: number;
    repair_loops: number;
    elapsed_ms: number;
    config: BudgetConfig;
  } {
    return {
      llm_calls: this.llmCalls,
      repair_loops: this.repairLoops,
      elapsed_ms: Date.now() - this.startTime,
      config: { ...this.config },
    };
  }

  /** Get remaining budget. */
  getRemaining(): {
    llm_calls: number;
    repair_loops: number;
    time_ms: number;
  } {
    return {
      llm_calls: Math.max(0, this.config.max_llm_calls - this.llmCalls),
      repair_loops: Math.max(0, this.config.max_repair_loops - this.repairLoops),
      time_ms: Math.max(0, this.config.timeout_ms - (Date.now() - this.startTime)),
    };
  }

  /**
   * Check all budget limits. Throws BudgetExceededError on violation.
   *
   * @param costAccumulator - Optional cost accumulator for cost/token checks
   */
  check(costAccumulator?: CostAccumulator | null): void {
    // 1. LLM call cap
    if (this.llmCalls > this.config.max_llm_calls) {
      const violation: BudgetViolation = {
        type: "llm_calls_exceeded",
        limit: this.config.max_llm_calls,
        actual: this.llmCalls,
        message: `LLM calls (${this.llmCalls}) exceed limit (${this.config.max_llm_calls})`,
      };
      this.logger?.warn(`🚫 [Budget] ${violation.message}`);
      throw new BudgetExceededError(violation);
    }

    // 2. Repair loop cap
    if (this.repairLoops > this.config.max_repair_loops) {
      const violation: BudgetViolation = {
        type: "repair_loops_exceeded",
        limit: this.config.max_repair_loops,
        actual: this.repairLoops,
        message: `Repair loops (${this.repairLoops}) exceed limit (${this.config.max_repair_loops})`,
      };
      this.logger?.warn(`🚫 [Budget] ${violation.message}`);
      throw new BudgetExceededError(violation);
    }

    // 3. Wall-clock timeout
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.config.timeout_ms) {
      const violation: BudgetViolation = {
        type: "timeout_exceeded",
        limit: this.config.timeout_ms,
        actual: elapsed,
        message: `Elapsed time (${Math.round(elapsed / 1000)}s) exceeds timeout (${Math.round(this.config.timeout_ms / 1000)}s)`,
      };
      this.logger?.warn(`🚫 [Budget] ${violation.message}`);
      throw new BudgetExceededError(violation);
    }

    // 4. Cost ceiling (if cost accumulator available)
    if (costAccumulator) {
      const summary = costAccumulator.getSummary();

      if (summary.total_cost_usd > this.config.max_cost_usd) {
        const violation: BudgetViolation = {
          type: "cost_exceeded",
          limit: this.config.max_cost_usd,
          actual: summary.total_cost_usd,
          message: `Cost ($${summary.total_cost_usd.toFixed(4)}) exceeds limit ($${this.config.max_cost_usd.toFixed(2)})`,
        };
        this.logger?.warn(`🚫 [Budget] ${violation.message}`);
        throw new BudgetExceededError(violation);
      }

      // 5. Token budget
      if (summary.total_tokens > this.config.max_tokens) {
        const violation: BudgetViolation = {
          type: "tokens_exceeded",
          limit: this.config.max_tokens,
          actual: summary.total_tokens,
          message: `Tokens (${summary.total_tokens.toLocaleString()}) exceed limit (${this.config.max_tokens.toLocaleString()})`,
        };
        this.logger?.warn(`🚫 [Budget] ${violation.message}`);
        throw new BudgetExceededError(violation);
      }
    }
  }

  /**
   * Check if a proposed action would exceed the budget.
   * Returns the violation that WOULD be triggered, or null if safe.
   * Does NOT throw.
   */
  wouldExceed(action: {
    llm_calls?: number;
    repair_loops?: number;
  }): BudgetViolation | null {
    const projectedCalls = this.llmCalls + (action.llm_calls ?? 0);
    if (projectedCalls > this.config.max_llm_calls) {
      return {
        type: "llm_calls_exceeded",
        limit: this.config.max_llm_calls,
        actual: projectedCalls,
        message: `Would reach ${projectedCalls} LLM calls (limit: ${this.config.max_llm_calls})`,
      };
    }

    const projectedLoops = this.repairLoops + (action.repair_loops ?? 0);
    if (projectedLoops > this.config.max_repair_loops) {
      return {
        type: "repair_loops_exceeded",
        limit: this.config.max_repair_loops,
        actual: projectedLoops,
        message: `Would reach ${projectedLoops} repair loops (limit: ${this.config.max_repair_loops})`,
      };
    }

    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.config.timeout_ms) {
      return {
        type: "timeout_exceeded",
        limit: this.config.timeout_ms,
        actual: elapsed,
        message: `Already timed out (${Math.round(elapsed / 1000)}s > ${Math.round(this.config.timeout_ms / 1000)}s)`,
      };
    }

    return null;
  }
}
