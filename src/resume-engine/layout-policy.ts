/**
 * Layout Policy — single source of truth for resume page-fill rules.
 *
 * History: FOUR independent copies of bullet-cap policy existed (layout
 * governor, resumeCompressor.getBulletCaps, resumeCompressor Phase 7
 * MAX_TOTAL_BULLETS=15, finalPolishLayer) and they fought each other.
 * The compressor's 15-bullet total cap silently stripped every resume
 * back to 15 bullets — starving page 2 to half-full regardless of what
 * the LLM or the backfill produced. All layers now import from here.
 *
 * Target: a FULL 2-page executive resume (~20-24 bullets across 5-6
 * roles). Page-2 anchor (H&R Block by default) is handled in the
 * renderer via RESUME_PAGE2_ANCHOR.
 */

export const PAGE_BAND_MIN_POLICY = 1.85; // below this = too thin, expansion signals fire
export const PAGE_BAND_MAX_POLICY = 2.0;  // above this = compression required

/** Total bullets across all roles. A full 2 pages needs ~22. */
export const TOTAL_BULLET_CAP = 24;

/**
 * Per-role bullet cap.
 * @param roleIndex 0 = most recent
 * @param yearsOld  years since the role's start (or end) — pass the larger
 *                  signal available; 15+ years still gets 3 so page 2 fills.
 */
export function bulletCapForRole(roleIndex: number, yearsOld: number): number {
  if (yearsOld > 15) return 3; // old roles: 3 (the old cap of 2 starved page 2)
  if (roleIndex === 0) return 5; // most recent — executive depth
  if (roleIndex <= 2) return 4;
  return 4;
}
