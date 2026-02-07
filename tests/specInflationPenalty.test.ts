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

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(
    name: string,
    result: { score: number; reason: string; advancedCount: number; businessCount: number },
    expectedScoreRange: [number, number],
    expectAdvMin?: number,
    expectBizMin?: number,
  ) {
    const inRange =
      result.score >= expectedScoreRange[0] &&
      result.score <= expectedScoreRange[1];
    const advOk = expectAdvMin === undefined || result.advancedCount >= expectAdvMin;
    const bizOk = expectBizMin === undefined || result.businessCount >= expectBizMin;

    if (inRange && advOk && bizOk) {
      console.log(
        `  PASS: ${name} => score=${result.score} (expected ${expectedScoreRange[0]} to ${expectedScoreRange[1]}), adv=${result.advancedCount}, biz=${result.businessCount}`,
      );
      console.log(`        reason: "${result.reason}"`);
      passed++;
    } else {
      console.log(
        `  FAIL: ${name} => score=${result.score} (expected ${expectedScoreRange[0]} to ${expectedScoreRange[1]}), adv=${result.advancedCount}, biz=${result.businessCount}`,
      );
      console.log(`        reason: "${result.reason}"`);
      if (!inRange) console.log(`        ERROR: score out of range`);
      if (!advOk) console.log(`        ERROR: advancedCount below ${expectAdvMin}`);
      if (!bizOk) console.log(`        ERROR: businessCount below ${expectBizMin}`);
      failed++;
    }
  }

  console.log("\n=== SpecInflationPenalty Unit Tests ===\n");

  console.log("--- Case 1: High advanced + low business => big penalty ---");
  assert(
    "Buzzword-heavy, no business outcomes",
    computeSpecInflationPenalty(FIXTURES.highAdvLowBiz),
    [-10, -10],
    6,
  );

  console.log("\n--- Case 2: High advanced + high business => small/no penalty ---");
  assert(
    "Buzzwords grounded in business context",
    computeSpecInflationPenalty(FIXTURES.highAdvHighBiz),
    [-5, 0],
    6,
    6,
  );

  console.log("\n--- Case 3: Low advanced + high business => no penalty ---");
  assert(
    "Business-focused, minimal AI jargon",
    computeSpecInflationPenalty(FIXTURES.lowAdvHighBiz),
    [0, 0],
    undefined,
    6,
  );

  console.log("\n--- Case 4: Low everything => no penalty ---");
  assert(
    "Generic role, no buzzwords or outcomes",
    computeSpecInflationPenalty(FIXTURES.lowAdvLowBiz),
    [0, 0],
  );

  console.log("\n--- Case 5: Med advanced + low business => moderate penalty ---");
  assert(
    "Moderate AI terms, no business grounding",
    computeSpecInflationPenalty(FIXTURES.medAdvLowBiz),
    [-5, -5],
    4,
  );

  console.log("\n--- Case 6: Med advanced + high business => no penalty ---");
  assert(
    "Moderate AI terms well-grounded in business outcomes",
    computeSpecInflationPenalty(FIXTURES.medAdvMedBiz),
    [0, 0],
    4,
    6,
  );

  console.log("\n--- Case 7: SVP Data & AI with semantic search + CI/CD (example output) ---");
  const svpResult = computeSpecInflationPenalty(FIXTURES.svpWithCicdAndSearch);
  assert(
    "SVP with semantic search + CI/CD language",
    svpResult,
    [-10, -5],
    6,
  );
  console.log(`\n  Example output for SVP Data & AI:`);
  console.log(`    Score: ${svpResult.score}`);
  console.log(`    Advanced AI terms found: ${svpResult.advancedCount}`);
  console.log(`    Business outcome terms found: ${svpResult.businessCount}`);
  console.log(`    Reason: ${svpResult.reason}`);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
