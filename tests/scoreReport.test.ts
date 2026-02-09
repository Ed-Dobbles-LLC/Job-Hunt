import { describe, it, expect } from "vitest";
import {
  scoreSingleJob,
  prettyPrintReport,
  type ScoreReport,
} from "../src/mastra/tools/scoreJobsTool";
import { SCORING_PROFILES } from "../src/mastra/tools/scoringConfig";

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

const ENG_HEAVY_JD = `
  Build and own the ML platform including MLOps, CI/CD, deployment pipelines,
  Kubernetes clusters, model serving, monitoring, latency SLAs, and DevOps.
  Architect feature stores, vector databases, embeddings pipelines, and
  autonomous agents. Own agentic AI-driven CI/CD automation with fine-tuning,
  prompt engineering, langchain, multi-agent orchestration, and knowledge graphs.
  Neural search and semantic search via RAG and retrieval-augmented generation.
`;

const STRATEGY_JD = `
  Define the enterprise AI roadmap and strategy. Drive business value through
  predictive analytics, NLP, and experimentation frameworks. Own the operating model
  for AI adoption across the portfolio. Present to executive stakeholders and the board.
  Deliver measurable ROI through transformation initiatives. Manage budget and P&L.
  Lead a team of 40+ across analytics, data science, and applied ML.
  Location: Remote. Compensation: $300,000 - $400,000.
  Revenue growth, retention, and customer lifetime value focus.
`;

describe("Score Report", () => {
  const precisionProfile = SCORING_PROFILES.precision;
  const recallProfile = SCORING_PROFILES.recall;

  describe("Report Structure: SVP Precision", () => {
    const svpJob = makeJob({
      title: "SVP, Data & AI",
      jd_raw_text: SVP_JD,
      location: "Chicago",
      remote_hybrid: "hybrid",
    });
    const svpResult = scoreSingleJob(svpJob, INVENTORY, precisionProfile);
    const r = svpResult.report;

    it("report.total matches return total", () => {
      expect(r.total).toBe(svpResult.total);
    });

    it("report.mode is precision", () => {
      expect(r.mode).toBe("precision");
    });

    it("report has 12 categories", () => {
      expect(Object.keys(r.categories).length).toBe(12);
    });

    it("categories in display order", () => {
      const expectedOrder = [
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
      ];
      expect(Object.keys(r.categories)).toEqual(expectedOrder);
    });
  });

  describe("SVP Precision Categories", () => {
    const svpJob = makeJob({
      title: "SVP, Data & AI",
      jd_raw_text: SVP_JD,
      location: "Chicago",
      remote_hybrid: "hybrid",
    });
    const svpResult = scoreSingleJob(svpJob, INVENTORY, precisionProfile);
    const r = svpResult.report;

    it("role_level_match score and maxPoints", () => {
      expect(r.categories.role_level_match.score).toBe(20);
      expect(r.categories.role_level_match.maxPoints).toBe(20);
      expect(r.categories.role_level_match.matchedPhrases).toEqual([
        "svp",
        "vp",
      ]);
    });

    it("leadership_scope phrases sorted and capped at 5", () => {
      expect(r.categories.leadership_scope.score).toBe(15);
      expect(r.categories.leadership_scope.matchedPhrases).toEqual([
        "board",
        "budget",
        "executive",
        "lead a team",
        "manage",
      ]);
    });

    it("ai_strategy_stack includes nlp", () => {
      expect(r.categories.ai_strategy_stack.score).toBe(8);
      expect(r.categories.ai_strategy_stack.matchedPhrases).toContain("nlp");
    });

    it("ai_engineering_stack score", () => {
      expect(r.categories.ai_engineering_stack.score).toBe(7);
    });

    it("location_fit score and phrases", () => {
      expect(r.categories.location_fit.score).toBe(8);
      expect(r.categories.location_fit.matchedPhrases).toEqual([
        "chicago",
        "hybrid",
      ]);
    });

    it("compensation score and phrases", () => {
      expect(r.categories.compensation.score).toBe(8);
      expect(r.categories.compensation.matchedPhrases).toEqual([
        "$350,000 - $450,000",
      ]);
    });

    it("dominance_adjustment score is 0", () => {
      expect(r.categories.dominance_adjustment.score).toBe(0);
    });
  });

  describe("SVP Precision Totals", () => {
    const svpJob = makeJob({
      title: "SVP, Data & AI",
      jd_raw_text: SVP_JD,
      location: "Chicago",
      remote_hybrid: "hybrid",
    });
    const svpResult = scoreSingleJob(svpJob, INVENTORY, precisionProfile);
    const r = svpResult.report;

    it("rawTotal matches breakdown", () => {
      expect(r.rawTotal).toBe(svpResult.breakdown._raw_total);
    });

    it("maxPossible is 101", () => {
      expect(r.maxPossible).toBe(101);
    });
  });

  describe("Engineering-Heavy VP (Penalties + Risk Flags)", () => {
    const engJob = makeJob({
      title: "VP of AI Platform",
      jd_raw_text: ENG_HEAVY_JD,
    });
    const engResult = scoreSingleJob(engJob, INVENTORY, precisionProfile);
    const er = engResult.report;

    it("has penalties", () => {
      expect(er.penalties.length).toBeGreaterThan(0);
    });

    it("dominance penalty present", () => {
      expect(er.penalties).toContainEqual({
        key: "dominance_adjustment",
        score: -5,
        reason: "Engineering stack exceeds strategy stack for VP+ role",
      });
    });

    it("execution_mode_match penalty exists and is negative", () => {
      const execPenalty = er.penalties.find(
        (p) => p.key === "execution_mode_match",
      );
      expect(execPenalty).toBeDefined();
      expect(execPenalty!.score).toBeLessThan(0);
    });

    it("spec_inflation_penalty exists", () => {
      const specPenalty = er.penalties.find(
        (p) => p.key === "spec_inflation_penalty",
      );
      expect(specPenalty).toBeDefined();
    });

    it("risk flags sorted and contain expected flags", () => {
      expect(er.riskFlags).toEqual([...er.riskFlags].sort());
      expect(er.riskFlags).toContain("Engineering-heavy AI execution expected");
      expect(er.riskFlags).toContain(
        "Engineering-heavy AI execution expected for a strategy-level title",
      );
      expect(er.riskFlags).toContain(
        "High buzzword density with weak business grounding",
      );
      expect(er.riskFlags).toContain(
        "No preferred location match (not Chicago/remote/hybrid)",
      );
    });
  });

  describe("Strategy-Led Role (No Penalties, No Risk Flags)", () => {
    const stratJob = makeJob({
      title: "VP of Data Strategy",
      jd_raw_text: STRATEGY_JD,
      location: "Remote",
    });
    const stratResult = scoreSingleJob(stratJob, INVENTORY, precisionProfile);
    const sr = stratResult.report;

    it("has zero penalties", () => {
      expect(sr.penalties.length).toBe(0);
    });

    it("has no engineering risk flags", () => {
      expect(sr.riskFlags.filter((f) => f.includes("Engineering")).length).toBe(
        0,
      );
    });

    it("has no buzzword flag", () => {
      expect(sr.riskFlags).not.toContain(
        "High buzzword density with weak business grounding",
      );
    });
  });

  describe("Recall Mode Differences", () => {
    const svpJob = makeJob({
      title: "SVP, Data & AI",
      jd_raw_text: SVP_JD,
      location: "Chicago",
      remote_hybrid: "hybrid",
    });

    it("recall report mode and maxPossible", () => {
      const svpRecall = scoreSingleJob(svpJob, INVENTORY, recallProfile);
      expect(svpRecall.report.mode).toBe("recall");
      expect(svpRecall.report.maxPossible).toBe(90);
    });

    it("recall mode: no dominance penalty", () => {
      const engJob = makeJob({
        title: "VP of AI Platform",
        jd_raw_text: ENG_HEAVY_JD,
      });
      const engRecall = scoreSingleJob(engJob, INVENTORY, recallProfile);
      const engRecallDom = engRecall.report.penalties.find(
        (p) => p.key === "dominance_adjustment",
      );
      expect(engRecallDom).toBeUndefined();
    });
  });

  describe("Empty JD", () => {
    const emptyJob = makeJob({ title: "Unknown", jd_raw_text: "" });
    const emptyResult = scoreSingleJob(emptyJob, INVENTORY, precisionProfile);
    const emptyR = emptyResult.report;

    it("total >= 0", () => {
      expect(emptyR.total).toBeGreaterThanOrEqual(0);
    });

    it("all category phrases are arrays", () => {
      expect(
        Object.values(emptyR.categories).every((c) =>
          Array.isArray(c.matchedPhrases),
        ),
      ).toBe(true);
    });

    it("location risk flag present", () => {
      expect(emptyR.riskFlags).toContain(
        "No preferred location match (not Chicago/remote/hybrid)",
      );
    });
  });

  describe("Pretty Print", () => {
    const engJob = makeJob({
      title: "VP of AI Platform",
      jd_raw_text: ENG_HEAVY_JD,
    });
    const engResult = scoreSingleJob(engJob, INVENTORY, precisionProfile);
    const stratJob = makeJob({
      title: "VP of Data Strategy",
      jd_raw_text: STRATEGY_JD,
      location: "Remote",
    });
    const stratResult = scoreSingleJob(stratJob, INVENTORY, precisionProfile);

    it("contains expected sections", () => {
      const pretty = prettyPrintReport(
        engResult.report,
        "VP of AI Platform @ TestCorp",
      );
      expect(pretty).toContain("SCORE REPORT");
      expect(pretty).toContain("CATEGORY BREAKDOWN");
      expect(pretty).toContain("PENALTIES APPLIED");
      expect(pretty).toContain("RISK FLAGS");
      expect(pretty).toContain("VP of AI Platform @ TestCorp");
    });

    it("strategy pretty has no PENALTIES section", () => {
      const prettyNoRisk = prettyPrintReport(
        stratResult.report,
        "VP of Data Strategy",
      );
      expect(prettyNoRisk).not.toContain("PENALTIES APPLIED");
    });
  });
});
