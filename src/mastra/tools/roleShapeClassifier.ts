export type RoleShape = "A" | "B" | "C" | "D";

export interface RoleShapeResult {
  shape: RoleShape;
  confidence: number;
  label: string;
  reason: string;
  signals: {
    strategy: string[];
    engineering: string[];
    analytics: string[];
    leadership: string[];
  };
}

const STRATEGY_SIGNALS = [
  "ai strategy",
  "data strategy",
  "roadmap",
  "operating model",
  "business value",
  "digital transformation",
  "transformation",
  "adoption",
  "portfolio",
  "executive stakeholders",
  "board",
  "roi",
  "strategic vision",
  "strategic direction",
  "go-to-market",
  "innovation agenda",
  "center of excellence",
  "coe",
  "change management",
  "enterprise-wide",
  "enterprise wide",
  "cross-functional",
];

const ENGINEERING_SIGNALS = [
  "agentic",
  "autonomous agents",
  "ci/cd",
  "pipelines",
  "mlops",
  "deployment",
  "monitoring",
  "infra",
  "infrastructure",
  "architect",
  "software engineering",
  "platform",
  "latency",
  "slas",
  "kubernetes",
  "devops",
  "model serving",
  "feature store",
  "vector database",
  "embeddings pipeline",
  "system design",
  "microservices",
  "api design",
  "scalability",
  "distributed systems",
];

const ANALYTICS_SIGNALS = [
  "dashboards",
  "reporting",
  "business intelligence",
  "bi ",
  "kpis",
  "metrics",
  "tableau",
  "power bi",
  "looker",
  "data visualization",
  "self-service analytics",
  "self service analytics",
  "ad-hoc analysis",
  "descriptive analytics",
  "executive reporting",
  "data catalog",
  "data governance",
  "data quality",
];

const LEADERSHIP_SIGNALS = [
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
  "hire",
  "recruit",
  "mentor",
  "culture",
  "talent",
];

const SHAPE_LABELS: Record<RoleShape, string> = {
  A: "Strategy-Led AI/Data Leadership",
  B: "Hybrid Strategy + Engineering",
  C: "Analytics/BI Leadership",
  D: "Engineering/Platform/IC-Heavy",
};

function countHits(text: string, signals: string[]): string[] {
  return signals.filter((s) => text.includes(s)).sort();
}

export function classifyRoleShape(
  job: { title?: string; jd_raw_text?: string },
): RoleShapeResult {
  const jd = (job.jd_raw_text || "").toLowerCase();
  const title = (job.title || "").toLowerCase();
  const combined = `${title} ${jd}`;

  const stratHits = countHits(combined, STRATEGY_SIGNALS);
  const engHits = countHits(combined, ENGINEERING_SIGNALS);
  const analyticsHits = countHits(combined, ANALYTICS_SIGNALS);
  const leaderHits = countHits(combined, LEADERSHIP_SIGNALS);

  const S = stratHits.length;
  const E = engHits.length;
  const A = analyticsHits.length;
  const L = leaderHits.length;
  const total = S + E + A + Math.min(L, 5);

  let shape: RoleShape;
  let confidence: number;
  const reasons: string[] = [];

  if (S >= 4 && E <= 2 && L >= 3) {
    shape = "A";
    confidence = Math.min(1, 0.5 + (S / 10) + (L / 15));
    reasons.push(`Strong strategy signals (${S}) with leadership (${L}) and minimal engineering (${E})`);
  } else if (S >= 3 && E >= 3) {
    shape = "B";
    const balance = Math.abs(S - E);
    confidence = Math.min(1, 0.5 + (Math.min(S, E) / 8) - (balance / 20));
    reasons.push(`Mixed strategy (${S}) and engineering (${E}) signals — hybrid ownership`);
  } else if (E >= 5 && S <= 2) {
    shape = "D";
    confidence = Math.min(1, 0.5 + (E / 10));
    reasons.push(`Heavy engineering signals (${E}) with minimal strategy (${S})`);
  } else if (E >= 3 && S <= 1 && L <= 2) {
    shape = "D";
    confidence = Math.min(1, 0.4 + (E / 12));
    reasons.push(`Engineering-leaning (${E}) with weak leadership (${L}) and minimal strategy (${S})`);
  } else if (A >= 4 && E <= 1 && S <= 2) {
    shape = "C";
    confidence = Math.min(1, 0.5 + (A / 10));
    reasons.push(`Analytics/BI-focused (${A}) with limited AI/strategy scope (${S})`);
  } else if (A >= 2 && S <= 1 && E <= 1) {
    shape = "C";
    confidence = Math.min(1, 0.35 + (A / 12));
    reasons.push(`Analytics-leaning (${A}) with low strategy (${S}) and engineering (${E})`);
  } else if (S >= 2 && E <= 1 && L >= 2) {
    shape = "A";
    confidence = Math.min(1, 0.35 + (S / 10) + (L / 15));
    reasons.push(`Moderate strategy (${S}) with leadership (${L}), minimal engineering (${E})`);
  } else if (S === 0 && E === 0 && A === 0) {
    shape = "C";
    confidence = 0.2;
    reasons.push("Insufficient signals to classify — defaulting to C (generic analytics)");
  } else {
    if (S >= E && S >= A) {
      shape = "A";
      confidence = Math.min(1, 0.3 + (S / 12));
      reasons.push(`Weak but strategy-leaning (S=${S}, E=${E}, A=${A})`);
    } else if (E > S && E > A) {
      shape = "D";
      confidence = Math.min(1, 0.3 + (E / 12));
      reasons.push(`Weak but engineering-leaning (S=${S}, E=${E}, A=${A})`);
    } else {
      shape = "C";
      confidence = Math.min(1, 0.3 + (A / 12));
      reasons.push(`Weak but analytics-leaning (S=${S}, E=${E}, A=${A})`);
    }
  }

  confidence = Math.round(confidence * 100) / 100;

  reasons.push(`Signals: strategy=${S}, engineering=${E}, analytics=${A}, leadership=${L}`);

  return {
    shape,
    confidence,
    label: SHAPE_LABELS[shape],
    reason: reasons.join(". "),
    signals: {
      strategy: stratHits.slice(0, 5),
      engineering: engHits.slice(0, 5),
      analytics: analyticsHits.slice(0, 5),
      leadership: leaderHits.slice(0, 5),
    },
  };
}
