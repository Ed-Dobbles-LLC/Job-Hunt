/**
 * Claims Ledger — The single source of truth for all verifiable facts.
 *
 * Extracts every factual claim from the experience inventory and assigns
 * each a unique claim ID. During resume generation, every bullet, metric,
 * scope line, and summary sentence must reference one or more claim IDs.
 * If a bullet cannot cite a claim, it is rejected.
 *
 * This replaces the loose "evidence pointer" approach with a hard gate:
 * no claim ID → no bullet.
 */

import { buildEntityAllowlist, type EntityAllowlist } from "./entityAllowlist";

// ── Claim Types ─────────────────────────────────────────────────
export type ClaimType =
  | "employer"
  | "title"
  | "date_range"
  | "location"
  | "metric"
  | "tool"
  | "platform"
  | "skill"
  | "bullet_text"
  | "team_size"
  | "budget"
  | "scope"
  | "certification"
  | "degree"
  | "institution";

export interface Claim {
  id: string;                   // e.g. "claim-exp001-b2-metric-12M"
  type: ClaimType;
  value: string;                // The exact text of the claim
  normalized: string;           // Lowercased, trimmed for matching
  source_id: string;            // Inventory bullet/section ID (e.g. "exp-001-b2")
  source_context: string;       // The full bullet/section text for context
  numeric_value?: number;       // Parsed number if applicable (e.g., 12000000 for "$12M")
  numeric_unit?: string;        // e.g., "$", "%", "people", "units"
}

export interface ClaimsLedger {
  claims: Claim[];
  employers: Claim[];
  titles: Claim[];
  metrics: Claim[];
  tools: Claim[];
  skills: Claim[];
  certifications: Claim[];
  education: Claim[];
  date_ranges: Claim[];
  locations: Claim[];

  // Lookup helpers
  byId: Map<string, Claim>;
  byType: Map<ClaimType, Claim[]>;

  // Stats
  total_claims: number;
  extraction_timestamp: string;

  // ── Candidate Identity Binding (required for generation pipelines) ──
  candidate_id?: string;
  candidate_name?: string;
  inventory_hash?: string;
}

// ── Helpers ─────────────────────────────────────────────────────
function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function makeClaimId(prefix: string, type: ClaimType, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40);
  return `claim-${prefix}-${type}-${slug}`;
}

function parseNumericValue(raw: string): { value: number; unit: string } | null {
  // $12M, $8M, $31M
  const dollarM = raw.match(/\$\s*([\d,.]+)\s*[Mm]/);
  if (dollarM) return { value: parseFloat(dollarM[1].replace(/,/g, "")) * 1_000_000, unit: "$M" };

  // $6.5M
  const dollarDecM = raw.match(/\$\s*([\d,.]+)\s*[Mm]/);
  if (dollarDecM) return { value: parseFloat(dollarDecM[1].replace(/,/g, "")) * 1_000_000, unit: "$M" };

  // $22M
  const dollarB = raw.match(/\$\s*([\d,.]+)\s*[Bb]/);
  if (dollarB) return { value: parseFloat(dollarB[1].replace(/,/g, "")) * 1_000_000_000, unit: "$B" };

  // $300K, $17M
  const dollarK = raw.match(/\$\s*([\d,.]+)\s*[Kk]/);
  if (dollarK) return { value: parseFloat(dollarK[1].replace(/,/g, "")) * 1_000, unit: "$K" };

  // Plain dollar
  const dollarPlain = raw.match(/\$\s*([\d,.]+)/);
  if (dollarPlain) return { value: parseFloat(dollarPlain[1].replace(/,/g, "")), unit: "$" };

  // 38%, 15%, 40%, 65%, 12%
  const pct = raw.match(/([\d,.]+)\s*%/);
  if (pct) return { value: parseFloat(pct[1]), unit: "%" };

  // 45-person, 28-person, 15 people, 60+ people
  const people = raw.match(/([\d,.]+)\+?\s*[-]?\s*(?:person|people|FTEs?|team|members|engineers|scientists|analysts)/i);
  if (people) return { value: parseFloat(people[1].replace(/,/g, "")), unit: "people" };

  // 2B+ events, 500+ users
  const bigNum = raw.match(/([\d,.]+)\s*[Bb]\+?\s/);
  if (bigNum) return { value: parseFloat(bigNum[1].replace(/,/g, "")) * 1_000_000_000, unit: "count" };

  // 3x, 5x
  const multiplier = raw.match(/(\d+)\s*[xX]/);
  if (multiplier) return { value: parseFloat(multiplier[1]), unit: "x" };

  // Plain numbers (200+, 4200, etc.)
  const plainNum = raw.match(/([\d,]+)\+?/);
  if (plainNum && plainNum[1].length >= 2) {
    return { value: parseFloat(plainNum[1].replace(/,/g, "")), unit: "count" };
  }

  return null;
}

// ── Main Extraction ─────────────────────────────────────────────
export function extractClaimsLedger(
  inventory: Record<string, any>,
  candidateIdentity?: { candidate_id: string; candidate_name: string; inventory_hash: string },
): ClaimsLedger {
  const claims: Claim[] = [];
  const byId = new Map<string, Claim>();
  const byType = new Map<ClaimType, Claim[]>();

  function addClaim(claim: Claim): void {
    // Deduplicate by id
    if (byId.has(claim.id)) return;
    claims.push(claim);
    byId.set(claim.id, claim);
    const existing = byType.get(claim.type) || [];
    existing.push(claim);
    byType.set(claim.type, existing);
  }

  // ── Profile Claims ──
  const profile = inventory.profile || {};
  if (profile.current_title) {
    addClaim({
      id: makeClaimId("profile", "title", profile.current_title),
      type: "title",
      value: profile.current_title,
      normalized: normalize(profile.current_title),
      source_id: "profile",
      source_context: `Current title: ${profile.current_title}`,
    });
  }
  if (profile.location) {
    addClaim({
      id: makeClaimId("profile", "location", profile.location),
      type: "location",
      value: profile.location,
      normalized: normalize(profile.location),
      source_id: "profile",
      source_context: `Location: ${profile.location}`,
    });
  }

  // ── Experience Claims ──
  for (const exp of inventory.experience || []) {
    const expId = exp.id || `exp-${claims.length}`;

    // Employer
    addClaim({
      id: makeClaimId(expId, "employer", exp.employer),
      type: "employer",
      value: exp.employer,
      normalized: normalize(exp.employer),
      source_id: expId,
      source_context: `Employer: ${exp.employer}`,
    });

    // Title
    addClaim({
      id: makeClaimId(expId, "title", exp.title),
      type: "title",
      value: exp.title,
      normalized: normalize(exp.title),
      source_id: expId,
      source_context: `Title at ${exp.employer}: ${exp.title}`,
    });

    // Date range
    addClaim({
      id: makeClaimId(expId, "date_range", `${exp.start_date}-${exp.end_date}`),
      type: "date_range",
      value: `${exp.start_date} to ${exp.end_date}`,
      normalized: normalize(`${exp.start_date} to ${exp.end_date}`),
      source_id: expId,
      source_context: `Dates at ${exp.employer}: ${exp.start_date} – ${exp.end_date}`,
    });

    // Location
    if (exp.location) {
      addClaim({
        id: makeClaimId(expId, "location", exp.location),
        type: "location",
        value: exp.location,
        normalized: normalize(exp.location),
        source_id: expId,
        source_context: `Location at ${exp.employer}: ${exp.location}`,
      });
    }

    // Bullet-level claims
    for (const bullet of exp.bullets || []) {
      const bulletId = bullet.id || `${expId}-b${(exp.bullets || []).indexOf(bullet)}`;

      // Full bullet text as a claim
      addClaim({
        id: makeClaimId(bulletId, "bullet_text", bullet.text.substring(0, 60)),
        type: "bullet_text",
        value: bullet.text,
        normalized: normalize(bullet.text),
        source_id: bulletId,
        source_context: bullet.text,
      });

      // Metrics from bullet
      for (const m of bullet.metrics || []) {
        const parsed = parseNumericValue(m);
        addClaim({
          id: makeClaimId(bulletId, "metric", m),
          type: "metric",
          value: m,
          normalized: normalize(m),
          source_id: bulletId,
          source_context: bullet.text,
          numeric_value: parsed?.value,
          numeric_unit: parsed?.unit,
        });
      }

      // Tools from bullet
      for (const t of bullet.tools || []) {
        addClaim({
          id: makeClaimId(bulletId, "tool", t),
          type: "tool",
          value: t,
          normalized: normalize(t),
          source_id: bulletId,
          source_context: bullet.text,
        });
      }
    }
  }

  // ── Education Claims ──
  for (const edu of inventory.education || []) {
    const eduId = edu.id || `edu-${claims.length}`;

    addClaim({
      id: makeClaimId(eduId, "institution", edu.institution),
      type: "institution",
      value: edu.institution,
      normalized: normalize(edu.institution),
      source_id: eduId,
      source_context: `${edu.degree} — ${edu.institution}`,
    });

    addClaim({
      id: makeClaimId(eduId, "degree", edu.degree),
      type: "degree",
      value: edu.degree,
      normalized: normalize(edu.degree),
      source_id: eduId,
      source_context: `${edu.degree} — ${edu.institution}`,
    });
  }

  // ── Certification Claims ──
  for (const cert of inventory.certifications || []) {
    const certName = typeof cert === "string" ? cert : cert.name;
    const certId = typeof cert === "string" ? `cert-${claims.length}` : cert.id || `cert-${claims.length}`;

    addClaim({
      id: makeClaimId(certId, "certification", certName),
      type: "certification",
      value: certName,
      normalized: normalize(certName),
      source_id: certId,
      source_context: `Certification: ${certName}`,
    });
  }

  // ── Skill Claims ──
  for (const [category, skillList] of Object.entries(inventory.skills || {})) {
    for (const skill of (skillList as string[]) || []) {
      addClaim({
        id: makeClaimId(`skill-${category}`, "skill", skill),
        type: "skill",
        value: skill,
        normalized: normalize(skill),
        source_id: `skill-${category}`,
        source_context: `Skill (${category}): ${skill}`,
      });
    }
  }

  // Build type-specific arrays
  const employers = byType.get("employer") || [];
  const titles = byType.get("title") || [];
  const metrics = byType.get("metric") || [];
  const tools = byType.get("tool") || [];
  const skills = byType.get("skill") || [];
  const certifications = byType.get("certification") || [];
  const education = [...(byType.get("institution") || []), ...(byType.get("degree") || [])];
  const date_ranges = byType.get("date_range") || [];
  const locations = byType.get("location") || [];

  return {
    claims,
    employers,
    titles,
    metrics,
    tools,
    skills,
    certifications,
    education,
    date_ranges,
    locations,
    byId,
    byType,
    total_claims: claims.length,
    extraction_timestamp: new Date().toISOString(),
    // Embed candidate identity for downstream verification
    candidate_id: candidateIdentity?.candidate_id,
    candidate_name: candidateIdentity?.candidate_name,
    inventory_hash: candidateIdentity?.inventory_hash,
  };
}

// ── Validation Functions ────────────────────────────────────────

/** Check if a numeric metric exists in the ledger */
export function validateMetric(text: string, ledger: ClaimsLedger): { valid: boolean; matched_claim?: Claim; reason?: string } {
  const norm = normalize(text);

  // Direct match
  for (const claim of ledger.metrics) {
    if (claim.normalized === norm) return { valid: true, matched_claim: claim };
    // Check if the metric value appears verbatim in claim
    if (claim.normalized.includes(norm) || norm.includes(claim.normalized)) {
      return { valid: true, matched_claim: claim };
    }
  }

  // Parse the incoming metric and try numeric matching
  const parsed = parseNumericValue(text);
  if (parsed) {
    for (const claim of ledger.metrics) {
      if (claim.numeric_value !== undefined && claim.numeric_unit) {
        // Same unit, same value (within 0.1% tolerance for floating point)
        if (
          claim.numeric_unit === parsed.unit &&
          Math.abs(claim.numeric_value - parsed.value) / Math.max(claim.numeric_value, 1) < 0.001
        ) {
          return { valid: true, matched_claim: claim };
        }
      }
    }
  }

  return { valid: false, reason: `Metric "${text}" not found in claims ledger` };
}

/** Check if a tool/platform exists in the ledger */
export function validateTool(tool: string, ledger: ClaimsLedger): { valid: boolean; matched_claim?: Claim } {
  const norm = normalize(tool);
  for (const claim of [...ledger.tools, ...ledger.skills]) {
    if (claim.normalized === norm) return { valid: true, matched_claim: claim };
  }
  return { valid: false };
}

/** Check if an employer exists in the ledger */
export function validateEmployer(employer: string, ledger: ClaimsLedger): { valid: boolean; matched_claim?: Claim } {
  const norm = normalize(employer);
  for (const claim of ledger.employers) {
    if (claim.normalized === norm) return { valid: true, matched_claim: claim };
  }
  return { valid: false };
}

/** Check if a title exists in the ledger */
export function validateTitle(title: string, ledger: ClaimsLedger): { valid: boolean; matched_claim?: Claim } {
  const norm = normalize(title);
  for (const claim of ledger.titles) {
    if (claim.normalized === norm) return { valid: true, matched_claim: claim };
  }
  return { valid: false };
}

/**
 * Extract all numeric metrics from a text string and validate each against the ledger.
 * Returns { all_valid, violations[] }
 */
export function validateAllMetricsInText(text: string, ledger: ClaimsLedger): {
  all_valid: boolean;
  metrics_found: string[];
  violations: { metric: string; reason: string }[];
} {
  // Extract all numbers from the text
  const metricRegex = /\$[\d,.]+[MBKmbk]?|\d+[\d,.]*%|\d{2,}[\d,.]*[+]?\s*(?:person|people|FTEs?|team|members|engineers|scientists|analysts|units|events|users|business\s+units?)/gi;
  const found: string[] = [...(text.match(metricRegex) || [])];

  // Also extract multipliers like "3x", "5x"
  const multiplierRegex = /\b(\d+)\s*[xX]\b/g;
  let match;
  while ((match = multiplierRegex.exec(text)) !== null) {
    found.push(match[0]);
  }

  const violations: { metric: string; reason: string }[] = [];
  for (const metric of found) {
    const result = validateMetric(metric, ledger);
    if (!result.valid) {
      violations.push({ metric, reason: result.reason || "Not in claims ledger" });
    }
  }

  return {
    all_valid: violations.length === 0,
    metrics_found: found,
    violations,
  };
}

/**
 * Validate a bullet has valid source claim IDs from the ledger.
 * Returns whether the bullet is permissible.
 */
export function validateBulletClaims(
  bulletText: string,
  sourceClaimIds: string[],
  ledger: ClaimsLedger,
): { valid: boolean; matched_claims: Claim[]; issues: string[] } {
  const issues: string[] = [];
  const matched: Claim[] = [];

  if (!sourceClaimIds || sourceClaimIds.length === 0) {
    issues.push("Bullet has no source_claim_ids — cannot verify provenance");
    return { valid: false, matched_claims: [], issues };
  }

  for (const claimId of sourceClaimIds) {
    const claim = ledger.byId.get(claimId);
    if (!claim) {
      // Try fuzzy matching on the source_id field (e.g., "exp-001-b2")
      const bySource = ledger.claims.filter((c) => c.source_id === claimId);
      if (bySource.length > 0) {
        matched.push(...bySource);
      } else {
        issues.push(`Claim ID "${claimId}" not found in ledger`);
      }
    } else {
      matched.push(claim);
    }
  }

  // Validate metrics in the bullet against the ledger
  const metricCheck = validateAllMetricsInText(bulletText, ledger);
  if (!metricCheck.all_valid) {
    for (const v of metricCheck.violations) {
      issues.push(`Unverified metric in bullet: ${v.metric} — ${v.reason}`);
    }
  }

  return {
    valid: issues.length === 0,
    matched_claims: matched,
    issues,
  };
}

/**
 * Generate a human-readable summary of the claims ledger for debugging.
 */
export function summarizeLedger(ledger: ClaimsLedger): string {
  const lines: string[] = [
    `Claims Ledger — ${ledger.total_claims} total claims (${ledger.extraction_timestamp})`,
    `  Employers: ${ledger.employers.length}`,
    `  Titles: ${ledger.titles.length}`,
    `  Metrics: ${ledger.metrics.length}`,
    `  Tools: ${ledger.tools.length}`,
    `  Skills: ${ledger.skills.length}`,
    `  Certifications: ${ledger.certifications.length}`,
    `  Education: ${ledger.education.length}`,
    `  Date Ranges: ${ledger.date_ranges.length}`,
    `  Locations: ${ledger.locations.length}`,
    "",
    "Metrics Inventory:",
  ];
  for (const m of ledger.metrics) {
    lines.push(`  [${m.id}] ${m.value} (from ${m.source_id})`);
  }
  lines.push("", "Tools Inventory:");
  for (const t of ledger.tools) {
    lines.push(`  [${t.id}] ${t.value}`);
  }
  return lines.join("\n");
}
