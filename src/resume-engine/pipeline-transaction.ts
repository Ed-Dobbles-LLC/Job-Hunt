/**
 * Pipeline Transaction Safety
 *
 * Wraps multi-stage pipeline DB operations in a transaction boundary.
 * Ensures atomic commit of all artifacts on PASS, and rollback on failure.
 *
 * KEY DESIGN:
 *   - Uses a dedicated PostgreSQL client with BEGIN/COMMIT/ROLLBACK.
 *   - All DB writes during a pipeline run go through this client.
 *   - On PASS: COMMIT → artifacts, scores, evidence, cost data persisted.
 *   - On FAIL: ROLLBACK → no partial writes.
 *   - Connection is released back to pool on completion.
 *
 * This replaces the previous pattern of individual INSERT statements
 * that could leave partial state on mid-pipeline failures.
 */

// ── Types ────────────────────────────────────────────────────────

export interface TransactionClient {
  query: (sql: string, params?: any[]) => Promise<any>;
}

export interface PipelineTransaction {
  /** The dedicated client for all writes during this run */
  client: TransactionClient;
  /** Commit all writes */
  commit: () => Promise<void>;
  /** Rollback all writes */
  rollback: () => Promise<void>;
  /** Release the connection (always call in finally) */
  release: () => void;
  /** Whether a transaction is currently open */
  active: boolean;
}

// ── Transaction Wrapper ──────────────────────────────────────────

/**
 * Create a pipeline transaction.
 *
 * Usage:
 *   const txn = await beginPipelineTransaction();
 *   try {
 *     // ... run pipeline stages using txn.client for all DB writes ...
 *     await txn.commit();
 *   } catch (err) {
 *     await txn.rollback();
 *     throw err;
 *   } finally {
 *     txn.release();
 *   }
 */
export async function beginPipelineTransaction(): Promise<PipelineTransaction> {
  // Dynamic import to avoid circular dependency with db.ts
  const { pool } = await import("../mastra/tools/db");
  const client = await pool.connect();
  let active = true;

  await client.query("BEGIN");

  return {
    client: {
      query: (sql: string, params?: any[]) => client.query(sql, params),
    },
    commit: async () => {
      if (active) {
        await client.query("COMMIT");
        active = false;
      }
    },
    rollback: async () => {
      if (active) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Swallow rollback errors — connection may already be dead
        }
        active = false;
      }
    },
    release: () => {
      try {
        client.release();
      } catch {
        // Swallow release errors
      }
    },
    get active() { return active; },
  };
}

/**
 * Execute a function within a pipeline transaction.
 * Handles BEGIN, COMMIT, ROLLBACK, and release automatically.
 *
 * Usage:
 *   const result = await withPipelineTransaction(async (client) => {
 *     await client.query("INSERT INTO artifacts ...", [...]);
 *     // ... more writes ...
 *     return pipelineResult;
 *   });
 */
export async function withPipelineTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const txn = await beginPipelineTransaction();
  try {
    const result = await fn(txn.client);
    await txn.commit();
    return result;
  } catch (err) {
    await txn.rollback();
    throw err;
  } finally {
    txn.release();
  }
}

/**
 * Create a no-op transaction for cases where DB is unavailable.
 * All writes silently succeed (no persistence).
 */
export function createNoOpTransaction(): PipelineTransaction {
  return {
    client: {
      query: async () => ({ rows: [], rowCount: 0 }),
    },
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    active: false,
  };
}
