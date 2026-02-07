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

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(
    name: string,
    result: { score: number; reason: string },
    expectedScoreRange: [number, number],
  ) {
    const inRange =
      result.score >= expectedScoreRange[0] &&
      result.score <= expectedScoreRange[1];
    const reasonPresent = result.reason.length > 0;

    if (inRange && reasonPresent) {
      console.log(
        `  PASS: ${name} → score=${result.score} (expected ${expectedScoreRange[0]} to ${expectedScoreRange[1]})`,
      );
      console.log(`        reason: "${result.reason}"`);
      passed++;
    } else {
      console.log(
        `  FAIL: ${name} → score=${result.score} (expected ${expectedScoreRange[0]} to ${expectedScoreRange[1]})`,
      );
      console.log(`        reason: "${result.reason}"`);
      if (!reasonPresent) console.log(`        ERROR: reason string is empty`);
      failed++;
    }
  }

  console.log("\n=== ExecutionModeMatch Unit Tests ===\n");

  console.log("--- Positive (Strategy-Led) Cases ---");

  assert(
    "Strategy-led AI transformation",
    classifyExecutionMode(FIXTURES.positiveStrategyLed),
    [5, 10],
  );

  assert(
    "Business acceleration / CDO role",
    classifyExecutionMode(FIXTURES.positiveBusinessAcceleration),
    [5, 10],
  );

  assert(
    "Mixed but leans strategy",
    classifyExecutionMode(FIXTURES.positiveMixedLeanStrategy),
    [0, 10],
  );

  console.log("\n--- Negative (Engineering/Infra-Heavy) Cases ---");

  assert(
    "MLOps/Infra ownership",
    classifyExecutionMode(FIXTURES.negativeMLOpsInfra),
    [-20, -10],
  );

  assert(
    "Staff+ engineering depth (agentic, CI/CD, agents)",
    classifyExecutionMode(FIXTURES.negativeStaffEngineering),
    [-20, -20],
  );

  assert(
    "Platform-heavy AI Director",
    classifyExecutionMode(FIXTURES.negativePlatformHeavy),
    [-20, -10],
  );

  console.log("\n--- Edge Cases ---");

  const emptyResult = classifyExecutionMode("");
  assert("Empty JD → neutral", emptyResult, [0, 0]);

  const neutralJD =
    "We are hiring a data analyst to join the team. SQL and Excel required.";
  assert("Generic neutral JD", classifyExecutionMode(neutralJD), [0, 0]);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
