/**
 * Token Budget Manager
 *
 * Estimates token usage for LLM calls and decides whether Stage 4
 * should run as a single call or be split into two sequential calls:
 *   (a) summary + competencies
 *   (b) experience bullets
 *
 * This reduces TPM (tokens per minute) spikes during concurrent
 * packet generation.
 *
 * Token estimation uses a simple character-based heuristic
 * (1 token ≈ 4 characters for English text).
 */

// ── Types ───────────────────────────────────────────────────────

export interface TokenBudgetConfig {
  /** Max tokens per Stage 4 call (default: 8000) */
  maxTokensPerCall?: number;
  /** Characters per token estimate (default: 4) */
  charsPerToken?: number;
  /** If true, always split Stage 4 regardless of estimate (default: false) */
  forceSplit?: boolean;
}

export interface TokenEstimate {
  system_tokens: number;
  user_tokens: number;
  estimated_output_tokens: number;
  total_estimated: number;
  exceeds_budget: boolean;
  recommend_split: boolean;
}

// ── Defaults ────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS_PER_CALL = 8000;
const DEFAULT_CHARS_PER_TOKEN = 4;
const ESTIMATED_RESUME_OUTPUT_TOKENS = 1500;
const ESTIMATED_COVER_LETTER_OUTPUT_TOKENS = 600;

// ── Estimator ───────────────────────────────────────────────────

/**
 * Estimate the token usage for a Stage 4 call and decide whether
 * it should be split.
 */
export function estimateStage4Tokens(
  systemPrompt: string,
  userPrompt: string,
  config: TokenBudgetConfig = {},
): TokenEstimate {
  const cpt = config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const maxTokens = config.maxTokensPerCall ?? DEFAULT_MAX_TOKENS_PER_CALL;

  const systemTokens = Math.ceil(systemPrompt.length / cpt);
  const userTokens = Math.ceil(userPrompt.length / cpt);
  const outputTokens = ESTIMATED_RESUME_OUTPUT_TOKENS;
  const total = systemTokens + userTokens + outputTokens;

  const exceeds = total > maxTokens;
  const split = config.forceSplit || exceeds;

  return {
    system_tokens: systemTokens,
    user_tokens: userTokens,
    estimated_output_tokens: outputTokens,
    total_estimated: total,
    exceeds_budget: exceeds,
    recommend_split: split,
  };
}

/**
 * Compute a max_tokens ceiling for a generateObject call.
 *
 * This is NOT the same as context window — it caps the OUTPUT tokens
 * to prevent runaway generation that wastes TPM budget.
 */
export function computeMaxOutputTokens(
  callType: "resume" | "cover_letter" | "review",
  config: TokenBudgetConfig = {},
): number {
  switch (callType) {
    case "resume":
      return ESTIMATED_RESUME_OUTPUT_TOKENS;
    case "cover_letter":
      return ESTIMATED_COVER_LETTER_OUTPUT_TOKENS;
    case "review":
      return 1200;
    default:
      return 1500;
  }
}

// ── TODO: Stage 4 Prompt Splitting ──────────────────────────────
//
// Follow-up: Revisit Stage 4 prompt splitting and max_tokens tuning.
// When `recommend_split` is true, the pipeline should:
//   1. Generate summary + competencies in one call
//   2. Generate experience bullets in a second call
//   3. Assemble deterministically
//
// This is deferred to a follow-up task to avoid changing content
// prompts in this reliability-focused PR.
//
// See: https://github.com/Ed-Dobbles-LLC/Job-Hunt/issues/TBD
