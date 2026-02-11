import { PostgresStore } from "@mastra/pg";

const connString =
  process.env.DATABASE_URL || "postgresql://localhost:5432/mastra";

// Wrap PostgresStore to handle connection failures gracefully
// Railway containers may start before the Postgres service is fully reachable
class ResilientPostgresStore extends PostgresStore {
  private initAttempts = 0;
  private readonly maxRetries = 8;
  private readonly retryDelayMs = 5000;

  async init(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        this.initAttempts = attempt;
        await super.init();
        if (attempt > 1) {
          console.log(`[storage] Connected to Postgres on attempt ${attempt}`);
        }
        return;
      } catch (err: any) {
        const errCode = err?.cause?.cause?.code || err?.cause?.code || "";
        const errMsg = err?.message || "";
        const isConnectionError =
          errCode === "ECONNREFUSED" ||
          errCode === "ETIMEDOUT" ||
          errMsg.includes("ECONNREFUSED") ||
          errMsg.includes("ETIMEDOUT");

        if (isConnectionError && attempt < this.maxRetries) {
          console.warn(
            `[storage] Postgres connection attempt ${attempt}/${this.maxRetries} failed, retrying in ${this.retryDelayMs}ms...`
          );
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
        } else {
          throw err;
        }
      }
    }
  }
}

export const sharedPostgresStorage = new ResilientPostgresStore({
  connectionString: connString,
});
