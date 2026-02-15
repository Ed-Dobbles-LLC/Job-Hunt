/**
 * LLM Concurrency Limiter
 *
 * A shared semaphore-based queue that prevents multi-packet generation
 * from overwhelming OpenAI rate limits. Each "lane" has its own
 * concurrency cap:
 *
 *   - "heavy"   (Stage 4 initial generation): max 1 concurrent (default)
 *   - "medium"  (Stages 6–8 polish/review):    max 2 concurrent
 *   - "light"   (JD extraction, contacts):      max 3 concurrent
 *
 * All limits are configurable at construction time and can be changed
 * at runtime via `setLimit()`.
 */

// ── Types ───────────────────────────────────────────────────────

export type LaneName = "heavy" | "medium" | "light";

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueued_at: number;
}

interface LaneState {
  limit: number;
  active: number;
  queue: QueueEntry[];
}

export interface LimiterConfig {
  heavy?: number;
  medium?: number;
  light?: number;
}

export interface LimiterSnapshot {
  heavy: { limit: number; active: number; queued: number };
  medium: { limit: number; active: number; queued: number };
  light: { limit: number; active: number; queued: number };
}

// ── Default Limits ──────────────────────────────────────────────

const DEFAULT_LIMITS: Record<LaneName, number> = {
  heavy: 1,
  medium: 2,
  light: 3,
};

// ── Limiter Class ───────────────────────────────────────────────

export class LLMConcurrencyLimiter {
  private lanes: Record<LaneName, LaneState>;

  constructor(config: LimiterConfig = {}) {
    this.lanes = {
      heavy: { limit: config.heavy ?? DEFAULT_LIMITS.heavy, active: 0, queue: [] },
      medium: { limit: config.medium ?? DEFAULT_LIMITS.medium, active: 0, queue: [] },
      light: { limit: config.light ?? DEFAULT_LIMITS.light, active: 0, queue: [] },
    };
  }

  /**
   * Acquire a slot in the given lane. Resolves when the caller may proceed.
   * If the lane is at capacity, the caller is queued (FIFO).
   */
  async acquire(lane: LaneName): Promise<void> {
    const state = this.lanes[lane];

    if (state.active < state.limit) {
      state.active++;
      return;
    }

    // Queue the caller
    return new Promise<void>((resolve, reject) => {
      state.queue.push({ resolve, reject, enqueued_at: Date.now() });
    });
  }

  /**
   * Release a slot in the given lane. Wakes the next queued caller if any.
   */
  release(lane: LaneName): void {
    const state = this.lanes[lane];

    if (state.queue.length > 0) {
      // Hand the slot directly to the next waiter (no decrement then increment)
      const next = state.queue.shift()!;
      next.resolve();
    } else {
      state.active = Math.max(0, state.active - 1);
    }
  }

  /**
   * Run a function while holding a slot in the given lane.
   * Automatically releases on completion or error.
   */
  async run<T>(lane: LaneName, fn: () => Promise<T>): Promise<T> {
    await this.acquire(lane);
    try {
      return await fn();
    } finally {
      this.release(lane);
    }
  }

  /** Change the concurrency limit for a lane at runtime. */
  setLimit(lane: LaneName, limit: number): void {
    this.lanes[lane].limit = Math.max(1, limit);
    // Drain queued entries if we now have capacity
    this.drainQueue(lane);
  }

  /** Get a snapshot of the limiter state. */
  snapshot(): LimiterSnapshot {
    return {
      heavy: { limit: this.lanes.heavy.limit, active: this.lanes.heavy.active, queued: this.lanes.heavy.queue.length },
      medium: { limit: this.lanes.medium.limit, active: this.lanes.medium.active, queued: this.lanes.medium.queue.length },
      light: { limit: this.lanes.light.limit, active: this.lanes.light.active, queued: this.lanes.light.queue.length },
    };
  }

  /** Reject all queued entries (for shutdown). */
  rejectAll(reason: string): void {
    for (const lane of Object.values(this.lanes)) {
      while (lane.queue.length > 0) {
        const entry = lane.queue.shift()!;
        entry.reject(new Error(reason));
      }
    }
  }

  private drainQueue(lane: LaneName): void {
    const state = this.lanes[lane];
    while (state.queue.length > 0 && state.active < state.limit) {
      const next = state.queue.shift()!;
      state.active++;
      next.resolve();
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────

let _globalLimiter: LLMConcurrencyLimiter | null = null;

/**
 * Get (or create) the global LLM concurrency limiter.
 * Call with config on first use to set limits; subsequent calls return
 * the same instance.
 */
export function getGlobalLimiter(config?: LimiterConfig): LLMConcurrencyLimiter {
  if (!_globalLimiter) {
    _globalLimiter = new LLMConcurrencyLimiter(config);
  }
  return _globalLimiter;
}

/** Reset the global limiter (for testing). */
export function resetGlobalLimiter(): void {
  if (_globalLimiter) {
    _globalLimiter.rejectAll("limiter reset");
  }
  _globalLimiter = null;
}
