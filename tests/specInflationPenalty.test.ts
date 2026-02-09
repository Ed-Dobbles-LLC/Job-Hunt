import { describe, it, expect } from "vitest";
import { computeSpecInflationPenalty } from "../src/mastra/tools/scoreJobsTool";

const FIXTURES = {
  highAdvLowBiz: `
    We are building an agentic AI platform with autonomous agents powered by RAG pipelines,
    semantic search over vector databases, embeddings generation, LLMOps monitoring,
    fine-tuning workflows, and multi-agent orchestration using LangChain.
    The ideal candidate has deep experience with prompt engineering and knowledge graphs.
    Must be comfortable with CI/CD automation for model deployment.
  `,

  highAdvHighBiz: `
    We are building an agentic AI platform with autonomous agents powered by RAG pipelines,
    semantic search over vector databases, embeddings generation, and LLMOps monitoring.
    The VP will own the AI strategy that drives revenue growth, improves customer retention,
    reduces churn, increases conversion rates, and delivers measurable ROI. You will own the
    P&L for the data organization, optimize margins, and report on operational efficiency
    to the board.
  `,

  lowAdvHighBiz: `
    The SVP of Data & Analytics will lead a team focused on driving revenue growth,
    improving customer retention, reducing operational costs, and optimizing conversion rates.
    You will own the P&L for analytics, report on ROI to the board, manage risk models,
    and improve margin performance across all business units. Strong focus on fraud detection
    and unit economics.
  `,

  lowAdvLowBiz: `
    We are looking for a data analyst to join our team. You will work with SQL and Excel
    to create reports and dashboards. Good communication skills required.
  `,

  medAdvLowBiz: `
    Looking for a leader to build our RAG system, manage embeddings infrastructure,
    semantic search capabilities, and fine-tuning workflows. Must have vector DB experience.
    Good communication skills required.
  `,

  medAdvMedBiz: `
    Build our RAG system and semantic search platform with embeddings and fine-tuning.
    Drive revenue growth, improve retention, reduce cost, and measure ROI on all initiatives.
    Focus on churn reduction and margin improvement.
  `,

  svpWithCicdAndSearch: `
    As SVP of Data & AI, you will lead the enterprise AI strategy including semantic search
    capabilities and CI/CD automation for model deployment. You will drive revenue growth
    through predictive analytics and own embeddings pipelines for recommendation engines.
    Build RAG-powered copilots for internal teams. Manage multi-agent orchestration and
    fine-tuning workflows. Must deliver measurable ROI.
  `,
};

describe("SpecInflationPenalty", () => {
  it("big penalty for buzzword-heavy, no business outcomes", () => {
    const result = computeSpecInflationPenalty(FIXTURES.highAdvLowBiz);
    expect(result.score).toBeGreaterThanOrEqual(-10);
    expect(result.score).toBeLessThanOrEqual(-10);
    expect(result.advancedCount).toBeGreaterThanOrEqual(6);
  });

  it("small/no penalty for buzzwords grounded in business context", () => {
    const result = computeSpecInflationPenalty(FIXTURES.highAdvHighBiz);
    expect(result.score).toBeGreaterThanOrEqual(-5);
    expect(result.score).toBeLessThanOrEqual(0);
    expect(result.advancedCount).toBeGreaterThanOrEqual(6);
    expect(result.businessCount).toBeGreaterThanOrEqual(6);
  });

  it("no penalty for business-focused, minimal AI jargon", () => {
    const result = computeSpecInflationPenalty(FIXTURES.lowAdvHighBiz);
    expect(result.score).toBe(0);
    expect(result.businessCount).toBeGreaterThanOrEqual(6);
  });

  it("no penalty for generic role, no buzzwords or outcomes", () => {
    const result = computeSpecInflationPenalty(FIXTURES.lowAdvLowBiz);
    expect(result.score).toBe(0);
  });

  it("moderate penalty for moderate AI terms, no business grounding", () => {
    const result = computeSpecInflationPenalty(FIXTURES.medAdvLowBiz);
    expect(result.score).toBe(-5);
    expect(result.advancedCount).toBeGreaterThanOrEqual(4);
  });

  it("no penalty for moderate AI terms well-grounded in business outcomes", () => {
    const result = computeSpecInflationPenalty(FIXTURES.medAdvMedBiz);
    expect(result.score).toBe(0);
    expect(result.advancedCount).toBeGreaterThanOrEqual(4);
    expect(result.businessCount).toBeGreaterThanOrEqual(6);
  });

  it("SVP with semantic search + CI/CD gets penalty", () => {
    const result = computeSpecInflationPenalty(FIXTURES.svpWithCicdAndSearch);
    expect(result.score).toBeGreaterThanOrEqual(-10);
    expect(result.score).toBeLessThanOrEqual(-5);
    expect(result.advancedCount).toBeGreaterThanOrEqual(6);
  });
});
