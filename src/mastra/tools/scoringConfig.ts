export type ScoringMode = "precision" | "recall";

export interface ScoringWeights {
  role_level_match: number;
  leadership_scope: number;
  domain_relevance: number;
  ai_strategy_stack: number;
  ai_engineering_stack: number;
  location_fit: number;
  compensation: number;
  transformation_mandate: number;
  company_preference: number;
  execution_mode_match: { min: number; max: number };
  spec_inflation_penalty: { min: number; max: number };
}

export interface ScoringProfile {
  weights: ScoringWeights;
  dominanceAdjustment: number;
  label: string;
}

const PRECISION_WEIGHTS: ScoringWeights = {
  role_level_match: 20,
  leadership_scope: 15,
  domain_relevance: 8,
  ai_strategy_stack: 8,
  ai_engineering_stack: 7,
  location_fit: 8,
  compensation: 8,
  transformation_mandate: 12,
  company_preference: 5,
  execution_mode_match: { min: -20, max: 10 },
  spec_inflation_penalty: { min: -10, max: 0 },
};

const RECALL_WEIGHTS: ScoringWeights = {
  role_level_match: 20,
  leadership_scope: 12,
  domain_relevance: 5,
  ai_strategy_stack: 10,
  ai_engineering_stack: 10,
  location_fit: 5,
  compensation: 8,
  transformation_mandate: 10,
  company_preference: 5,
  execution_mode_match: { min: -10, max: 5 },
  spec_inflation_penalty: { min: -5, max: 0 },
};

export const SCORING_PROFILES: Record<ScoringMode, ScoringProfile> = {
  precision: {
    weights: PRECISION_WEIGHTS,
    dominanceAdjustment: -5,
    label: "Precision (strict fit)",
  },
  recall: {
    weights: RECALL_WEIGHTS,
    dominanceAdjustment: 0,
    label: "Recall (wider net)",
  },
};

export function getActiveMode(): ScoringMode {
  const env = (process.env.SCORING_MODE || "precision").toLowerCase();
  if (env === "recall") return "recall";
  return "precision";
}

export function getActiveProfile(): ScoringProfile {
  return SCORING_PROFILES[getActiveMode()];
}

export function getMaxPositiveScore(w: ScoringWeights): number {
  return (
    w.role_level_match +
    w.leadership_scope +
    w.domain_relevance +
    w.ai_strategy_stack +
    w.ai_engineering_stack +
    w.location_fit +
    w.compensation +
    w.transformation_mandate +
    w.company_preference +
    w.execution_mode_match.max
  );
}

export const AI_STRATEGY_TERMS = [
  "predictive modeling",
  "predictive analytics",
  "forecasting",
  "nlp",
  "natural language processing",
  "genai",
  "generative ai",
  "decisioning",
  "decision engine",
  "optimization",
  "experimentation",
  "a/b testing",
  "analytics platform",
  "analytics platforms",
  "machine learning",
  "deep learning",
  "statistical modeling",
];

export const AI_ENGINEERING_TERMS = [
  "mlops",
  "ci/cd",
  "deployment",
  "model deployment",
  "monitoring",
  "feature store",
  "feature stores",
  "vector db",
  "vector database",
  "embeddings pipeline",
  "embeddings pipelines",
  "orchestration",
  "infra",
  "infrastructure",
  "kubernetes",
  "docker",
  "model serving",
  "model registry",
];

export const SPEC_INFLATION_CONFIG = {
  advancedAITerms: [
    "agentic",
    "autonomous agents",
    "semantic search",
    "rag",
    "retrieval-augmented",
    "embeddings",
    "vector db",
    "vector database",
    "ci/cd automation",
    "mlops",
    "llmops",
    "copilots",
    "fine-tuning",
    "fine tuning",
    "prompt engineering",
    "langchain",
    "llamaindex",
    "multi-agent",
    "multi agent",
    "knowledge graph",
    "neural search",
  ],

  businessOutcomeTerms: [
    "revenue",
    "margin",
    "cost",
    "roi",
    "p&l",
    "growth",
    "retention",
    "fraud",
    "risk",
    "conversion",
    "operational efficiency",
    "profit",
    "earnings",
    "customer lifetime value",
    "churn",
    "market share",
    "pipeline",
    "bookings",
    "arpu",
    "unit economics",
  ],

  thresholds: {
    advancedDensity: { low: 2, med: 4, high: 6 },
    businessDensity: { low: 2, med: 4, high: 6 },
  },

  penalties: {
    highAdvLowBiz: -10,
    highAdvMedBiz: -5,
    medAdvLowBiz: -5,
    medAdvMedBiz: -2,
  },

  maxPenalty: -10,
};
