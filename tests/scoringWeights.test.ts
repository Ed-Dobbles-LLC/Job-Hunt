import { describe, it, expect } from "vitest";
import {
  scoreSingleJob,
  scoreAIStrategyStack,
  scoreAIEngineeringStack,
} from "../src/mastra/tools/scoreJobsTool";
import {
  SCORING_PROFILES,
  getMaxPositiveScore,
} from "../src/mastra/tools/scoringConfig";

function makeJob(
  overrides: Partial<{
    title: string;
    jd_raw_text: string;
    location: string;
    remote_hybrid: string;
  }>,
) {
  return {
    title: overrides.title || "Data Analyst",
    jd_raw_text: overrides.jd_raw_text || "",
    location: overrides.location || "",
    remote_hybrid: overrides.remote_hybrid || "",
  };
}

const INVENTORY = {
  skills: {
    domains: ["Financial Services", "Healthcare"],
    technical: ["Python", "SQL", "Snowflake", "Tableau"],
    data_science: ["Machine Learning", "NLP"],
  },
};

const SVP_JD = `
  As SVP of Data & AI, you will lead the enterprise AI strategy including
  predictive modeling, NLP, and generative AI initiatives. You will also manage
  CI/CD pipelines for model deployment, Kubernetes orchestration, monitoring, and
  MLOps infrastructure. Drive transformation across the organization, present to
  the board, own the P&L, and deliver measurable ROI through analytics platforms.
  Build and lead a team of 30+ across data science, analytics engineering, and ML ops.
  Budget ownership. Executive stakeholder management. Fortune 500 experience preferred.
  Location: Chicago (hybrid). Compensation: $350,000 - $450,000.
`;

describe("Scoring Weights & Normalization", () => {
  const precisionProfile = SCORING_PROFILES.precision;
  const recallProfile = SCORING_PROFILES.recall;

  describe("AI Strategy Stack Sub-Score", () => {
    it("finds strategy terms", () => {
      const result = scoreAIStrategyStack(
        "We use predictive modeling, NLP, generative AI, and experimentation frameworks with analytics platforms",
        8,
      );
      expect(result.hits.length).toBeGreaterThanOrEqual(3);
      expect(result.score).toBeLessThanOrEqual(8);
    });

    it("returns zero for no terms", () => {
      const result = scoreAIStrategyStack("Just basic SQL reporting", 8);
      expect(result.score).toBe(0);
    });
  });

  describe("AI Engineering Stack Sub-Score", () => {
    it("finds engineering terms", () => {
      const result = scoreAIEngineeringStack(
        "MLOps CI/CD deployment monitoring Kubernetes docker model serving feature stores orchestration",
        7,
      );
      expect(result.hits.length).toBeGreaterThanOrEqual(4);
      expect(result.score).toBeLessThanOrEqual(7);
    });

    it("returns zero for no terms", () => {
      const result = scoreAIEngineeringStack("Executive strategy board ROI", 7);
      expect(result.score).toBe(0);
    });
  });

  describe("Dominance Check (Engineering > Strategy for VP+)", () => {
    it("VP eng-heavy gets dominance penalty", () => {
      const vpEngHeavy = makeJob({
        title: "VP of AI Platform",
        jd_raw_text:
          "MLOps CI/CD deployment monitoring kubernetes docker model serving feature stores orchestration",
      });
      const result = scoreSingleJob(vpEngHeavy, INVENTORY, precisionProfile);
      expect(result.breakdown.dominance_adjustment).toBe(-5);
    });

    it("Director eng-heavy gets NO dominance penalty", () => {
      const dirEngHeavy = makeJob({
        title: "Director of ML Engineering",
        jd_raw_text:
          "MLOps CI/CD deployment monitoring kubernetes docker model serving feature stores",
      });
      const result = scoreSingleJob(dirEngHeavy, INVENTORY, precisionProfile);
      expect(result.breakdown.dominance_adjustment).toBe(0);
    });

    it("VP strategy-heavy gets NO dominance penalty", () => {
      const vpStratHeavy = makeJob({
        title: "VP of Data Strategy",
        jd_raw_text:
          "predictive modeling NLP generative AI experimentation analytics platforms forecasting optimization",
      });
      const result = scoreSingleJob(vpStratHeavy, INVENTORY, precisionProfile);
      expect(result.breakdown.dominance_adjustment).toBe(0);
    });
  });

  describe("Recall Mode: Dominance Penalty Disabled", () => {
    it("VP eng-heavy in recall mode: no dominance penalty", () => {
      const vpEngHeavy = makeJob({
        title: "VP of AI Platform",
        jd_raw_text:
          "MLOps CI/CD deployment monitoring kubernetes docker model serving feature stores orchestration",
      });
      const result = scoreSingleJob(vpEngHeavy, INVENTORY, recallProfile);
      expect(result.breakdown.dominance_adjustment).toBe(0);
    });
  });

  describe("Normalization to 0-100", () => {
    it("SVP precision score in 0-100 range", () => {
      const svpJob = makeJob({
        title: "SVP, Data & AI",
        jd_raw_text: SVP_JD,
        location: "Chicago",
        remote_hybrid: "hybrid",
      });
      const result = scoreSingleJob(svpJob, INVENTORY, precisionProfile);
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeLessThanOrEqual(100);
      expect(result.breakdown._raw_total).toBeDefined();
      expect(result.mode).toBe("precision");
    });

    it("SVP recall score in 0-100 range", () => {
      const svpJob = makeJob({
        title: "SVP, Data & AI",
        jd_raw_text: SVP_JD,
        location: "Chicago",
        remote_hybrid: "hybrid",
      });
      const result = scoreSingleJob(svpJob, INVENTORY, recallProfile);
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeLessThanOrEqual(100);
    });
  });

  describe("Score Clamping", () => {
    it("empty JD score is clamped to 0-100", () => {
      const emptyJob = makeJob({ title: "Unknown Role", jd_raw_text: "" });
      const result = scoreSingleJob(emptyJob, INVENTORY, precisionProfile);
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeLessThanOrEqual(100);
    });
  });

  describe("Max Positive Score Calculation", () => {
    it("precision max positive = 101", () => {
      expect(getMaxPositiveScore(precisionProfile.weights)).toBe(101);
    });

    it("recall max positive = 90", () => {
      expect(getMaxPositiveScore(recallProfile.weights)).toBe(90);
    });
  });
});
