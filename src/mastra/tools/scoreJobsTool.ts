import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "./db";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";
import {
  SPEC_INFLATION_CONFIG,
  AI_STRATEGY_TERMS,
  AI_ENGINEERING_TERMS,
  SCORING_PROFILES,
  getActiveMode,
  getActiveProfile,
  getMaxPositiveScore,
  type ScoringWeights,
  type ScoringProfile,
} from "./scoringConfig";
import { evaluateRules } from "./hardFlagEngine";
import type { GateStatus } from "./hardFlagRules";
import { classifyRoleShape, type RoleShapeResult } from "./roleShapeClassifier";

function loadInventory(): any {
  const inventoryPath = workspacePath("experience_inventory.json");
  try {
    return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  } catch {
    // Return minimal inventory so scoring can still run with keyword matching
    return { profile: {}, domains: [], skills: [], experience: [] };
  }
}

const EXECUTION_MODE_NEGATIVE_SIGNALS = [
  "agentic",
  "autonomous agents",
  "ai-driven ci/cd",
  "pipelines",
  "mlops",
  "deployment",
  "monitoring",
  "infra",
  "architect",
  "software engineering",
  "platform",
  "latency",
  "slas",
  "kubernetes",
  "devops",
];

const EXECUTION_MODE_POSITIVE_SIGNALS = [
  "roadmap",
  "strategy",
  "business value",
  "operating model",
  "adoption",
  "portfolio",
  "executive stakeholders",
  "board",
  "roi",
  "transformation",
];

export function classifyExecutionMode(jd: string): {
  score: number;
  reason: string;
} {
  const text = jd.toLowerCase();

  const posHits = EXECUTION_MODE_POSITIVE_SIGNALS.filter((s) =>
    text.includes(s),
  );
  const negHits = EXECUTION_MODE_NEGATIVE_SIGNALS.filter((s) =>
    text.includes(s),
  );

  const posCount = posHits.length;
  const negCount = negHits.length;

  let score: number;
  const reasons: string[] = [];

  if (negCount >= 6) {
    score = -20;
    reasons.push(
      `Heavy engineering/platform depth expected (${negCount} infra signals: ${negHits.slice(0, 4).join(", ")}...)`,
    );
  } else if (negCount >= 3 && posCount <= 1) {
    score = -10;
    reasons.push(
      `Engineering-heavy AI ownership (${negCount} infra signals: ${negHits.join(", ")})`,
    );
  } else if (posCount >= 4 && negCount <= 1) {
    score = 10;
    reasons.push(
      `Strategy-led role (${posCount} strategy signals: ${posHits.slice(0, 4).join(", ")})`,
    );
  } else if (posCount >= 2 && negCount <= 1) {
    score = 5;
    reasons.push(
      `Mostly strategy-led (${posCount} strategy signals, ${negCount} infra signals)`,
    );
  } else if (negCount >= 3 && posCount >= 2) {
    score = -5;
    reasons.push(
      `Mixed but leans engineering (${posCount} strategy vs ${negCount} infra signals)`,
    );
  } else {
    score = 0;
    reasons.push(
      `Mixed strategy + execution (${posCount} strategy, ${negCount} infra signals)`,
    );
  }

  if (posHits.length > 0) {
    reasons.push(`Strategy: ${posHits.join(", ")}`);
  }
  if (negHits.length > 0) {
    reasons.push(`Infra: ${negHits.join(", ")}`);
  }

  return { score, reason: reasons.join(". ") };
}

export function computeSpecInflationPenalty(jd: string): {
  score: number;
  reason: string;
  advancedCount: number;
  businessCount: number;
} {
  const text = jd.toLowerCase();
  const cfg = SPEC_INFLATION_CONFIG;

  const advHits = cfg.advancedAITerms.filter((t) => text.includes(t));
  const bizHits = cfg.businessOutcomeTerms.filter((t) => text.includes(t));
  const advCount = advHits.length;
  const bizCount = bizHits.length;

  const th = cfg.thresholds;
  const advLevel =
    advCount >= th.advancedDensity.high
      ? "high"
      : advCount >= th.advancedDensity.med
        ? "med"
        : advCount >= th.advancedDensity.low
          ? "low"
          : "none";
  const bizLevel =
    bizCount >= th.businessDensity.high
      ? "high"
      : bizCount >= th.businessDensity.med
        ? "med"
        : bizCount >= th.businessDensity.low
          ? "low"
          : "none";

  let penalty = 0;

  if (advLevel === "high" && (bizLevel === "none" || bizLevel === "low")) {
    penalty = cfg.penalties.highAdvLowBiz;
  } else if (advLevel === "high" && bizLevel === "med") {
    penalty = cfg.penalties.highAdvMedBiz;
  } else if (advLevel === "med" && (bizLevel === "none" || bizLevel === "low")) {
    penalty = cfg.penalties.medAdvLowBiz;
  } else if (advLevel === "med" && bizLevel === "med") {
    penalty = cfg.penalties.medAdvMedBiz;
  }

  penalty = Math.max(penalty, cfg.maxPenalty);

  const reasons: string[] = [];
  if (penalty < 0) {
    reasons.push(
      `Spec inflation detected: ${advCount} advanced AI terms (${advLevel}) vs ${bizCount} business outcomes (${bizLevel}), penalty ${penalty}`,
    );
    if (advHits.length > 0) reasons.push(`AI terms: ${advHits.join(", ")}`);
    if (bizHits.length > 0) reasons.push(`Biz terms: ${bizHits.join(", ")}`);
  } else {
    reasons.push(
      `No spec inflation (${advCount} advanced, ${bizCount} business)`,
    );
  }

  return {
    score: penalty,
    reason: reasons.join(". "),
    advancedCount: advCount,
    businessCount: bizCount,
  };
}

export function scoreAIStrategyStack(jd: string, maxPoints: number): { score: number; hits: string[] } {
  const text = jd.toLowerCase();
  const hits = AI_STRATEGY_TERMS.filter((t) => text.includes(t));
  const raw = Math.min(maxPoints, Math.round((hits.length / 4) * maxPoints));
  return { score: raw, hits };
}

export function scoreAIEngineeringStack(jd: string, maxPoints: number): { score: number; hits: string[] } {
  const text = jd.toLowerCase();
  const hits = AI_ENGINEERING_TERMS.filter((t) => text.includes(t));
  const raw = Math.min(maxPoints, Math.round((hits.length / 4) * maxPoints));
  return { score: raw, hits };
}

export interface CategoryDetail {
  score: number;
  maxPoints: number;
  matchedPhrases: string[];
  reason?: string;
}

export interface HardFlagResult {
  ruleId: string;
  ruleName: string;
  message: string;
}

export interface ScoreReport {
  total: number;
  mode: string;
  rawTotal: number;
  maxPossible: number;
  categories: Record<string, CategoryDetail>;
  penalties: { key: string; score: number; reason: string }[];
  riskFlags: string[];
  hardFlags: HardFlagResult[];
  gateStatus: GateStatus;
  hardFlagAdjustment: number;
  roleShape: RoleShapeResult;
}

const DISPLAY_ORDER = [
  "role_level_match",
  "leadership_scope",
  "domain_relevance",
  "ai_strategy_stack",
  "ai_engineering_stack",
  "dominance_adjustment",
  "location_fit",
  "compensation",
  "transformation_mandate",
  "company_preference",
  "execution_mode_match",
  "spec_inflation_penalty",
] as const;

function cap(arr: string[], n: number): string[] {
  return arr.sort().slice(0, n);
}

export function scoreSingleJob(
  job: any,
  inventory: any,
  profile?: ScoringProfile,
  locationPrefs?: { metros: string[]; prefRemote: string; prefHybrid: string; prefOnsite: string; countries: string[] },
): { total: number; breakdown: Record<string, any>; mode: string; report: ScoreReport } {
  const p = profile || getActiveProfile();
  const w = p.weights;
  const mode = profile
    ? Object.entries(SCORING_PROFILES).find(([, p]) => p === profile)?.[0] as string || "custom"
    : getActiveMode();

  const jd = (job.jd_raw_text || "").toLowerCase();
  const title = (job.title || "").toLowerCase();
  const location = (job.location || "").toLowerCase();
  const remoteHybrid = (job.remote_hybrid || "").toLowerCase();

  const breakdown: Record<string, any> = {};
  const categories: Record<string, CategoryDetail> = {};
  const penalties: ScoreReport["penalties"] = [];
  const riskFlags: string[] = [];

  const vpKeywords = ["vp", "vice president", "head of", "chief", "cdo", "svp"];
  const dirKeywords = ["director", "senior director"];
  const managerKeywords = ["manager", "lead"];
  const isVpPlus = vpKeywords.some((kw) => title.includes(kw));
  const roleLevelHits = vpKeywords.filter((kw) => title.includes(kw));
  const dirHits = dirKeywords.filter((kw) => title.includes(kw));
  const mgrHits = managerKeywords.filter((kw) => title.includes(kw));
  if (isVpPlus) {
    breakdown.role_level_match = w.role_level_match;
  } else if (dirHits.length > 0) {
    breakdown.role_level_match = Math.round(w.role_level_match * 0.8);
  } else if (mgrHits.length > 0) {
    breakdown.role_level_match = Math.round(w.role_level_match * 0.4);
  } else {
    breakdown.role_level_match = Math.round(w.role_level_match * 0.2);
  }
  categories.role_level_match = {
    score: breakdown.role_level_match,
    maxPoints: w.role_level_match,
    matchedPhrases: cap([...roleLevelHits, ...dirHits, ...mgrHits], 5),
  };

  const leadershipSignals = [
    "lead a team",
    "build a team",
    "manage",
    "direct reports",
    "team of",
    "organization",
    "department",
    "p&l",
    "budget",
    "executive",
    "c-suite",
    "board",
  ];
  const leadershipHits = leadershipSignals.filter((s) => jd.includes(s));
  breakdown.leadership_scope = Math.min(w.leadership_scope, Math.round((leadershipHits.length / 4) * w.leadership_scope));
  categories.leadership_scope = {
    score: breakdown.leadership_scope,
    maxPoints: w.leadership_scope,
    matchedPhrases: cap(leadershipHits, 5),
  };

  const domains = inventory.skills?.domains || [];
  const domainHits = domains.filter((d: string) => jd.includes(d.toLowerCase()));
  breakdown.domain_relevance = Math.min(w.domain_relevance, Math.round((domainHits.length / 2) * w.domain_relevance));
  categories.domain_relevance = {
    score: breakdown.domain_relevance,
    maxPoints: w.domain_relevance,
    matchedPhrases: cap(domainHits.map((d: string) => d.toLowerCase()), 5),
  };

  const stratStack = scoreAIStrategyStack(jd, w.ai_strategy_stack);
  breakdown.ai_strategy_stack = stratStack.score;
  categories.ai_strategy_stack = {
    score: stratStack.score,
    maxPoints: w.ai_strategy_stack,
    matchedPhrases: cap(stratStack.hits, 5),
  };

  const engStack = scoreAIEngineeringStack(jd, w.ai_engineering_stack);
  breakdown.ai_engineering_stack = engStack.score;
  categories.ai_engineering_stack = {
    score: engStack.score,
    maxPoints: w.ai_engineering_stack,
    matchedPhrases: cap(engStack.hits, 5),
  };

  let dominanceAdj = 0;
  if (engStack.score > stratStack.score && isVpPlus && p.dominanceAdjustment !== 0) {
    dominanceAdj = p.dominanceAdjustment;
  }
  breakdown.dominance_adjustment = dominanceAdj;
  if (dominanceAdj !== 0) {
    penalties.push({ key: "dominance_adjustment", score: dominanceAdj, reason: "Engineering stack exceeds strategy stack for VP+ role" });
    riskFlags.push("Engineering-heavy AI execution expected for a strategy-level title");
  }
  categories.dominance_adjustment = {
    score: dominanceAdj,
    maxPoints: 0,
    matchedPhrases: [],
    reason: dominanceAdj !== 0 ? "eng_stack > strat_stack for VP+" : "n/a",
  };

  // Location preferences from DB (passed via locationPrefs param) or fallback
  const prefMetros: string[] = (locationPrefs?.metros || ["chicago"]).map((m: string) => m.toLowerCase().trim());
  const prefRemote: string = (locationPrefs?.prefRemote || "will-do").toLowerCase().trim();
  const prefHybrid: string = (locationPrefs?.prefHybrid || "will-do").toLowerCase().trim();
  const prefOnsite: string = (locationPrefs?.prefOnsite || "will-do").toLowerCase().trim();

  // Detect work arrangement from JD text and remote_hybrid field
  const allText = `${jd} ${remoteHybrid} ${location}`;
  const isRemote = /\bremote\b/.test(allText) && !/\bnot?\s*remote\b/.test(allText) && !/\bno\s*remote\b/.test(allText);
  const isHybrid = /\bhybrid\b/.test(allText);
  const isOnsite = /\bon[\s-]?site\b/.test(allText) || /\bin[\s-]?office\b/.test(allText) || /\bin[\s-]?person\b/.test(allText);

  // Detect days in office from JD
  const daysMatch = jd.match(/(\d)\s*(?:days?)\s*(?:per\s*week|\/\s*week|a\s*week|in[\s-]?office|on[\s-]?site)/i)
    || jd.match(/(?:in[\s-]?office|on[\s-]?site)\s*(\d)\s*(?:days?)/i);
  const daysInOffice = daysMatch ? parseInt(daysMatch[1]) : null;

  // Build work arrangement string
  let workArrangement = "Unknown";
  if (isRemote && !isHybrid) workArrangement = "Remote";
  else if (isHybrid) workArrangement = daysInOffice ? `Hybrid (${daysInOffice} days in office)` : "Hybrid";
  else if (isOnsite) workArrangement = daysInOffice ? `On-site (${daysInOffice} days/week)` : "On-site";
  else if (remoteHybrid) workArrangement = remoteHybrid;

  // Determine if the work arrangement matches user preferences
  const arrangementAcceptable =
    (isRemote && prefRemote !== "no") ||
    (isHybrid && prefHybrid !== "no") ||
    (isOnsite && prefOnsite !== "no") ||
    (!isRemote && !isHybrid && !isOnsite); // unknown = don't penalize

  const arrangementPreferred =
    (isRemote && prefRemote === "prefer") ||
    (isHybrid && prefHybrid === "prefer") ||
    (isOnsite && prefOnsite === "prefer");

  // Metro matching
  const metroHits = prefMetros.filter(
    (metro) => location.includes(metro) || jd.includes(metro),
  );
  const locationMatchesMetro = metroHits.length > 0;
  const locationMatch = (locationMatchesMetro || isRemote) && arrangementAcceptable;

  // Score: full if preferred + metro, scaled down otherwise
  if (arrangementPreferred && (locationMatchesMetro || isRemote)) {
    breakdown.location_fit = w.location_fit;
  } else if (locationMatch) {
    breakdown.location_fit = Math.round(w.location_fit * 0.75);
  } else if (arrangementAcceptable) {
    breakdown.location_fit = Math.round(w.location_fit * 0.375);
  } else {
    breakdown.location_fit = 0;
  }

  breakdown._work_arrangement = workArrangement;
  breakdown._days_in_office = daysInOffice;
  breakdown._is_remote = isRemote;
  breakdown._is_hybrid = isHybrid;
  breakdown._is_onsite = isOnsite;
  breakdown._location_metro_hits = metroHits;
  breakdown._arrangement_acceptable = arrangementAcceptable;

  // Country filter
  const acceptedCountries: string[] = (locationPrefs?.countries || []).map((c: string) => c.toLowerCase().trim());
  let detectedCountry = "";

  if (acceptedCountries.length > 0) {
    // US state abbreviations for detection
    const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];
    const COUNTRY_INDICATORS: Record<string, string[]> = {
      "united states": [...US_STATES.map(s => `, ${s.toLowerCase()}`), "united states", ", usa", ", us"],
      "united kingdom": [", uk", "united kingdom", "england", "scotland", "wales", "london", "manchester", "birmingham", "leeds", "glasgow", "edinburgh", "bristol", "liverpool", "nottingham", "sheffield", "cardiff"],
      "canada": ["canada", ", ca", "toronto", "vancouver", "montreal", "ottawa", "calgary"],
      "germany": ["germany", "deutschland", "berlin", "munich", "frankfurt", "hamburg"],
      "france": ["france", "paris", "lyon", "marseille"],
      "australia": ["australia", "sydney", "melbourne", "brisbane", "perth"],
      "india": ["india", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune", "chennai"],
      "singapore": ["singapore"],
      "ireland": ["ireland", "dublin"],
      "netherlands": ["netherlands", "amsterdam", "rotterdam"],
      "uae": ["uae", "united arab emirates", "dubai", "abu dhabi"],
      "israel": ["israel", "tel aviv"],
      "japan": ["japan", "tokyo"],
      "switzerland": ["switzerland", "zurich", "geneva"],
      "spain": ["spain", "madrid", "barcelona"],
      "italy": ["italy", "milan", "rome"],
      "brazil": ["brazil", "são paulo", "sao paulo"],
      "mexico": ["mexico", "mexico city"],
      "south korea": ["south korea", "seoul"],
      "china": ["china", "beijing", "shanghai", "shenzhen"],
      "poland": ["poland", "warsaw", "krakow"],
      "sweden": ["sweden", "stockholm"],
      "denmark": ["denmark", "copenhagen"],
      "norway": ["norway", "oslo"],
      "finland": ["finland", "helsinki"],
      "belgium": ["belgium", "brussels"],
      "austria": ["austria", "vienna"],
      "czech republic": ["czech", "prague"],
      "portugal": ["portugal", "lisbon"],
      "romania": ["romania", "bucharest"],
      "new zealand": ["new zealand", "auckland", "wellington"],
    };

    const locLower = location.toLowerCase();
    // Detect country from location field
    for (const [country, indicators] of Object.entries(COUNTRY_INDICATORS)) {
      if (indicators.some(ind => locLower.includes(ind))) {
        detectedCountry = country;
        break;
      }
    }

    // Canada ambiguity: ", ca" also matches California — disambiguate
    if (detectedCountry === "canada" && /,\s*ca\b/i.test(location) && !locLower.includes("canada")) {
      // Likely California, not Canada
      detectedCountry = "united states";
    }

    // Check if detected country is accepted
    const countryAccepted = !detectedCountry || acceptedCountries.some(ac =>
      ac === detectedCountry || detectedCountry.includes(ac) || ac.includes(detectedCountry)
    );

    if (!countryAccepted) {
      // Zero out location score for non-accepted country
      breakdown.location_fit = 0;
    }

    breakdown._detected_country = detectedCountry;
    breakdown._country_accepted = countryAccepted;
  }

  categories.location_fit = {
    score: breakdown.location_fit,
    maxPoints: w.location_fit,
    matchedPhrases: cap([...metroHits, ...(isRemote ? ["remote"] : []), ...(isHybrid ? ["hybrid"] : [])], 5),
  };

  const compText = jd.match(
    /\$[\d,]+\s*[-–]\s*\$[\d,]+/,
  );
  const compPhrases: string[] = [];
  if (compText) {
    compPhrases.push(compText[0]);
    const numbers = compText[0].match(/[\d,]+/g) || [];
    const high = parseInt(numbers[numbers.length - 1]?.replace(/,/g, "") || "0");
    if (high >= 300000) breakdown.compensation = w.compensation;
    else if (high >= 250000) breakdown.compensation = Math.round(w.compensation * 0.8);
    else if (high >= 200000) breakdown.compensation = Math.round(w.compensation * 0.6);
    else if (high >= 150000) breakdown.compensation = Math.round(w.compensation * 0.4);
    else breakdown.compensation = Math.round(w.compensation * 0.2);
  } else {
    breakdown.compensation = Math.round(w.compensation * 0.5);
  }
  categories.compensation = {
    score: breakdown.compensation,
    maxPoints: w.compensation,
    matchedPhrases: compPhrases,
  };

  const transformSignals = [
    "transform",
    "modernize",
    "build from scratch",
    "greenfield",
    "first",
    "establish",
    "new function",
    "scale",
    "grow",
  ];
  const transformHits = transformSignals.filter((s) => jd.includes(s));
  breakdown.transformation_mandate = Math.min(w.transformation_mandate, Math.round((transformHits.length / 3) * w.transformation_mandate));
  categories.transformation_mandate = {
    score: breakdown.transformation_mandate,
    maxPoints: w.transformation_mandate,
    matchedPhrases: cap(transformHits, 5),
  };

  const companyPrefSignals = [
    "series",
    "fortune",
    "growth",
    "innovative",
    "leading",
  ];
  const prefHits = companyPrefSignals.filter((s) => jd.includes(s));
  breakdown.company_preference = Math.min(w.company_preference, Math.round((prefHits.length / 2) * w.company_preference));
  categories.company_preference = {
    score: breakdown.company_preference,
    maxPoints: w.company_preference,
    matchedPhrases: cap(prefHits, 5),
  };

  const execMode = classifyExecutionMode(jd);
  const clampedExec = Math.max(w.execution_mode_match.min, Math.min(w.execution_mode_match.max, execMode.score));
  breakdown.execution_mode_match = clampedExec;
  breakdown.execution_mode_reason = execMode.reason;
  categories.execution_mode_match = {
    score: clampedExec,
    maxPoints: w.execution_mode_match.max,
    matchedPhrases: cap([
      ...EXECUTION_MODE_POSITIVE_SIGNALS.filter((s) => jd.includes(s)),
      ...EXECUTION_MODE_NEGATIVE_SIGNALS.filter((s) => jd.includes(s)),
    ], 5),
    reason: execMode.reason,
  };
  if (clampedExec < 0) {
    penalties.push({ key: "execution_mode_match", score: clampedExec, reason: execMode.reason });
    if (clampedExec <= -10) {
      riskFlags.push("Engineering-heavy AI execution expected");
    }
  }

  const specInflation = computeSpecInflationPenalty(jd);
  const clampedSpec = Math.max(w.spec_inflation_penalty.min, Math.min(w.spec_inflation_penalty.max, specInflation.score));
  breakdown.spec_inflation_penalty = clampedSpec;
  breakdown.spec_inflation_reason = specInflation.reason;
  categories.spec_inflation_penalty = {
    score: clampedSpec,
    maxPoints: 0,
    matchedPhrases: cap(SPEC_INFLATION_CONFIG.advancedAITerms.filter((t) => jd.includes(t)), 5),
    reason: specInflation.reason,
  };
  if (clampedSpec < 0) {
    penalties.push({ key: "spec_inflation_penalty", score: clampedSpec, reason: specInflation.reason });
    riskFlags.push("High buzzword density with weak business grounding");
  }

  if (!arrangementAcceptable) {
    const typeLabel = isRemote ? "remote" : isHybrid ? "hybrid" : isOnsite ? "in-office" : "unknown";
    riskFlags.push(`${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} position — marked as "will not do"`);
  } else if (!locationMatch && !isRemote) {
    const prefList = prefMetros.join(", ");
    riskFlags.push(`Not in preferred metro (${prefList})`);
  }

  if (breakdown._country_accepted === false && detectedCountry) {
    riskFlags.push(`Outside accepted countries (detected: ${detectedCountry})`);
  }

  const SKIP_KEYS = new Set(["execution_mode_reason", "spec_inflation_reason"]);
  const rawTotal = Object.entries(breakdown).reduce((sum, [key, v]) => {
    if (key.startsWith("_") || SKIP_KEYS.has(key) || typeof v !== "number") return sum;
    return sum + v;
  }, 0);

  const maxPos = getMaxPositiveScore(w);
  const normalized = Math.max(0, Math.min(100, Math.round((rawTotal / maxPos) * 100)));

  breakdown._raw_total = rawTotal;
  breakdown._max_possible = maxPos;
  breakdown._scoring_mode = mode;

  const orderedCategories: Record<string, CategoryDetail> = {};
  for (const key of DISPLAY_ORDER) {
    if (categories[key]) orderedCategories[key] = categories[key];
  }

  const hardFlagResult = evaluateRules(job, inventory);

  for (const hf of hardFlagResult.flags) {
    riskFlags.push(`[${hf.ruleId}] ${hf.message}`);
  }

  if (hardFlagResult.scoreAdjustment !== 0) {
    penalties.push({
      key: "hard_flag_rules",
      score: hardFlagResult.scoreAdjustment,
      reason: hardFlagResult.flags.map((f) => f.message).join("; "),
    });
  }

  const adjustedTotal = Math.max(0, Math.min(100, normalized + Math.round((hardFlagResult.scoreAdjustment / maxPos) * 100)));

  breakdown._hard_flag_adjustment = hardFlagResult.scoreAdjustment;
  breakdown._gate_status = hardFlagResult.gateOverride;

  const roleShape = classifyRoleShape(job);

  if (roleShape.shape === "D") {
    riskFlags.push(`RoleShape D: ${roleShape.label} (confidence ${roleShape.confidence})`);
  } else if (roleShape.shape === "B" && roleShape.confidence >= 0.5) {
    riskFlags.push(`RoleShape B: ${roleShape.label} — review engineering ownership scope`);
  }

  breakdown._role_shape = roleShape.shape;
  breakdown._role_shape_confidence = roleShape.confidence;
  breakdown._hard_flags = hardFlagResult.flags;
  breakdown._risk_flags = riskFlags.sort();

  const report: ScoreReport = {
    total: adjustedTotal,
    mode,
    rawTotal,
    maxPossible: maxPos,
    categories: orderedCategories,
    penalties: penalties.sort((a, b) => a.key.localeCompare(b.key)),
    riskFlags: riskFlags.sort(),
    hardFlags: hardFlagResult.flags,
    gateStatus: hardFlagResult.gateOverride,
    hardFlagAdjustment: hardFlagResult.scoreAdjustment,
    roleShape,
  };

  return { total: adjustedTotal, breakdown, mode, report };
}

export function prettyPrintReport(report: ScoreReport, jobLabel?: string): string {
  const lines: string[] = [];
  const divider = "─".repeat(60);

  lines.push(divider);
  lines.push(`SCORE REPORT${jobLabel ? `: ${jobLabel}` : ""}`);
  lines.push(divider);
  lines.push(`Total: ${report.total}/100  (raw ${report.rawTotal}/${report.maxPossible})  mode=${report.mode}`);
  lines.push(`RoleShape: ${report.roleShape.shape} — ${report.roleShape.label}  (confidence ${report.roleShape.confidence})`);
  lines.push("");
  lines.push("CATEGORY BREAKDOWN");
  lines.push(divider);

  for (const [key, cat] of Object.entries(report.categories)) {
    const bar = cat.maxPoints > 0
      ? `${cat.score}/${cat.maxPoints}`
      : `${cat.score}`;
    const phrases = cat.matchedPhrases.length > 0
      ? `  phrases: ${cat.matchedPhrases.join(", ")}`
      : "";
    lines.push(`  ${key.padEnd(28)} ${bar.padStart(8)}${phrases}`);
  }

  if (report.penalties.length > 0) {
    lines.push("");
    lines.push("PENALTIES APPLIED");
    lines.push(divider);
    for (const pen of report.penalties) {
      lines.push(`  ${pen.key.padEnd(28)} ${String(pen.score).padStart(4)}  ${pen.reason}`);
    }
  }

  if (report.hardFlags.length > 0) {
    lines.push("");
    lines.push(`HARD FLAGS  (gate: ${report.gateStatus}, adjustment: ${report.hardFlagAdjustment})`);
    lines.push(divider);
    for (const hf of report.hardFlags) {
      lines.push(`  [${hf.ruleId}] ${hf.ruleName}`);
      lines.push(`          ${hf.message}`);
    }
  }

  if (report.riskFlags.length > 0) {
    lines.push("");
    lines.push("RISK FLAGS");
    lines.push(divider);
    for (const flag of report.riskFlags) {
      lines.push(`  • ${flag}`);
    }
  }

  lines.push(divider);
  return lines.join("\n");
}

export const scoreJobsTool = createTool({
  id: "score-jobs",
  description:
    "Scores job postings against the experience inventory using a weighted rubric (0-100). Returns top N jobs sorted by score.",
  inputSchema: z.object({
    jobIds: z.array(z.number()).describe("List of job IDs to score"),
    topN: z
      .number()
      .optional()
      .describe("Number of top jobs to return, defaults to 10"),
  }),
  outputSchema: z.object({
    scoredJobs: z.array(
      z.object({
        job_id: z.number(),
        company: z.string(),
        title: z.string(),
        location: z.string(),
        remote_hybrid: z.string(),
        posting_url: z.string(),
        total_score: z.number(),
        breakdown: z.record(z.string(), z.any()),
        jd_raw_text: z.string(),
      }),
    ),
    totalScored: z.number(),
    scoringMode: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const mode = getActiveMode();
    const profile = getActiveProfile();
    logger?.info(
      `📊 [scoreJobs] Scoring ${context.jobIds.length} jobs in ${mode} mode (${profile.label})`,
    );

    const inventory = loadInventory();
    const topN = context.topN || 10;

    // Load location preferences from DB
    let locationPrefs: { metros: string[]; prefRemote: string; prefHybrid: string; prefOnsite: string; countries: string[] } = {
      metros: ["chicago"], prefRemote: "will-do", prefHybrid: "will-do", prefOnsite: "will-do", countries: [],
    };
    try {
      const prefKeys = ["preferred_metros", "pref_remote", "pref_hybrid", "pref_onsite", "preferred_countries"];
      const prefResult = await query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
        [prefKeys],
      );
      for (const row of prefResult.rows) {
        if (row.key === "preferred_metros" && row.value) {
          locationPrefs.metros = row.value.split(",").map((m: string) => m.trim().toLowerCase()).filter(Boolean);
        }
        if (row.key === "preferred_countries" && row.value) {
          locationPrefs.countries = row.value.split(",").map((c: string) => c.trim().toLowerCase()).filter(Boolean);
        }
        if (row.key === "pref_remote" && row.value) locationPrefs.prefRemote = row.value.trim().toLowerCase();
        if (row.key === "pref_hybrid" && row.value) locationPrefs.prefHybrid = row.value.trim().toLowerCase();
        if (row.key === "pref_onsite" && row.value) locationPrefs.prefOnsite = row.value.trim().toLowerCase();
      }
    } catch (e: any) {
      logger?.warn(`⚠️ [scoreJobs] Could not load location prefs: ${e.message}`);
    }
    logger?.info(`📊 [scoreJobs] Location prefs: metros=${locationPrefs.metros.join(",")}, countries=${locationPrefs.countries.join(",")}, remote=${locationPrefs.prefRemote}, hybrid=${locationPrefs.prefHybrid}, onsite=${locationPrefs.prefOnsite}`);

    const scoredJobs: any[] = [];

    for (const jobId of context.jobIds) {
      try {
        const result = await query("SELECT * FROM jobs WHERE job_id = $1", [
          jobId,
        ]);
        if (result.rows.length === 0) {
          logger?.warn(`⚠️ [scoreJobs] Job ID ${jobId} not found`);
          continue;
        }
        const job = result.rows[0];
        const { total, breakdown } = scoreSingleJob(job, inventory, profile, locationPrefs);

        await query(
          `INSERT INTO scores (job_id, total_score, breakdown_json)
           VALUES ($1, $2, $3)
           ON CONFLICT (job_id) DO UPDATE SET total_score = $2, breakdown_json = $3`,
          [jobId, total, JSON.stringify(breakdown)],
        );

        scoredJobs.push({
          job_id: jobId,
          company: job.company || "",
          title: job.title || "",
          location: job.location || "",
          remote_hybrid: job.remote_hybrid || "",
          posting_url: job.posting_url || "",
          total_score: total,
          breakdown,
          jd_raw_text: job.jd_raw_text || "",
        });

        if (scoredJobs.length % 25 === 0) {
          logger?.info(`📊 [scoreJobs] Progress: ${scoredJobs.length}/${context.jobIds.length} scored`);
        }
      } catch (err: any) {
        logger?.error(`⚠️ [scoreJobs] Failed to score job ${jobId}: ${err.message}`);
        continue;
      }
    }
    logger?.info(`📊 [scoreJobs] Finished: ${scoredJobs.length}/${context.jobIds.length} scored successfully`);

    scoredJobs.sort((a, b) => b.total_score - a.total_score);
    const topJobs = scoredJobs.slice(0, topN);

    await query(
      `UPDATE jobs SET status = 'shortlisted' WHERE job_id = ANY($1)`,
      [topJobs.map((j) => j.job_id)],
    );

    logger?.info(
      `✅ [scoreJobs] Top ${topJobs.length} jobs selected. Highest: ${topJobs[0]?.total_score}/100 (${mode})`,
    );

    return {
      scoredJobs: topJobs,
      totalScored: scoredJobs.length,
      scoringMode: mode,
    };
  },
});
