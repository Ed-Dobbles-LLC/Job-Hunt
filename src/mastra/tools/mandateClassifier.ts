/**
 * Mandate Classifier — Reads a job description and outputs weighted intent dimensions.
 *
 * Instead of keyword-stuffing, this classifies WHAT the role is mandated to DO:
 * - Operating model transformation
 * - Governance / metric standardization
 * - Insight delivery automation
 * - Revenue ops / pipeline / forecasting
 * - BI platform modernization
 * - Executive storytelling & stakeholder influence
 * - Team leadership at scale
 *
 * Each dimension gets a weight (0.0-1.0) based on signal density in the JD.
 * These weights drive bullet reordering: top-weighted mandates → top bullets.
 */

import type { JDRequirements } from "./extractJDRequirementsTool";

// ── Mandate Dimensions ──────────────────────────────────────────
export interface MandateDimension {
  id: string;
  label: string;
  weight: number;        // 0.0 = absent, 1.0 = primary mandate
  signal_phrases: string[];  // Phrases from JD that triggered this
  description: string;
}

export interface MandateProfile {
  dimensions: MandateDimension[];
  primary_mandate: string;       // ID of the highest-weighted dimension
  secondary_mandates: string[];  // IDs of 2nd and 3rd highest
  seniority_level: "IC" | "Manager" | "Director" | "Sr Director" | "VP" | "SVP" | "C-Suite";
  calibrated_headline: string;   // Suggested headline matching JD seniority
  gaps_vs_inventory: string[];   // Mandates with weight > 0.3 but no inventory support
}

// ── Signal dictionaries for each mandate dimension ──────────────
const MANDATE_SIGNALS: Record<string, { keywords: string[]; phrases: RegExp[] }> = {
  operating_model_transformation: {
    keywords: [
      "operating model", "transformation", "modernization", "re-architect",
      "embed", "embedded analytics", "self-service", "democratize",
      "from dashboards to", "data products", "data mesh", "data fabric",
      "centralize", "federated", "hub and spoke", "center of excellence",
    ],
    phrases: [
      /transform\w*\s+(?:the\s+)?(?:operating|business|analytics|data)\s+model/gi,
      /build\s+(?:a\s+)?(?:new|modern|next.gen)\s+(?:analytics|data|insight)/gi,
      /embed\w*\s+(?:analytics|insights|data)\s+(?:into|across|within)/gi,
      /(?:shift|move|transition)\s+from\s+.*?\s+to\s+/gi,
    ],
  },
  governance_standardization: {
    keywords: [
      "governance", "data governance", "data quality", "standardize",
      "OKR", "KPI", "metrics", "metric tree", "single source of truth",
      "MDM", "master data", "data catalog", "lineage", "compliance",
      "SOX", "GDPR", "regulatory", "audit", "controls",
    ],
    phrases: [
      /(?:establish|build|implement|own)\s+(?:data\s+)?governance/gi,
      /standard\w*\s+(?:metrics|KPIs|OKRs|definitions|reporting)/gi,
      /single\s+source\s+of\s+truth/gi,
      /data\s+quality\s+(?:framework|standards|rules|program)/gi,
    ],
  },
  insight_delivery_automation: {
    keywords: [
      "automation", "automate", "Slack", "email alerts", "push insights",
      "real-time", "streaming", "event-driven", "LLM", "GenAI",
      "natural language", "chatbot", "self-service", "alert",
      "notification", "proactive",
    ],
    phrases: [
      /automat\w+\s+(?:insight|report|dashboard|delivery|distribution)/gi,
      /(?:push|deliver|distribute)\s+(?:insights|analytics|reports)\s+(?:to|via|through)/gi,
      /(?:GenAI|LLM|AI.powered)\s+(?:insight|analytics|reporting)/gi,
      /real.time\s+(?:analytics|insights|monitoring|alerts)/gi,
    ],
  },
  revenue_ops_forecasting: {
    keywords: [
      "revenue", "pipeline", "forecast", "demand planning", "pricing",
      "commercial analytics", "sales analytics", "customer analytics",
      "churn", "retention", "LTV", "CAC", "ARPU", "conversion",
      "funnel", "attribution", "ROI", "P&L", "margin",
    ],
    phrases: [
      /(?:revenue|sales|commercial)\s+(?:analytics|optimization|ops|operations)/gi,
      /(?:forecast|predict)\w*\s+(?:revenue|demand|sales|pipeline)/gi,
      /(?:pricing|monetization)\s+(?:strategy|optimization|analytics)/gi,
      /(?:P&L|profit.loss|margin)\s+(?:ownership|influence|responsibility)/gi,
    ],
  },
  bi_platform_modernization: {
    keywords: [
      "Looker", "Tableau", "Power BI", "Sigma", "ThoughtSpot", "Qlik",
      "Snowflake", "Databricks", "BigQuery", "Redshift", "dbt",
      "data warehouse", "lakehouse", "data lake", "ETL", "ELT",
      "migration", "consolidate", "platform", "tech stack",
    ],
    phrases: [
      /(?:modernize|upgrade|consolidate|migrate)\s+(?:BI|analytics|data)\s+(?:platform|stack|tools)/gi,
      /(?:select|evaluate|implement)\s+(?:new\s+)?(?:BI|analytics|visualization)\s+(?:platform|tool)/gi,
      /(?:build|architect|design)\s+(?:a\s+)?(?:modern|scalable|enterprise)\s+data\s+(?:platform|stack|infrastructure)/gi,
    ],
  },
  executive_storytelling: {
    keywords: [
      "stakeholder", "executive", "board", "C-suite", "influence",
      "storytelling", "narrative", "presentation", "alignment",
      "strategic", "business partner", "advisory", "thought leader",
      "cross-functional", "change management",
    ],
    phrases: [
      /(?:present|communicate|translate)\s+(?:to|for)\s+(?:executive|C.suite|board|senior\s+leadership)/gi,
      /(?:influence|advise|partner\s+with)\s+(?:executive|C.suite|senior)\s+(?:leadership|stakeholders|team)/gi,
      /(?:data|analytics).driven\s+(?:storytelling|narrative|decision.making)/gi,
      /(?:strategic\s+)?(?:business\s+)?partner\w*\s+(?:to|with|across)/gi,
    ],
  },
  team_leadership_scale: {
    keywords: [
      "team", "hire", "recruit", "scale", "grow", "build",
      "manage", "lead", "org", "organization", "pod", "distributed",
      "mentor", "develop", "career", "talent", "headcount",
      "direct reports", "matrix", "cross-functional",
    ],
    phrases: [
      /(?:build|grow|scale|lead|manage)\s+(?:a\s+)?(?:team|organization|function)\s+of\s+\d+/gi,
      /(?:hire|recruit|attract)\s+(?:and\s+retain\s+)?(?:top|senior|world.class)\s+(?:talent|people)/gi,
      /(?:lead|manage|oversee)\s+(?:a\s+)?(?:distributed|global|remote|matrixed)\s+(?:team|org)/gi,
      /\d+\+?\s+(?:direct\s+reports|team\s+members|FTEs|people)/gi,
    ],
  },
};

// ── Seniority Detection ─────────────────────────────────────────
const SENIORITY_PATTERNS: { level: MandateProfile["seniority_level"]; patterns: RegExp[] }[] = [
  { level: "C-Suite", patterns: [/\bC[A-Z]O\b/, /\bChief\s+\w+\s+Officer\b/i, /\bSVP.*(?:&|and).*VP\b/i] },
  { level: "SVP", patterns: [/\bSVP\b/, /\bSenior\s+Vice\s+President\b/i] },
  { level: "VP", patterns: [/\bVP\b/, /\bVice\s+President\b/i] },
  { level: "Sr Director", patterns: [/\bSr\.?\s+Director\b/i, /\bSenior\s+Director\b/i, /\bHead\s+of\b/i] },
  { level: "Director", patterns: [/\bDirector\b/i] },
  { level: "Manager", patterns: [/\bManager\b/i, /\bLead\b/i] },
  { level: "IC", patterns: [/\bAnalyst\b/i, /\bEngineer\b/i, /\bScientist\b/i, /\bSpecialist\b/i] },
];

function detectSeniority(jdText: string, title: string): MandateProfile["seniority_level"] {
  const combined = `${title}\n${jdText}`;
  for (const { level, patterns } of SENIORITY_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(combined)) return level;
    }
  }
  return "Director"; // default
}

// ── Headline Calibration ────────────────────────────────────────
const HEADLINE_MAP: Record<MandateProfile["seniority_level"], string[]> = {
  "C-Suite": ["Chief Data & Analytics Officer", "Chief Analytics Officer"],
  "SVP": ["SVP, Enterprise Data & Analytics", "SVP, Data Strategy & AI"],
  "VP": ["VP, Data & Analytics", "VP, Enterprise Analytics & AI"],
  "Sr Director": ["Enterprise Analytics & AI Leader", "Head of Data Analytics & Insights"],
  "Director": ["Director, Data & Analytics", "Analytics & Insights Leader"],
  "Manager": ["Analytics Manager", "Data & Analytics Lead"],
  "IC": ["Senior Data Analyst", "Senior Analytics Professional"],
};

function calibrateHeadline(
  seniority: MandateProfile["seniority_level"],
  topDimensions: string[],
  title: string,
): string {
  // If the actual job title is specific enough, use it directionally
  const titleNorm = title.toLowerCase();

  // Don't claim C-suite if the role is below that
  if (seniority === "Sr Director" || seniority === "Director") {
    // Use neutral executive framing
    if (titleNorm.includes("head of")) {
      return title; // Use the actual JD title
    }
    return HEADLINE_MAP[seniority][0];
  }

  return HEADLINE_MAP[seniority]?.[0] || "Data & Analytics Executive";
}

// ── Main Classifier ─────────────────────────────────────────────
export function classifyMandate(
  jdText: string,
  title: string,
  requirements?: JDRequirements,
): MandateProfile {
  const textLower = jdText.toLowerCase();
  const dimensions: MandateDimension[] = [];

  for (const [dimId, signals] of Object.entries(MANDATE_SIGNALS)) {
    let score = 0;
    const matched: string[] = [];

    // Keyword scoring (0.1 per keyword match, max 0.5 from keywords)
    for (const kw of signals.keywords) {
      const kwLower = kw.toLowerCase();
      if (textLower.includes(kwLower)) {
        score += 0.1;
        matched.push(kw);
      }
    }
    score = Math.min(score, 0.5);

    // Phrase scoring (0.15 per phrase match, max 0.5 from phrases)
    for (const phrase of signals.phrases) {
      const re = new RegExp(phrase.source, phrase.flags);
      const m = textLower.match(re);
      if (m) {
        score += 0.15;
        matched.push(m[0].trim());
      }
    }
    score = Math.min(score, 1.0);

    // Boost from extracted requirements
    if (requirements) {
      const allReqs = [
        ...(requirements.must_have || []),
        ...(requirements.nice_to_have || []),
        ...(requirements.leadership_scope || []),
        ...(requirements.domain_context || []),
        ...(requirements.tech_keywords || []),
      ];
      for (const req of allReqs) {
        const reqText = typeof req === "string" ? req : req.text || "";
        const reqLower = reqText.toLowerCase();
        for (const kw of signals.keywords.slice(0, 5)) {
          if (reqLower.includes(kw.toLowerCase())) {
            score += 0.05;
          }
        }
      }
      score = Math.min(score, 1.0);
    }

    const label = dimId
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    dimensions.push({
      id: dimId,
      label,
      weight: Math.round(score * 100) / 100,
      signal_phrases: matched,
      description: getDescription(dimId),
    });
  }

  // Sort by weight descending
  dimensions.sort((a, b) => b.weight - a.weight);

  const primary = dimensions[0]?.id || "team_leadership_scale";
  const secondary = dimensions
    .slice(1)
    .filter((d) => d.weight >= 0.2)
    .map((d) => d.id)
    .slice(0, 2);

  const seniority = detectSeniority(jdText, title);
  const topDimIds = dimensions.filter((d) => d.weight >= 0.3).map((d) => d.id);
  const headline = calibrateHeadline(seniority, topDimIds, title);

  return {
    dimensions,
    primary_mandate: primary,
    secondary_mandates: secondary,
    seniority_level: seniority,
    calibrated_headline: headline,
    gaps_vs_inventory: [], // populated later by comparing against ledger
  };
}

function getDescription(dimId: string): string {
  const desc: Record<string, string> = {
    operating_model_transformation: "Redesigning how analytics/data operates — from centralized dashboards to embedded, self-service, or product-oriented models",
    governance_standardization: "Establishing data governance, metric definitions, quality frameworks, and compliance programs",
    insight_delivery_automation: "Automating insight distribution through Slack, email, LLM-powered tools, or real-time alerts",
    revenue_ops_forecasting: "Revenue analytics, demand forecasting, pricing optimization, and commercial analytics",
    bi_platform_modernization: "Selecting, implementing, or migrating BI/data platforms and tech stacks",
    executive_storytelling: "Presenting to boards, influencing C-suite decisions, and translating data into strategic narrative",
    team_leadership_scale: "Building, scaling, and managing analytics teams — hiring, mentoring, org design",
  };
  return desc[dimId] || "";
}

// ── Bullet Scoring Against Mandate ──────────────────────────────
export interface ScoredBullet {
  bullet_id: string;
  bullet_text: string;
  experience_id: string;
  mandate_scores: Record<string, number>;  // dimension_id → relevance score (0-1)
  total_relevance: number;                 // weighted sum against mandate profile
  rank: number;                            // 1 = most relevant
}

/**
 * Score every inventory bullet against the mandate profile.
 * This determines bullet ordering in the final resume.
 */
export function scoreBulletsAgainstMandate(
  inventory: Record<string, any>,
  mandate: MandateProfile,
): ScoredBullet[] {
  const scored: ScoredBullet[] = [];

  for (const exp of inventory.experience || []) {
    for (const bullet of exp.bullets || []) {
      const bulletText = (bullet.text || "").toLowerCase();
      const mandateScores: Record<string, number> = {};

      for (const dim of mandate.dimensions) {
        let dimScore = 0;
        const signals = MANDATE_SIGNALS[dim.id];
        if (!signals) continue;

        // Check keywords
        for (const kw of signals.keywords) {
          if (bulletText.includes(kw.toLowerCase())) {
            dimScore += 0.15;
          }
        }

        // Check phrases
        for (const phrase of signals.phrases) {
          const re = new RegExp(phrase.source, phrase.flags);
          if (re.test(bulletText)) {
            dimScore += 0.25;
          }
        }

        // Check tools mentioned in bullet
        for (const tool of bullet.tools || []) {
          const toolLower = tool.toLowerCase();
          for (const kw of signals.keywords) {
            if (toolLower.includes(kw.toLowerCase()) || kw.toLowerCase().includes(toolLower)) {
              dimScore += 0.1;
            }
          }
        }

        mandateScores[dim.id] = Math.min(dimScore, 1.0);
      }

      // Calculate weighted total relevance
      let totalRelevance = 0;
      for (const dim of mandate.dimensions) {
        totalRelevance += (mandateScores[dim.id] || 0) * dim.weight;
      }

      scored.push({
        bullet_id: bullet.id || `${exp.id}-b${(exp.bullets || []).indexOf(bullet)}`,
        bullet_text: bullet.text,
        experience_id: exp.id,
        mandate_scores: mandateScores,
        total_relevance: Math.round(totalRelevance * 1000) / 1000,
        rank: 0, // set after sorting
      });
    }
  }

  // Sort by total relevance descending and assign ranks
  scored.sort((a, b) => b.total_relevance - a.total_relevance);
  scored.forEach((s, i) => (s.rank = i + 1));

  return scored;
}

/**
 * Given scored bullets, determine which mandates have NO coverage in the inventory.
 * These become "Gaps / Clarifications Needed" items.
 */
export function identifyMandateGaps(
  mandate: MandateProfile,
  scoredBullets: ScoredBullet[],
): { dimension_id: string; label: string; weight: number; best_coverage: number; suggestion: string }[] {
  const gaps: { dimension_id: string; label: string; weight: number; best_coverage: number; suggestion: string }[] = [];

  for (const dim of mandate.dimensions) {
    if (dim.weight < 0.2) continue; // skip irrelevant dimensions

    // Find best bullet coverage for this dimension
    let bestCoverage = 0;
    for (const bullet of scoredBullets) {
      const score = bullet.mandate_scores[dim.id] || 0;
      if (score > bestCoverage) bestCoverage = score;
    }

    if (bestCoverage < 0.15) {
      gaps.push({
        dimension_id: dim.id,
        label: dim.label,
        weight: dim.weight,
        best_coverage: bestCoverage,
        suggestion: `No strong inventory evidence for "${dim.label}". Consider: (a) omit, (b) rephrase closest transferable bullet to emphasize this angle without adding new facts, or (c) ask candidate for clarification.`,
      });
    }
  }

  return gaps;
}
