import { describe, it, expect } from "vitest";
import { StrategicFitSchema } from "../src/mastra/tools/strategicFitAssessor";

describe("StrategicFitAssessor", () => {
  describe("Schema validation", () => {
    it("accepts a well-formed strategic fit assessment", () => {
      const assessment = {
        primary_mandate_problem: {
          jd_mandate: "Transform the analytics function from a reporting team to a strategic decision engine.",
          mapped_signature_problem: "sp-1" as const,
          mapping_confidence: 0.85,
          mapping_rationale: "The role explicitly calls for transforming analytics from tactical reporting to strategic decision-making, directly mapping to sp-1.",
        },
        proof_anchor_relevance: [
          { anchor_id: "pa-1", relevance: "direct" as const, rationale: "Diageo distribution program demonstrates enterprise decision enablement at scale." },
          { anchor_id: "pa-2", relevance: "adjacent" as const, rationale: "H&R Block pricing work shows C-suite advisory but in a different domain." },
          { anchor_id: "pa-3", relevance: "direct" as const, rationale: "The data waiter to decision engine transformation is exactly what this role needs." },
        ],
        narrative_fit: {
          transformation_thread_relevant: true,
          differentiator_match: true,
          fit_summary: "Strong strategic match. The role's core mandate to transform analytics from reporting to decision engine maps directly to the candidate's sp-1 signature problem. Two proof anchors provide direct evidence.",
        },
        strategic_score: 22,
        risk_notes: ["Role may expect deeper platform engineering than the candidate's proof anchors demonstrate."],
      };
      const result = StrategicFitSchema.safeParse(assessment);
      expect(result.success).toBe(true);
    });

    it("rejects assessment with invalid signature problem mapping", () => {
      const assessment = {
        primary_mandate_problem: {
          jd_mandate: "Build ML pipelines.",
          mapped_signature_problem: "sp-99", // invalid
          mapping_confidence: 0.5,
          mapping_rationale: "test",
        },
        proof_anchor_relevance: [],
        narrative_fit: {
          transformation_thread_relevant: false,
          differentiator_match: false,
          fit_summary: "test",
        },
        strategic_score: 5,
        risk_notes: [],
      };
      const result = StrategicFitSchema.safeParse(assessment);
      expect(result.success).toBe(false);
    });

    it("rejects assessment with score above 25", () => {
      const assessment = {
        primary_mandate_problem: {
          jd_mandate: "test",
          mapped_signature_problem: "sp-1" as const,
          mapping_confidence: 0.9,
          mapping_rationale: "test",
        },
        proof_anchor_relevance: [],
        narrative_fit: {
          transformation_thread_relevant: true,
          differentiator_match: true,
          fit_summary: "test",
        },
        strategic_score: 30, // exceeds max
        risk_notes: [],
      };
      const result = StrategicFitSchema.safeParse(assessment);
      expect(result.success).toBe(false);
    });

    it("rejects assessment with more than 3 risk notes", () => {
      const assessment = {
        primary_mandate_problem: {
          jd_mandate: "test",
          mapped_signature_problem: "none" as const,
          mapping_confidence: 0.3,
          mapping_rationale: "test",
        },
        proof_anchor_relevance: [],
        narrative_fit: {
          transformation_thread_relevant: false,
          differentiator_match: false,
          fit_summary: "test",
        },
        strategic_score: 3,
        risk_notes: ["risk 1", "risk 2", "risk 3", "risk 4"], // exceeds max 3
      };
      const result = StrategicFitSchema.safeParse(assessment);
      expect(result.success).toBe(false);
    });
  });

  describe("Integration with scoreSingleJob", () => {
    it("scorer works without strategic fit (defaults to 0)", async () => {
      const { scoreSingleJob } = await import("../src/mastra/tools/scoreJobsTool");
      const job = {
        title: "VP of Data & Analytics",
        jd_raw_text: "Lead the enterprise analytics transformation. Build a team. Present to board. P&L ownership.",
        location: "Chicago",
        remote_hybrid: "hybrid",
      };
      const inventory = {
        skills: {
          domains: ["Financial Services"],
          technical: ["Python", "Snowflake"],
          data_science: ["Machine Learning"],
        },
      };
      const result = scoreSingleJob(job, inventory);
      expect(result.breakdown.strategic_fit).toBe(0);
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeLessThanOrEqual(100);
    });

    it("scorer incorporates strategic fit when provided", async () => {
      const { scoreSingleJob } = await import("../src/mastra/tools/scoreJobsTool");
      const { SCORING_PROFILES } = await import("../src/mastra/tools/scoringConfig");

      const job = {
        title: "VP of Data & Analytics",
        jd_raw_text: "Lead the enterprise analytics transformation. Build a team. Present to board. P&L ownership.",
        location: "Chicago",
        remote_hybrid: "hybrid",
      };
      const inventory = {
        skills: {
          domains: ["Financial Services"],
          technical: ["Python", "Snowflake"],
          data_science: ["Machine Learning"],
        },
      };

      const mockAssessment = {
        primary_mandate_problem: {
          jd_mandate: "Transform analytics function.",
          mapped_signature_problem: "sp-1" as const,
          mapping_confidence: 0.85,
          mapping_rationale: "Direct match.",
        },
        proof_anchor_relevance: [
          { anchor_id: "pa-1", relevance: "direct" as const, rationale: "Relevant." },
        ],
        narrative_fit: {
          transformation_thread_relevant: true,
          differentiator_match: true,
          fit_summary: "Strong fit.",
        },
        strategic_score: 20,
        risk_notes: [],
      };

      const withFit = scoreSingleJob(job, inventory, SCORING_PROFILES.precision, undefined, mockAssessment);
      const withoutFit = scoreSingleJob(job, inventory, SCORING_PROFILES.precision, undefined, undefined);

      expect(withFit.breakdown.strategic_fit).toBeGreaterThan(0);
      expect(withoutFit.breakdown.strategic_fit).toBe(0);
      expect(withFit.total).toBeGreaterThanOrEqual(withoutFit.total);
    });

    it("strategic fit category appears in report", async () => {
      const { scoreSingleJob } = await import("../src/mastra/tools/scoreJobsTool");

      const mockAssessment = {
        primary_mandate_problem: {
          jd_mandate: "Build analytics.",
          mapped_signature_problem: "sp-2" as const,
          mapping_confidence: 0.7,
          mapping_rationale: "Adjacent.",
        },
        proof_anchor_relevance: [],
        narrative_fit: {
          transformation_thread_relevant: true,
          differentiator_match: false,
          fit_summary: "Moderate fit.",
        },
        strategic_score: 14,
        risk_notes: [],
      };

      const result = scoreSingleJob(
        { title: "Director Analytics", jd_raw_text: "analytics strategy", location: "", remote_hybrid: "" },
        { skills: { domains: [], technical: [], data_science: [] } },
        undefined,
        undefined,
        mockAssessment,
      );

      expect(result.report.categories.strategic_fit).toBeDefined();
      expect(result.report.categories.strategic_fit.matchedPhrases).toContain("Maps to: sp-2");
    });
  });
});
