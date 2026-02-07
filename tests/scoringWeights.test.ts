import {
  scoreSingleJob,
  scoreAIStrategyStack,
  scoreAIEngineeringStack,
} from "../src/mastra/tools/scoreJobsTool";
import { SCORING_PROFILES, getMaxPositiveScore } from "../src/mastra/tools/scoringConfig";

function makeJob(overrides: Partial<{ title: string; jd_raw_text: string; location: string; remote_hybrid: string }>) {
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

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(name: string, actual: any, expected: any, comparator: string = "eq") {
    let ok = false;
    if (comparator === "eq") ok = actual === expected;
    else if (comparator === "gte") ok = actual >= expected;
    else if (comparator === "lte") ok = actual <= expected;
    else if (comparator === "gt") ok = actual > expected;
    else if (comparator === "range") ok = actual >= expected[0] && actual <= expected[1];

    if (ok) {
      console.log(`  PASS: ${name} => ${JSON.stringify(actual)}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name} => got ${JSON.stringify(actual)}, expected ${comparator} ${JSON.stringify(expected)}`);
      failed++;
    }
  }

  console.log("\n=== Scoring Weights & Normalization Tests ===\n");

  console.log("--- AI Strategy Stack Sub-Score ---");
  const stratResult = scoreAIStrategyStack(
    "We use predictive modeling, NLP, generative AI, and experimentation frameworks with analytics platforms",
    8,
  );
  assert("Strategy stack finds terms", stratResult.hits.length, 3, "gte");
  assert("Strategy stack score capped at max", stratResult.score, 8, "lte");

  const stratEmpty = scoreAIStrategyStack("Just basic SQL reporting", 8);
  assert("Strategy stack zero for no terms", stratEmpty.score, 0);

  console.log("\n--- AI Engineering Stack Sub-Score ---");
  const engResult = scoreAIEngineeringStack(
    "MLOps CI/CD deployment monitoring Kubernetes docker model serving feature stores orchestration",
    7,
  );
  assert("Engineering stack finds terms", engResult.hits.length, 4, "gte");
  assert("Engineering stack score capped at max", engResult.score, 7, "lte");

  const engEmpty = scoreAIEngineeringStack("Executive strategy board ROI", 7);
  assert("Engineering stack zero for no terms", engEmpty.score, 0);

  console.log("\n--- Dominance Check (Engineering > Strategy for VP+) ---");
  const vpEngHeavy = makeJob({
    title: "VP of AI Platform",
    jd_raw_text: "MLOps CI/CD deployment monitoring kubernetes docker model serving feature stores orchestration",
  });
  const precisionProfile = SCORING_PROFILES.precision;
  const vpResult = scoreSingleJob(vpEngHeavy, INVENTORY, precisionProfile);
  assert("VP eng-heavy gets dominance penalty", vpResult.breakdown.dominance_adjustment, -5);

  const dirEngHeavy = makeJob({
    title: "Director of ML Engineering",
    jd_raw_text: "MLOps CI/CD deployment monitoring kubernetes docker model serving feature stores",
  });
  const dirResult = scoreSingleJob(dirEngHeavy, INVENTORY, precisionProfile);
  assert("Director eng-heavy gets NO dominance penalty", dirResult.breakdown.dominance_adjustment, 0);

  const vpStratHeavy = makeJob({
    title: "VP of Data Strategy",
    jd_raw_text: "predictive modeling NLP generative AI experimentation analytics platforms forecasting optimization",
  });
  const vpStratResult = scoreSingleJob(vpStratHeavy, INVENTORY, precisionProfile);
  assert("VP strategy-heavy gets NO dominance penalty", vpStratResult.breakdown.dominance_adjustment, 0);

  console.log("\n--- Recall Mode: Dominance Penalty Disabled ---");
  const recallProfile = SCORING_PROFILES.recall;
  const vpRecallResult = scoreSingleJob(vpEngHeavy, INVENTORY, recallProfile);
  assert("VP eng-heavy in recall mode: no dominance penalty", vpRecallResult.breakdown.dominance_adjustment, 0);

  console.log("\n--- Normalization to 0-100 ---");
  const svpJob = makeJob({
    title: "SVP, Data & AI",
    jd_raw_text: SVP_JD,
    location: "Chicago",
    remote_hybrid: "hybrid",
  });
  const svpPrecision = scoreSingleJob(svpJob, INVENTORY, precisionProfile);
  assert("SVP precision score 0-100", svpPrecision.total, [0, 100], "range");
  assert("SVP precision raw total exists", svpPrecision.breakdown._raw_total !== undefined, true);
  assert("SVP precision mode tag", svpPrecision.mode, "precision");

  const svpRecall = scoreSingleJob(svpJob, INVENTORY, recallProfile);
  assert("SVP recall score 0-100", svpRecall.total, [0, 100], "range");

  console.log("\n--- Score Clamping ---");
  const emptyJob = makeJob({ title: "Unknown Role", jd_raw_text: "" });
  const emptyResult = scoreSingleJob(emptyJob, INVENTORY, precisionProfile);
  assert("Empty JD score >= 0", emptyResult.total, 0, "gte");
  assert("Empty JD score <= 100", emptyResult.total, 100, "lte");

  console.log("\n--- Max Positive Score Calculation ---");
  const maxPrec = getMaxPositiveScore(precisionProfile.weights);
  assert("Precision max positive = 101", maxPrec, 101);
  const maxRec = getMaxPositiveScore(recallProfile.weights);
  assert("Recall max positive = 90", maxRec, 90);

  console.log("\n--- Precision vs Recall: Same JD Different Scores ---");
  console.log(`  SVP Precision: ${svpPrecision.total}/100 (raw: ${svpPrecision.breakdown._raw_total}/${svpPrecision.breakdown._max_possible})`);
  console.log(`  SVP Recall:    ${svpRecall.total}/100 (raw: ${svpRecall.breakdown._raw_total}/${svpRecall.breakdown._max_possible})`);
  console.log(`  Precision breakdown: strategy=${svpPrecision.breakdown.ai_strategy_stack}, eng=${svpPrecision.breakdown.ai_engineering_stack}, dom=${svpPrecision.breakdown.dominance_adjustment}`);
  console.log(`  Recall breakdown:    strategy=${svpRecall.breakdown.ai_strategy_stack}, eng=${svpRecall.breakdown.ai_engineering_stack}, dom=${svpRecall.breakdown.dominance_adjustment}`);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
