/**
 * LLM Retry Wrapper
 *
 * Robust retry handling for OpenAI calls that:
 *   - Reads and honors Retry-After header from 429 responses
 *   - Uses exponential backoff with jitter for other transient errors
 *   - Only retries on 429, 5xx, and timeouts (not validation failures)
 *   - Caps retries per call and logs structured telemetry per attempt
 *   - Integrates with the LLM Concurrency Limiter
 *
 * Replaces the ad-hoc safeGenerateObject wrappers scattered across the
 * codebase with a single, tested utility.
 */

import { z } from "zod";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getGlobalLimiter, type LaneName } from "./llm-concurrency-limiter";
import { getGlobalCostAccumulator } from "./cost-tracker";
import { resolveProvider, type LLMProviderConfig } from "./llm-provider";

// ── Types ───────────────────────────────────────────────────────

export interface RetryConfig {
  /** Base delay in ms before first retry (default: 1500) */
  baseDelayMs?: number;
  /** Multiplier per retry (default: 2) */
  factor?: number;
  /** Random jitter factor 0–1 (default: 0.3) */
  jitter?: number;
  /** Maximum delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Maximum retries per call (default: 5) */
  maxRetries?: number;
  /** Timeout per LLM call in ms (default: 120000) */
  timeoutMs?: number;
}

export interface LLMCallOptions<T extends z.ZodTypeAny> {
  schema: T;
  system: string;
  prompt: string;
  temperature: number;
  /** Human-readable label for logging (e.g., "Stage 4: Resume Generation") */
  label: string;
  /** Which concurrency lane to use (default: "heavy") */
  lane?: LaneName;
  /** Model ID (default: auto-detected from environment — Claude if ANTHROPIC_API_KEY set, else GPT-4o) */
  model?: string;
  /** LLM provider config override (provider, model, force) */
  providerConfig?: LLMProviderConfig;
  /** Override max_tokens on the generation call */
  maxTokens?: number;
  /** Retry configuration overrides */
  retry?: RetryConfig;
  /** Logger instance for structured telemetry */
  logger?: any;
}

export interface AttemptTelemetry {
  request_id: string;
  label: string;
  attempt: number;
  max_retries: number;
  status: "success" | "retry" | "fatal";
  error_type?: string;
  delay_ms?: number;
  retry_after_ms?: number;
  duration_ms: number;
  model: string;
  prompt_chars: number;
  lane: LaneName;
  timestamp: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMCallResult<T> {
  object: T;
  attempts: number;
  total_duration_ms: number;
  telemetry: AttemptTelemetry[];
  /** Actual token usage from the API (if available) */
  usage?: LLMUsage;
}

// ── Default Config ──────────────────────────────────────────────

const DEFAULTS: Required<RetryConfig> = {
  baseDelayMs: 1500,
  factor: 2,
  jitter: 0.3,
  maxDelayMs: 30_000,
  maxRetries: 5,
  timeoutMs: 120_000,
};

// ── OpenAI Client ───────────────────────────────────────────────

let _openai: ReturnType<typeof createOpenAI> | null = null;
function getOpenAI(): ReturnType<typeof createOpenAI> {
  if (!_openai) {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI API key not configured.");
    _openai = createOpenAI({
      apiKey,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }
  return _openai;
}

/** Reset cached OpenAI client (for testing). */
export function resetOpenAIClient(): void {
  _openai = null;
}

// ── Error Classification ────────────────────────────────────────

interface ClassifiedError {
  retryable: boolean;
  type: "rate_limit" | "server_error" | "timeout" | "auth_error" | "schema_error" | "unknown";
  retryAfterMs?: number;
}

function classifyError(err: any): ClassifiedError {
  const msg = err.message || String(err);

  // Abort / timeout
  if (err.name === "AbortError" || msg.includes("abort") || msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
    return { retryable: true, type: "timeout" };
  }

  // Auth errors — never retry
  if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("API key") || msg.includes("403")) {
    return { retryable: false, type: "auth_error" };
  }

  // Schema validation — never retry (unless caller wraps us)
  if (msg.includes("did not match schema") || msg.includes("No object generated") || msg.includes("parse")) {
    return { retryable: false, type: "schema_error" };
  }

  // Rate limit (429)
  if (msg.includes("429") || msg.includes("rate") || msg.includes("Rate limit") || msg.includes("quota")) {
    // Try to extract Retry-After from error metadata
    let retryAfterMs: number | undefined;
    const retryAfterHeader = err.headers?.["retry-after"] ?? err.responseHeaders?.["retry-after"];
    if (retryAfterHeader) {
      const seconds = parseFloat(retryAfterHeader);
      if (!isNaN(seconds)) {
        retryAfterMs = Math.ceil(seconds * 1000);
      }
    }
    // Also check x-ratelimit-reset-tokens and x-ratelimit-reset-requests
    if (!retryAfterMs) {
      const resetTokens = err.headers?.["x-ratelimit-reset-tokens"] ?? err.responseHeaders?.["x-ratelimit-reset-tokens"];
      if (resetTokens) {
        const match = String(resetTokens).match(/([\d.]+)s/);
        if (match) retryAfterMs = Math.ceil(parseFloat(match[1]) * 1000);
      }
    }
    return { retryable: true, type: "rate_limit", retryAfterMs };
  }

  // Server errors (5xx)
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("Server error") || msg.includes("ECONNRESET")) {
    return { retryable: true, type: "server_error" };
  }

  // Default: not retryable
  return { retryable: false, type: "unknown" };
}

// ── Delay Calculator ────────────────────────────────────────────

function computeDelay(attempt: number, config: Required<RetryConfig>, retryAfterMs?: number): number {
  // Honor Retry-After if provided
  if (retryAfterMs && retryAfterMs > 0) {
    // Add a small jitter even to Retry-After to prevent thundering herd
    const jitterRange = retryAfterMs * config.jitter;
    return Math.min(retryAfterMs + Math.random() * jitterRange, config.maxDelayMs);
  }

  // Exponential backoff with jitter
  const exponential = config.baseDelayMs * Math.pow(config.factor, attempt);
  const jitterRange = exponential * config.jitter;
  const jittered = exponential + (Math.random() * jitterRange * 2 - jitterRange);
  return Math.min(Math.max(jittered, config.baseDelayMs), config.maxDelayMs);
}

// ── Request ID Generator ────────────────────────────────────────

let _reqCounter = 0;
function nextRequestId(): string {
  return `llm-${Date.now()}-${++_reqCounter}`;
}

// ── Main Wrapper ────────────────────────────────────────────────

/**
 * Execute an LLM `generateObject` call with:
 *   - Concurrency limiting (via global limiter)
 *   - Robust retry with backoff/jitter
 *   - Retry-After header honoring
 *   - Structured telemetry logging
 *   - Timeout enforcement
 *
 * This is the single entry point for all LLM calls in the pipeline.
 */
export async function resilientGenerateObject<T extends z.ZodTypeAny>(
  opts: LLMCallOptions<T>,
): Promise<LLMCallResult<z.infer<T>>> {
  const lane = opts.lane ?? "heavy";

  // ── Provider resolution: prefer Claude when ANTHROPIC_API_KEY is set ──
  const resolved = resolveProvider(opts.providerConfig);
  const model = opts.model ?? resolved.model;

  const config: Required<RetryConfig> = {
    baseDelayMs: opts.retry?.baseDelayMs ?? DEFAULTS.baseDelayMs,
    factor: opts.retry?.factor ?? DEFAULTS.factor,
    jitter: opts.retry?.jitter ?? DEFAULTS.jitter,
    maxDelayMs: opts.retry?.maxDelayMs ?? DEFAULTS.maxDelayMs,
    maxRetries: opts.retry?.maxRetries ?? DEFAULTS.maxRetries,
    timeoutMs: opts.retry?.timeoutMs ?? DEFAULTS.timeoutMs,
  };

  const requestId = nextRequestId();
  const telemetry: AttemptTelemetry[] = [];
  const overallStart = Date.now();

  const limiter = getGlobalLimiter();

  // Acquire a slot in the concurrency lane
  return limiter.run(lane, async () => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const attemptStart = Date.now();

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);

        const generateOpts: any = {
          model: opts.model ? getOpenAI()(opts.model) : resolved.instance,
          schema: opts.schema,
          system: opts.system,
          prompt: opts.prompt,
          temperature: opts.temperature,
          abortSignal: controller.signal,
        };
        if (opts.maxTokens) {
          generateOpts.maxTokens = opts.maxTokens;
        }

        const result = await generateObject(generateOpts);
        clearTimeout(timer);

        // Extract actual token usage from API response (if available)
        const apiUsage: LLMUsage | undefined = result.usage
          ? {
              promptTokens: (result.usage as any).promptTokens ?? 0,
              completionTokens: (result.usage as any).completionTokens ?? 0,
              totalTokens: (result.usage as any).totalTokens ?? 0,
            }
          : undefined;

        telemetry.push({
          request_id: requestId,
          label: opts.label,
          attempt,
          max_retries: config.maxRetries,
          status: "success",
          duration_ms: Date.now() - attemptStart,
          model,
          prompt_chars: opts.prompt.length + opts.system.length,
          lane,
          timestamp: new Date().toISOString(),
        });

        opts.logger?.info(`[llm-retry] ${opts.label} succeeded on attempt ${attempt + 1} (${Date.now() - attemptStart}ms)${apiUsage ? ` [${apiUsage.promptTokens}+${apiUsage.completionTokens}=${apiUsage.totalTokens} tokens]` : ""}`);

        // Auto-record to global cost accumulator if one is set
        const costAcc = getGlobalCostAccumulator();
        if (costAcc) {
          const lastTelemetry = telemetry[telemetry.length - 1];
          costAcc.recordCall(lastTelemetry, apiUsage);
        }

        return {
          object: result.object,
          attempts: attempt + 1,
          total_duration_ms: Date.now() - overallStart,
          telemetry,
          usage: apiUsage,
        };
      } catch (err: any) {
        // timer is cleared on success path; on error path it will fire harmlessly
        const classified = classifyError(err);

        const entry: AttemptTelemetry = {
          request_id: requestId,
          label: opts.label,
          attempt,
          max_retries: config.maxRetries,
          status: classified.retryable && attempt < config.maxRetries ? "retry" : "fatal",
          error_type: classified.type,
          duration_ms: Date.now() - attemptStart,
          model,
          prompt_chars: opts.prompt.length + opts.system.length,
          lane,
          timestamp: new Date().toISOString(),
        };

        if (!classified.retryable) {
          entry.status = "fatal";
          telemetry.push(entry);

          // Record fatal attempt to cost accumulator (estimated tokens)
          const costAcc = getGlobalCostAccumulator();
          if (costAcc) {
            costAcc.recordCall(entry);
          }

          opts.logger?.error(`[llm-retry] ${opts.label} fatal error (${classified.type}) on attempt ${attempt + 1}: ${err.message?.substring(0, 200)}`);
          throw new LLMError(
            `[${opts.label}] ${classified.type}: ${err.message?.substring(0, 300)}`,
            classified.type,
            requestId,
            attempt + 1,
            telemetry,
          );
        }

        // Retryable error
        if (attempt < config.maxRetries) {
          const delayMs = computeDelay(attempt, config, classified.retryAfterMs);
          entry.delay_ms = delayMs;
          if (classified.retryAfterMs) entry.retry_after_ms = classified.retryAfterMs;
          telemetry.push(entry);

          // Record retry attempt to cost accumulator (estimated tokens)
          const costAcc = getGlobalCostAccumulator();
          if (costAcc) {
            costAcc.recordCall(entry);
          }

          opts.logger?.warn(`[llm-retry] ${opts.label} ${classified.type} on attempt ${attempt + 1}, retrying in ${Math.round(delayMs)}ms${classified.retryAfterMs ? ` (Retry-After: ${classified.retryAfterMs}ms)` : ""}`);

          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
        } else {
          entry.status = "fatal";
          telemetry.push(entry);

          // Record final exhausted attempt to cost accumulator
          const costAcc = getGlobalCostAccumulator();
          if (costAcc) {
            costAcc.recordCall(entry);
          }

          opts.logger?.error(`[llm-retry] ${opts.label} exhausted ${config.maxRetries + 1} attempts, last error: ${classified.type}`);
        }
      }
    }

    // All retries exhausted
    throw new LLMError(
      `[${opts.label}] Rate limit reached after ${config.maxRetries + 1} attempts. Try again, or run packets sequentially.`,
      "rate_limit",
      requestId,
      config.maxRetries + 1,
      telemetry,
    );
  });
}

// ── Error Class ─────────────────────────────────────────────────

export class LLMError extends Error {
  readonly errorType: string;
  readonly requestId: string;
  readonly attempts: number;
  readonly telemetry: AttemptTelemetry[];

  constructor(
    message: string,
    errorType: string,
    requestId: string,
    attempts: number,
    telemetry: AttemptTelemetry[],
  ) {
    super(message);
    this.name = "LLMError";
    this.errorType = errorType;
    this.requestId = requestId;
    this.attempts = attempts;
    this.telemetry = telemetry;
  }

  /** User-friendly summary for API responses. */
  toUserMessage(): string {
    if (this.errorType === "rate_limit") {
      return "Rate limit reached. Try again in a few minutes, or run packets sequentially.";
    }
    if (this.errorType === "timeout") {
      return "LLM call timed out. The prompt may be too large. Try reducing the job description length.";
    }
    if (this.errorType === "auth_error") {
      return "OpenAI API key is invalid or expired. Check your settings.";
    }
    return `LLM generation failed: ${this.message}`;
  }

  /** Internal debug payload for logging. */
  toDebugPayload(): Record<string, any> {
    return {
      request_id: this.requestId,
      error_type: this.errorType,
      attempts: this.attempts,
      telemetry: this.telemetry,
      backoff_schedule: this.telemetry
        .filter(t => t.delay_ms)
        .map(t => `${t.attempt}: ${t.delay_ms}ms`),
    };
  }
}
