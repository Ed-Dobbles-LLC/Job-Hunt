import { describe, it, expect } from "vitest";
import { classifyExecutionMode } from "../src/mastra/tools/scoreJobsTool";

const FIXTURES = {
  positiveStrategyLed: `
    We are seeking a VP of Data & Analytics to own the enterprise AI roadmap and drive
    transformation across the organization. You will define the operating model for our
    analytics function, present strategy to executive stakeholders and the board, and
    measure ROI on all data initiatives. This leader will build a portfolio of AI use
    cases that deliver measurable business value and drive adoption across business units.
  `,
  positiveBusinessAcceleration: `
    As our Chief Data Officer, you will develop and execute a multi-year data strategy
    aligned to business goals. You will work closely with the board and C-suite to
    establish an operating model for data-driven decision making. You will drive AI
    adoption and own the analytics portfolio, measuring ROI and business value delivered.
    A key part of this role is transformation of legacy processes through modern analytics.
  `,
  positiveMixedLeanStrategy: `
    The Senior Director of Analytics will own the data strategy roadmap and drive adoption
    of ML models across product and marketing. You will present to executive stakeholders
    on business value delivered and partner with engineering on deployment timelines. Some
    exposure to monitoring dashboards expected.
  `,
  negativeMLOpsInfra: `
    We need a Head of ML Platform to own our MLOps infrastructure end-to-end. You will
    manage deployment pipelines, ensure SLAs for model serving latency, and maintain our
    Kubernetes clusters. You will build autonomous agents for CI/CD automation and own
    monitoring and alerting for all production models. DevOps experience required.
  `,
  negativeStaffEngineering: `
    As a Staff+ AI Engineer, you will build agentic AI systems and autonomous agents that
    drive our CI/CD pipelines. You own the platform for model deployment, including infra
    provisioning, latency optimization, and Kubernetes orchestration. Strong software
    engineering skills required. You will architect the core AI-driven CI/CD system and
    manage SLAs for all production services. DevOps and monitoring expertise a must.
  `,
  negativePlatformHeavy: `
    The Director of AI Platform will own our ML infrastructure stack. Responsibilities
    include building deployment pipelines for model serving, managing Kubernetes clusters,
    optimizing latency for real-time inference, and maintaining monitoring and alerting.
    You will architect our MLOps platform and work closely with DevOps to ensure
    reliability. Experience with infra-as-code and SLAs required.
  `,
};

describe("ExecutionModeMatch", () => {
  describe("Positive (Strategy-Led) Cases", () => {
    it("strategy-led AI transformation", () => {
      const result = classifyExecutionMode(FIXTURES.positiveStrategyLed);
      expect(result.score).toBeGreaterThanOrEqual(5);
      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("business acceleration / CDO role", () => {
      const result = classifyExecutionMode(
        FIXTURES.positiveBusinessAcceleration,
      );
      expect(result.score).toBeGreaterThanOrEqual(5);
      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("mixed but leans strategy", () => {
      const result = classifyExecutionMode(FIXTURES.positiveMixedLeanStrategy);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe("Negative (Engineering/Infra-Heavy) Cases", () => {
    it("MLOps/Infra ownership", () => {
      const result = classifyExecutionMode(FIXTURES.negativeMLOpsInfra);
      expect(result.score).toBeGreaterThanOrEqual(-20);
      expect(result.score).toBeLessThanOrEqual(-10);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("Staff+ engineering depth (agentic, CI/CD, agents)", () => {
      const result = classifyExecutionMode(FIXTURES.negativeStaffEngineering);
      expect(result.score).toBe(-20);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("platform-heavy AI Director", () => {
      const result = classifyExecutionMode(FIXTURES.negativePlatformHeavy);
      expect(result.score).toBeGreaterThanOrEqual(-20);
      expect(result.score).toBeLessThanOrEqual(-10);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe("Edge Cases", () => {
    it("empty JD returns neutral", () => {
      const result = classifyExecutionMode("");
      expect(result.score).toBe(0);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("generic neutral JD", () => {
      const result = classifyExecutionMode(
        "We are hiring a data analyst to join the team. SQL and Excel required.",
      );
      expect(result.score).toBe(0);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
