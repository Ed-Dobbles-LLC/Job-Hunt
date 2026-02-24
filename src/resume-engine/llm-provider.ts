/**
 * LLM Provider Abstraction
 *
 * Centralizes model selection so the pipeline can switch between
 * OpenAI (GPT-4o) and Anthropic (Claude) via configuration.
 *
 * Default: Claude claude-sonnet-4-20250514 for generation stages (Stage 4, Stage 8).
 * Fallback: GPT-4o if ANTHROPIC_API_KEY is not set.
 *
 * The pipeline's resilientGenerateObject still handles retries,
 * concurrency limiting, and cost tracking — this module only
 * resolves which provider + model to use.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

// ── Types ───────────────────────────────────────────────────────

export type ProviderName = "anthropic" | "openai";

export interface LLMProviderConfig {
  /** Which provider to use. Default: auto-detect based on available API keys. */
  provider?: ProviderName;
  /** Model ID override. If not set, uses the default for the provider. */
  model?: string;
  /** Force a specific provider even if the preferred one is available. */
  force?: boolean;
}

export interface ResolvedProvider {
  provider: ProviderName;
  model: string;
  /** The AI SDK model instance ready for generateObject() */
  instance: any;
}

// ── Default Models ──────────────────────────────────────────────

const DEFAULTS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
};

// ── Cached Clients ──────────────────────────────────────────────

let _anthropic: ReturnType<typeof createAnthropic> | null = null;
let _openai: ReturnType<typeof createOpenAI> | null = null;

function getAnthropicClient(): ReturnType<typeof createAnthropic> {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured.");
    _anthropic = createAnthropic({ apiKey });
  }
  return _anthropic;
}

function getOpenAIClient(): ReturnType<typeof createOpenAI> {
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

// ── Provider Resolution ─────────────────────────────────────────

/**
 * Resolve which LLM provider and model to use.
 *
 * Priority:
 * 1. Explicit config.provider + config.model
 * 2. ANTHROPIC_API_KEY present → Claude
 * 3. OPENAI_API_KEY present → GPT-4o
 * 4. Error if neither is available
 */
export function resolveProvider(config?: LLMProviderConfig): ResolvedProvider {
  const preferredProvider = config?.provider || detectPreferredProvider();
  const model = config?.model || DEFAULTS[preferredProvider];

  if (preferredProvider === "anthropic") {
    return {
      provider: "anthropic",
      model,
      instance: getAnthropicClient()(model),
    };
  }

  return {
    provider: "openai",
    model,
    instance: getOpenAIClient()(model),
  };
}

/**
 * Auto-detect the preferred provider based on available API keys.
 * Prefers Anthropic (Claude) when both are available.
 */
function detectPreferredProvider(): ProviderName {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY) return "openai";
  throw new Error("No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
}

/**
 * Get the default model ID for the current environment.
 * Used by callers that need the model string without a full resolution.
 */
export function getDefaultModel(): string {
  const provider = detectPreferredProvider();
  return DEFAULTS[provider];
}

/**
 * Check if Anthropic (Claude) is available in the current environment.
 */
export function isClaudeAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Reset cached clients (for testing). */
export function resetProviderClients(): void {
  _anthropic = null;
  _openai = null;
}
