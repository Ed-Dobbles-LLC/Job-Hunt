/**
 * Centralized Inventory Loader — Single source of truth for loading the experience inventory.
 *
 * REPLACES the 11+ duplicate loadInventory() functions scattered across:
 *   pipeline-v1.ts, pipeline-v2.ts, dashboardRoutes.ts, generateResumeTool.ts,
 *   generateCoverLetterTool.ts, matchScorerTool.ts, scoreJobsTool.ts,
 *   buildOutputTool.ts, linkedInMessageTool.ts, generateVerifiedPacketTool.ts,
 *   verifyTruthfulnessTool.ts
 *
 * INVARIANTS:
 *   1. If inventory cannot be loaded, throw MissingBaselineError (never return a stub).
 *   2. Every load returns inventory + CandidateIdentity (always validated).
 *   3. Test fixtures are ONLY used when USE_FIXTURES=true AND NODE_ENV !== "production".
 *   4. Logs every load with candidate name and source for audit trail.
 */

import * as fs from "fs";
import { query } from "../mastra/tools/db";
import { workspacePath } from "../mastra/tools/paths";
import {
  MissingBaselineError,
  resolveCandidateIdentity,
  type CandidateIdentity,
} from "./candidate-identity";

// ── Types ─────────────────────────────────────────────────────────

export interface LoadedInventory {
  inventory: Record<string, any>;
  identity: CandidateIdentity;
}

// ── Core Loader ─────────────────────────────────────────────────

/**
 * Load the experience inventory with candidate identity binding.
 *
 * Resolution order:
 *   1. DB (app_settings table, key = 'experience_inventory')
 *   2. Filesystem (WORKSPACE_ROOT/experience_inventory.json)
 *
 * If BOTH fail: throws MissingBaselineError. Never returns a stub/default.
 *
 * @param runId — Optional pipeline run ID for traceability
 * @param logger — Optional logger for audit trail
 */
export async function loadInventoryWithIdentity(
  runId?: string,
  logger?: any,
): Promise<LoadedInventory> {
  const attemptedPaths: string[] = [];

  // Attempt 1: Database
  try {
    const dbResult = await query(
      "SELECT value FROM app_settings WHERE key = 'experience_inventory'",
    );
    if (dbResult.rows.length > 0 && dbResult.rows[0].value) {
      const inventory = JSON.parse(dbResult.rows[0].value);
      validateInventoryStructure(inventory, "db:app_settings");
      const identity = resolveCandidateIdentity(inventory, "db", undefined, runId);
      logger?.info(
        `[InventoryLoader] Loaded inventory from DB for candidate="${identity.candidate_name}" (hash=${identity.inventory_hash.substring(0, 12)}…)`,
      );
      return { inventory, identity };
    }
    attemptedPaths.push("db:app_settings (empty)");
  } catch (err: any) {
    // If it's already a MissingBaselineError from validation, re-throw
    if (err instanceof MissingBaselineError) throw err;
    attemptedPaths.push(`db:app_settings (error: ${err.message})`);
  }

  // Attempt 2: Filesystem
  const inventoryPath = workspacePath("experience_inventory.json");
  try {
    const raw = fs.readFileSync(inventoryPath, "utf-8");
    const inventory = JSON.parse(raw);
    validateInventoryStructure(inventory, inventoryPath);
    const identity = resolveCandidateIdentity(inventory, "filesystem", inventoryPath, runId);
    logger?.info(
      `[InventoryLoader] Loaded inventory from filesystem for candidate="${identity.candidate_name}" (hash=${identity.inventory_hash.substring(0, 12)}…, path=${inventoryPath})`,
    );
    return { inventory, identity };
  } catch (err: any) {
    if (err instanceof MissingBaselineError) throw err;
    attemptedPaths.push(`filesystem:${inventoryPath} (error: ${err.message})`);
  }

  // Both failed — HARD FAIL, no fallback
  throw new MissingBaselineError(
    "unknown",
    attemptedPaths,
    "Cannot load experience inventory from DB or filesystem. Upload a resume via Profile Builder first.",
  );
}

/**
 * Load inventory without identity binding — FOR LEGACY/NON-CRITICAL PATHS ONLY.
 *
 * Still throws MissingBaselineError on failure (no silent stubs), but does not
 * require the caller to handle CandidateIdentity. This is a bridge function
 * for paths like scoring, download filenames, etc. that don't generate resumes.
 *
 * All resume/cover-letter generation paths MUST use loadInventoryWithIdentity().
 */
export async function loadInventoryStrict(logger?: any): Promise<Record<string, any>> {
  const { inventory } = await loadInventoryWithIdentity(undefined, logger);
  return inventory;
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Validate that the inventory has the minimum required structure.
 * Throws MissingBaselineError if critical fields are missing.
 */
function validateInventoryStructure(
  inventory: Record<string, any>,
  source: string,
): void {
  if (!inventory || typeof inventory !== "object") {
    throw new MissingBaselineError("unknown", [source], "Inventory is null or not an object");
  }
  if (!inventory.profile) {
    throw new MissingBaselineError("unknown", [source], "Inventory has no 'profile' section");
  }
  if (!inventory.profile.name || typeof inventory.profile.name !== "string") {
    throw new MissingBaselineError(
      "unknown",
      [source],
      "Inventory profile has no 'name' field — cannot identify candidate",
    );
  }
  if (!Array.isArray(inventory.experience) || inventory.experience.length === 0) {
    throw new MissingBaselineError(
      inventory.profile.name || "unknown",
      [source],
      "Inventory has no 'experience' entries — cannot generate resume",
    );
  }
}
