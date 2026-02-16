/**
 * Mandate Archetype Classifier — Classifies job descriptions against 10 weighted
 * executive mandate archetypes. Each archetype scores 0-5 based on signal density.
 *
 * 10 Archetypes:
 * 1. Enterprise Operating Model Transformation
 * 2. Governance & Metric Standardization
 * 3. Revenue Operations / Pipeline Analytics
 * 4. Insight Delivery Modernization
 * 5. AI Integration / LLM Enablement
 * 6. BI Modernization
 * 7. Executive OKR Reporting
 * 8. Cross-Functional Executive Influence
 * 9. Growth & Monetization
 * 10. Team Scale & Org Design
 *
 * These weights drive:
 * - Summary reframing
 * - Bullet reordering per role
 * - Competency cluster adjustment
 * - Headline tone calibration
 */

import type { JDRequirements } from "./extractJDRequirementsTool";

// ── Mandate Dimensions ──────────────────────────────────────────
export interface MandateDimension {
  id: string;
  label: string;
  weight: number;        // 0.0-1.0 internal weight (used for math)
  score_0_5: number;     // 0-5 display scale (weight * 5)
  signal_phrases: string[];  // Phrases from JD that triggered this
  description: string;
}

export interface MandateProfile {
  dimensions: MandateDimension[];
  primary_mandate: string;       // ID of the highest-weighted dimension
  secondary_mandates: string[];  // IDs of 2nd and 3rd highest
  top_3_archetypes: { id: string; label: string; score: number }[];
  seniority_level: "IC" | "Manager" | "Director" | "Sr Director" | "VP" | "SVP" | "C-Suite";
  calibrated_headline: string;
  tone_guidance: ToneGuidance;
  gaps_vs_inventory: string[];
}

export interface ToneGuidance {
  seniority: string;
  summary_posture: string;
  bullet_framing: string;
  competency_emphasis: string;
  headline_tone: string;
}

// ── Signal dictionaries for each mandate archetype ──────────────
const MANDATE_SIGNALS: Record<string, { keywords: string[]; phrases: RegExp[] }> = {
  operating_model_transformation: {
    keywords: [
      "operating model", "transformation", "modernization", "re-architect",
      "embed", "embedded analytics", "self-service", "democratize",
      "data products", "data mesh", "data fabric", "center of excellence",
      "centralize", "federated", "hub and spoke", "from dashboards to",
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
  insight_delivery_modernization: {
    keywords: [
      "Looker", "Tableau", "Power BI", "Sigma", "ThoughtSpot", "Qlik",
      "dashboard", "visualization", "reporting", "self-service analytics",
      "automation", "automate", "Slack", "email alerts", "push insights",
      "real-time", "streaming", "LLM", "GenAI", "proactive",
    ],
    phrases: [
      /automat\w+\s+(?:insight|report|dashboard|delivery|distribution)/gi,
      /(?:push|deliver|distribute)\s+(?:insights|analytics|reports)\s+(?:to|via|through)/gi,
      /(?:GenAI|LLM|AI.powered)\s+(?:insight|analytics|reporting)/gi,
      /(?:modernize|upgrade|consolidate)\s+(?:BI|analytics|reporting)\s+(?:platform|stack|tools)/gi,
      /real.time\s+(?:analytics|insights|monitoring|alerts)/gi,
    ],
  },
  ai_integration_llm: {
    keywords: [
      "LLM", "GenAI", "generative AI", "AI integration", "machine learning",
      "NLP", "natural language", "AI-powered", "copilot", "AI agent",
      "prompt engineering", "RAG", "retrieval augmented", "fine-tuning",
      "model deployment", "AI strategy", "AI governance", "responsible AI",
      "AI/ML", "deep learning", "MLOps", "model training", "inference",
      "embeddings", "vector", "AI enablement", "AI transformation",
    ],
    phrases: [
      /(?:AI|LLM|GenAI)\s+(?:integration|enablement|strategy|deployment|adoption)/gi,
      /(?:deploy|implement|build|integrate)\s+(?:AI|ML|LLM|GenAI)\s+(?:solution|model|platform|capability)/gi,
      /(?:machine\s+learning|deep\s+learning)\s+(?:platform|infrastructure|pipeline|ops)/gi,
      /(?:responsible|ethical)\s+AI/gi,
      /(?:AI|ML).(?:powered|driven|enabled)\s+(?:analytics|insight|decision|product)/gi,
    ],
  },
  growth_monetization: {
    keywords: [
      "growth", "monetization", "A/B testing", "experimentation",
      "conversion rate", "ARPU", "subscription", "freemium",
      "pricing optimization", "customer lifetime value", "CLV",
      "growth loops", "viral", "referral", "acquisition", "paywall",
    ],
    phrases: [
      /growth\s+(?:analytics|strategy|hacking|engineering|marketing)/gi,
      /(?:A\/B|experiment)\s+(?:testing|framework|program|velocity)/gi,
      /(?:conversion|monetization)\s+(?:optimization|rate|strategy)/gi,
      /(?:subscription|recurring)\s+(?:revenue|model|analytics)/gi,
    ],
  },
  executive_okr_reporting: {
    keywords: [
      "OKR", "executive reporting", "board reporting", "quarterly business review",
      "QBR", "scorecard", "executive dashboard", "performance reporting",
      "strategic reporting", "CEO reporting", "CFO reporting", "board deck",
      "board presentation", "monthly business review", "MBR", "annual operating plan",
      "AOP", "executive alignment", "strategic KPI", "goal framework",
      "leadership reporting", "management reporting", "performance management",
    ],
    phrases: [
      /(?:executive|board|C.suite|leadership)\s+(?:reporting|dashboard|scorecard|review)/gi,
      /(?:OKR|KPI)\s+(?:framework|alignment|reporting|tracking|cascade)/gi,
      /(?:quarterly|monthly|annual)\s+(?:business\s+)?review/gi,
      /(?:strategic|executive)\s+(?:planning|alignment|goal)/gi,
      /(?:performance|management)\s+(?:reporting|dashboard|framework)/gi,
    ],
  },
  bi_modernization: {
    keywords: [
      "Snowflake", "Databricks", "BigQuery", "Redshift", "dbt",
      "data warehouse", "lakehouse", "data lake", "ETL", "ELT",
      "migration", "platform", "tech stack", "Airflow", "Spark",
      "Kafka", "streaming", "cloud migration", "AWS", "GCP", "Azure",
      "infrastructure", "architecture", "data engineering",
    ],
    phrases: [
      /(?:modernize|upgrade|consolidate|migrate)\s+(?:data\s+)?(?:platform|stack|infrastructure)/gi,
      /(?:select|evaluate|implement)\s+(?:new\s+)?(?:data|analytics)\s+(?:platform|tool|stack)/gi,
      /(?:build|architect|design)\s+(?:a\s+)?(?:modern|scalable|enterprise)\s+data\s+(?:platform|stack|infrastructure|architecture)/gi,
      /cloud\s+(?:migration|transformation|adoption)/gi,
    ],
  },
  cross_functional_influence: {
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
  team_scale_org_design: {
    keywords: [
      "team", "hire", "recruit", "scale", "grow", "build",
      "manage", "lead", "org", "organization", "pod", "distributed",
      "mentor", "develop", "career", "talent", "headcount",
      "direct reports", "matrix", "cross-functional", "org design",
    ],
    phrases: [
      /(?:build|grow|scale|lead|manage)\s+(?:a\s+)?(?:team|organization|function)\s+of\s+\d+/gi,
      /(?:hire|recruit|attract)\s+(?:and\s+retain\s+)?(?:top|senior|world.class)\s+(?:talent|people)/gi,
      /(?:lead|manage|oversee)\s+(?:a\s+)?(?:distributed|global|remote|matrixed)\s+(?:team|org)/gi,
      /\d+\+?\s+(?:direct\s+reports|team\s+members|FTEs|people)/gi,
    ],
  },
};

// ── Archetype Labels (display names) ────────────────────────────
const ARCHETYPE_LABELS: Record<string, string> = {
  operating_model_transformation: "Enterprise Operating Model Transformation",
  governance_standardization: "Governance & Metric Standardization",
  revenue_ops_forecasting: "Revenue Operations / Pipeline Analytics",
  insight_delivery_modernization: "Insight Delivery Modernization",
  ai_integration_llm: "AI Integration / LLM Enablement",
  bi_modernization: "BI Modernization",
  executive_okr_reporting: "Executive OKR Reporting",
  cross_functional_influence: "Cross-Functional Executive Influence",
  growth_monetization: "Growth & Monetization",
  team_scale_org_design: "Team Scale & Org Design",
};

// ── Seniority Detection ─────────────────────────────────────────
const SENIORITY_PATTERNS: { level: MandateProfile["seniority_level"]; patterns: RegExp[] }[] = [
  { level: "C-Suite", patterns: [/\bC[A-Z]O\b/, /\bChief\s+\w+\s+Officer\b/i, /\bSVP.*(?:&|and).*VP\b/i] },
  { level: "SVP", patterns: [/\bSVP\b/, /\bSenior\s+Vice\s+President\b/i, /\bEVP\b/, /\bExecutive\s+Vice\s+President\b/i] },
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
    if (titleNorm.includes("head of")) {
      return title; // Use the actual JD title
    }
    return HEADLINE_MAP[seniority][0];
  }

  return HEADLINE_MAP[seniority]?.[0] || "Data & Analytics Executive";
}

// ── Tone Calibration ────────────────────────────────────────────
function getToneGuidance(seniority: MandateProfile["seniority_level"], title: string): ToneGuidance {
  if (seniority === "C-Suite") {
    return {
      seniority: "C-Suite",
      summary_posture: "Board-level strategic framing. Open with enterprise-scale impact and fiduciary language. Emphasize value creation, organizational transformation, and strategic advisory.",
      bullet_framing: "Frame bullets as enterprise outcomes, not functional tasks. Lead with P&L impact, board decisions influenced, or organizational transformations delivered.",
      competency_emphasis: "Elevate to: Enterprise Strategy, Board Advisory, Organizational Transformation, P&L Ownership, Digital Transformation, Capital Allocation.",
      headline_tone: "Chief-level: 'Chief Data & Analytics Officer' or 'Chief Analytics Officer'. Board-ready positioning.",
    };
  }

  if (seniority === "SVP") {
    return {
      seniority: "SVP/EVP",
      summary_posture: "Enterprise transformation + scale. Emphasize cross-BU impact, large team leadership, and modernization narratives. Show both strategic vision and execution at scale.",
      bullet_framing: "Frame bullets as transformation milestones: what was built, what was scaled, what was modernized. Lead with enterprise-wide impact.",
      competency_emphasis: "Enterprise Data Strategy, Organizational Transformation, Revenue Optimization, AI/ML Strategy at Scale, Cross-Functional Leadership.",
      headline_tone: "SVP-level: 'SVP, Enterprise Data & Analytics'. Emphasize enterprise scope.",
    };
  }

  if (seniority === "VP") {
    return {
      seniority: "VP",
      summary_posture: "Strategic leader with operational depth. Balance transformation narrative with hands-on technical credibility. Show both vision and execution.",
      bullet_framing: "Lead with transformation outcomes and team-building results. Second bullets can show technical depth. Avoid purely tactical framing.",
      competency_emphasis: "Data Strategy, Team Building & Scaling, Platform Modernization, Revenue Analytics, Executive Stakeholder Management.",
      headline_tone: "VP-level: 'VP, Data & Analytics'. Match actual title — do not inflate to SVP or C-suite.",
    };
  }

  if (seniority === "Sr Director") {
    return {
      seniority: "Sr Director / Head of",
      summary_posture: "Strategic operator-builder. Show the arc from building teams to driving measurable business outcomes. Balance strategy with execution proof points.",
      bullet_framing: "Frame as a strategic operator: what was designed, what was delivered, what impact was measured. Show both leadership and hands-on credibility.",
      competency_emphasis: "Analytics Strategy, Team Building, Data Governance, BI Modernization, Stakeholder Management, Cross-Functional Leadership.",
      headline_tone: "Sr Director or 'Head of' framing. Do NOT use VP, SVP, or C-suite titles.",
    };
  }

  // Default: Director-level
  return {
    seniority: "Director",
    summary_posture: "Execution-oriented leader with growing strategic scope. Emphasize what was built and what results were delivered. Show readiness for the next level.",
    bullet_framing: "Lead with built/delivered/created language. Show measurable outcomes. Demonstrate cross-functional partnership.",
    competency_emphasis: "Analytics Leadership, Data Platform Management, Cross-Functional Partnership, Team Development, Business Impact Delivery.",
    headline_tone: "Director-level framing. Match actual title precisely.",
  };
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

    const label = ARCHETYPE_LABELS[dimId] || dimId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    dimensions.push({
      id: dimId,
      label,
      weight: Math.round(score * 100) / 100,
      score_0_5: Math.round(score * 5 * 10) / 10,
      signal_phrases: matched,
      description: getDescription(dimId),
    });
  }

  // Sort by weight descending
  dimensions.sort((a, b) => b.weight - a.weight);

  const primary = dimensions[0]?.id || "team_scale_org_design";
  const secondary = dimensions
    .slice(1)
    .filter((d) => d.weight >= 0.2)
    .map((d) => d.id)
    .slice(0, 2);

  const top3 = dimensions.slice(0, 3).map((d) => ({
    id: d.id,
    label: d.label,
    score: d.score_0_5,
  }));

  const seniority = detectSeniority(jdText, title);
  const topDimIds = dimensions.filter((d) => d.weight >= 0.3).map((d) => d.id);
  const headline = calibrateHeadline(seniority, topDimIds, title);
  const tone = getToneGuidance(seniority, title);

  return {
    dimensions,
    primary_mandate: primary,
    secondary_mandates: secondary,
    top_3_archetypes: top3,
    seniority_level: seniority,
    calibrated_headline: headline,
    tone_guidance: tone,
    gaps_vs_inventory: [],
  };
}

function getDescription(dimId: string): string {
  const desc: Record<string, string> = {
    operating_model_transformation: "Redesigning how analytics/data operates — from centralized dashboards to embedded, self-service, or product-oriented models",
    governance_standardization: "Establishing data governance, metric definitions, quality frameworks, and compliance programs",
    revenue_ops_forecasting: "Revenue analytics, demand forecasting, pricing optimization, and commercial analytics",
    insight_delivery_modernization: "Modernizing insight delivery — self-service analytics, automated reporting, stakeholder enablement",
    ai_integration_llm: "AI/ML integration, LLM enablement, GenAI strategy, responsible AI governance, MLOps",
    bi_modernization: "BI platform modernization, data warehouse migration, cloud infrastructure, data architecture",
    executive_okr_reporting: "Executive OKR/KPI reporting frameworks, board-level dashboards, strategic performance management",
    cross_functional_influence: "Cross-functional executive influence, C-suite advisory, strategic storytelling, change management",
    growth_monetization: "Growth analytics, experimentation/A/B testing, conversion optimization, and monetization strategy",
    team_scale_org_design: "Building, scaling, and managing analytics teams — hiring, mentoring, org design",
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

// ── Bullet Reordering Per Role ──────────────────────────────────
export interface ReorderedRole {
  experience_id: string;
  employer: string;
  title: string;
  ordered_bullets: ScoredBullet[];
  dropped_bullets: { bullet: ScoredBullet; reason: string }[];
}

/**
 * Reorder bullets WITHIN each role so highest mandate alignment appears first.
 * Optionally drop the lowest 20% of mandate-mismatched bullets when space-constrained.
 */
export function reorderBulletsPerRole(
  inventory: Record<string, any>,
  scoredBullets: ScoredBullet[],
  options: { dropLowest20Percent?: boolean; maxBulletsPerRole?: Record<string, number> } = {},
): ReorderedRole[] {
  const roles: ReorderedRole[] = [];

  for (const exp of inventory.experience || []) {
    const roleBullets = scoredBullets
      .filter((b) => b.experience_id === exp.id)
      .sort((a, b) => b.total_relevance - a.total_relevance);

    const maxBullets = options.maxBulletsPerRole?.[exp.id] ?? roleBullets.length;
    const dropCount = options.dropLowest20Percent
      ? Math.floor(roleBullets.length * 0.2)
      : 0;

    const keepCount = Math.min(maxBullets, roleBullets.length - dropCount);
    const ordered = roleBullets.slice(0, keepCount);
    const dropped = roleBullets.slice(keepCount).map((b) => ({
      bullet: b,
      reason: b.total_relevance === 0
        ? "No mandate relevance — does not align with any job archetype"
        : `Low mandate relevance (score ${b.total_relevance.toFixed(3)}) — below top ${keepCount} for this role`,
    }));

    roles.push({
      experience_id: exp.id,
      employer: exp.employer,
      title: exp.title,
      ordered_bullets: ordered,
      dropped_bullets: dropped,
    });
  }

  return roles;
}

// ── Mandate Gaps ────────────────────────────────────────────────
export function identifyMandateGaps(
  mandate: MandateProfile,
  scoredBullets: ScoredBullet[],
): { dimension_id: string; label: string; weight: number; best_coverage: number; suggestion: string }[] {
  const gaps: { dimension_id: string; label: string; weight: number; best_coverage: number; suggestion: string }[] = [];

  for (const dim of mandate.dimensions) {
    if (dim.weight < 0.2) continue;

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
        suggestion: `No strong inventory evidence for "${dim.label}". Consider: (a) omit, (b) rephrase closest transferable bullet to emphasize this angle without adding new facts, or (c) add to gap_notes for candidate clarification.`,
      });
    }
  }

  return gaps;
}

// ── Gap Analysis with Conservative Phrasing ─────────────────────
export interface GapAnalysisResult {
  requirement: string;
  in_ledger: boolean;
  closest_match?: string;
  conservative_phrasing?: string;
  clarification_question?: string;
}

/**
 * For each JD requirement, check if the claims ledger supports it.
 * If not, suggest conservative (transferable) phrasing instead of fabricating.
 */
export function analyzeRequirementGaps(
  requirements: string[],
  inventory: Record<string, any>,
): GapAnalysisResult[] {
  const results: GapAnalysisResult[] = [];
  const allBulletText = (inventory.experience || [])
    .flatMap((e: any) => (e.bullets || []).map((b: any) => b.text?.toLowerCase() || ""))
    .join(" ");
  const allTools = (inventory.experience || [])
    .flatMap((e: any) => (e.bullets || []).flatMap((b: any) => (b.tools || []).map((t: string) => t.toLowerCase())));
  const skillsFlat = Object.values(inventory.skills || {})
    .flat()
    .map((s: any) => (typeof s === "string" ? s.toLowerCase() : ""));

  for (const req of requirements) {
    const reqLower = req.toLowerCase();
    const words = reqLower.split(/\s+/).filter((w) => w.length > 3);

    // Check if requirement keywords appear in inventory
    let matchCount = 0;
    let bestMatch = "";
    for (const word of words) {
      if (allBulletText.includes(word) || allTools.includes(word) || skillsFlat.includes(word)) {
        matchCount++;
      }
    }

    // Find closest matching bullet
    let bestBulletScore = 0;
    for (const exp of inventory.experience || []) {
      for (const bullet of exp.bullets || []) {
        const text = (bullet.text || "").toLowerCase();
        let score = 0;
        for (const word of words) {
          if (text.includes(word)) score++;
        }
        if (score > bestBulletScore) {
          bestBulletScore = score;
          bestMatch = bullet.text;
        }
      }
    }

    const inLedger = matchCount >= Math.ceil(words.length * 0.4);

    const result: GapAnalysisResult = { requirement: req, in_ledger: inLedger };

    if (!inLedger) {
      if (bestMatch) result.closest_match = bestMatch;

      // Generate conservative phrasing
      if (reqLower.includes("salesforce") || reqLower.includes("crm")) {
        result.conservative_phrasing = "Partnered with CRM and commercial systems teams to deliver integrated analytics";
        result.clarification_question = "Have you worked directly with Salesforce or other CRM platforms? If so, in what capacity?";
      } else if (reqLower.includes("tableau") || reqLower.includes("looker") || reqLower.includes("power bi")) {
        const tool = req.match(/Tableau|Looker|Power BI/i)?.[0] || "BI platform";
        result.conservative_phrasing = `Led BI platform evaluation and modernization initiatives`;
        result.clarification_question = `What is your hands-on experience with ${tool}? Did you use it, evaluate it, or manage teams using it?`;
      } else {
        result.conservative_phrasing = `Experience with adjacent capabilities in this domain`;
        result.clarification_question = `Can you provide specific examples of your experience with: ${req}?`;
      }
    }

    results.push(result);
  }

  return results;
}

// ── Cross-Resume Divergence Check ───────────────────────────────
export interface DivergenceReport {
  summary_divergence_pct: number;
  competency_divergence_pct: number;
  bullet_reorder_count: number;
  tone_shifted: boolean;
  sufficient_divergence: boolean;
  issues: string[];
  recommendations: string[];
}

/**
 * Compare two tailored resumes to check if they are meaningfully different.
 * Flags insufficient customization if divergence < 40%.
 */
export function checkResumeDivergence(
  resumeA: { professional_summary: string; core_competencies?: string[]; experience: { bullets: { text: string }[] }[] },
  resumeB: { professional_summary: string; core_competencies?: string[]; experience: { bullets: { text: string }[] }[] },
): DivergenceReport {
  const issues: string[] = [];
  const recommendations: string[] = [];

  // 1. Summary divergence (word-level Jaccard distance)
  const wordsA = new Set(resumeA.professional_summary.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(resumeB.professional_summary.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  const summaryDivergence = union.size > 0 ? Math.round((1 - intersection.size / union.size) * 100) : 0;

  // 2. Competency divergence
  const compsA = new Set((resumeA.core_competencies || []).map((c) => c.toLowerCase()));
  const compsB = new Set((resumeB.core_competencies || []).map((c) => c.toLowerCase()));
  const compIntersection = new Set([...compsA].filter((c) => compsB.has(c)));
  const compUnion = new Set([...compsA, ...compsB]);
  const compDivergence = compUnion.size > 0 ? Math.round((1 - compIntersection.size / compUnion.size) * 100) : 0;

  // 3. Bullet reorder count (how many roles have different top-2 bullets)
  let reorderCount = 0;
  const minRoles = Math.min(resumeA.experience.length, resumeB.experience.length);
  for (let i = 0; i < minRoles; i++) {
    const topA = resumeA.experience[i].bullets.slice(0, 2).map((b) => b.text?.toLowerCase() || "");
    const topB = resumeB.experience[i].bullets.slice(0, 2).map((b) => b.text?.toLowerCase() || "");
    if (topA[0] !== topB[0] || topA[1] !== topB[1]) reorderCount++;
  }

  // 4. Tone shift check (simple heuristic: summary opening differs)
  const firstSentenceA = resumeA.professional_summary.split(/[.!?]/)[0]?.trim().toLowerCase() || "";
  const firstSentenceB = resumeB.professional_summary.split(/[.!?]/)[0]?.trim().toLowerCase() || "";
  const toneShifted = firstSentenceA !== firstSentenceB;

  // 5. Assess sufficiency
  const sufficientDivergence = summaryDivergence >= 40 && compDivergence >= 30;

  if (summaryDivergence < 40) {
    issues.push(`Summary divergence only ${summaryDivergence}% (target: ≥40%)`);
    recommendations.push("Reweight summary framing: lead with different mandate theme for each JD");
  }
  if (compDivergence < 30) {
    issues.push(`Competency divergence only ${compDivergence}% (target: ≥30%)`);
    recommendations.push("Adjust competency clusters to match each JD's top archetype keywords");
  }
  if (reorderCount < Math.ceil(minRoles * 0.5)) {
    issues.push(`Only ${reorderCount}/${minRoles} roles have different top-2 bullets`);
    recommendations.push("Reorder bullets per role based on mandate archetype weights");
  }
  if (!toneShifted) {
    issues.push("Summary opening sentence is identical across both resumes");
    recommendations.push("Lead with different identity framing per mandate (e.g., 'transformation architect' vs 'revenue analytics leader')");
  }

  return {
    summary_divergence_pct: summaryDivergence,
    competency_divergence_pct: compDivergence,
    bullet_reorder_count: reorderCount,
    tone_shifted: toneShifted,
    sufficient_divergence: sufficientDivergence,
    issues,
    recommendations,
  };
}
