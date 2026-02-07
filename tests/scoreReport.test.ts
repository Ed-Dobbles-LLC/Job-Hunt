import {
  scoreSingleJob,
  prettyPrintReport,
  type ScoreReport,
} from "../src/mastra/tools/scoreJobsTool";
import { SCORING_PROFILES } from "../src/mastra/tools/scoringConfig";

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

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(name: string, actual: any, expected: any) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      console.log(`  PASS: ${name}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name}`);
      console.log(`    expected: ${JSON.stringify(expected)}`);
      console.log(`    actual:   ${JSON.stringify(actual)}`);
      failed++;
    }
  }

  function assertIncludes(name: string, arr: any[], item: any) {
    const found = arr.some((a) => JSON.stringify(a) === JSON.stringify(item));
    if (found) {
      console.log(`  PASS: ${name}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name} — item not found in array`);
      console.log(`    looking for: ${JSON.stringify(item)}`);
      console.log(`    in: ${JSON.stringify(arr)}`);
      failed++;
    }
  }

  const precisionProfile = SCORING_PROFILES.precision;
  const recallProfile = SCORING_PROFILES.recall;

  console.log("\n=== Score Report Snapshot Tests ===\n");

  console.log("--- Report Structure: SVP Precision ---");
  const svpJob = makeJob({ title: "SVP, Data & AI", jd_raw_text: SVP_JD, location: "Chicago", remote_hybrid: "hybrid" });
  const svpResult = scoreSingleJob(svpJob, INVENTORY, precisionProfile);
  const r = svpResult.report;

  assert("report.total matches return total", r.total, svpResult.total);
  assert("report.mode is precision", r.mode, "precision");
  assert("report has 12 categories", Object.keys(r.categories).length, 12);

  const expectedOrder = [
    "role_level_match", "leadership_scope", "domain_relevance",
    "ai_strategy_stack", "ai_engineering_stack", "dominance_adjustment",
    "location_fit", "compensation", "transformation_mandate",
    "company_preference", "execution_mode_match", "spec_inflation_penalty",
  ];
  assert("categories in display order", Object.keys(r.categories), expectedOrder);

  console.log("\n--- Snapshot: SVP Precision Categories ---");
  assert("role_level_match score", r.categories.role_level_match.score, 20);
  assert("role_level_match maxPoints", r.categories.role_level_match.maxPoints, 20);
  assert("role_level_match phrases", r.categories.role_level_match.matchedPhrases, ["svp", "vp"]);

  assert("leadership_scope score", r.categories.leadership_scope.score, 15);
  assert("leadership_scope phrases (sorted, capped 5)", r.categories.leadership_scope.matchedPhrases, ["board", "budget", "executive", "lead a team", "manage"]);

  assert("ai_strategy_stack score", r.categories.ai_strategy_stack.score, 8);
  assert("ai_strategy_stack phrases include nlp", r.categories.ai_strategy_stack.matchedPhrases.includes("nlp"), true);

  assert("ai_engineering_stack score", r.categories.ai_engineering_stack.score, 7);
  assert("location_fit score", r.categories.location_fit.score, 8);
  assert("location_fit phrases", r.categories.location_fit.matchedPhrases, ["chicago", "hybrid"]);

  assert("compensation score", r.categories.compensation.score, 8);
  assert("compensation phrases", r.categories.compensation.matchedPhrases, ["$350,000 - $450,000"]);

  assert("dominance_adjustment score", r.categories.dominance_adjustment.score, 0);

  console.log("\n--- Snapshot: SVP Precision Totals ---");
  assert("rawTotal", r.rawTotal, svpResult.breakdown._raw_total);
  assert("maxPossible", r.maxPossible, 101);

  console.log("\n--- Snapshot: Engineering-Heavy VP (Penalties + Risk Flags) ---");
  const engJob = makeJob({ title: "VP of AI Platform", jd_raw_text: ENG_HEAVY_JD });
  const engResult = scoreSingleJob(engJob, INVENTORY, precisionProfile);
  const er = engResult.report;

  assert("eng VP has penalties", er.penalties.length > 0, true);
  assertIncludes("dominance penalty present", er.penalties, {
    key: "dominance_adjustment",
    score: -5,
    reason: "Engineering stack exceeds strategy stack for VP+ role",
  });

  const execPenalty = er.penalties.find((p) => p.key === "execution_mode_match");
  assert("execution_mode_match penalty exists", execPenalty !== undefined, true);
  assert("execution_mode_match penalty is negative", (execPenalty?.score ?? 0) < 0, true);

  const specPenalty = er.penalties.find((p) => p.key === "spec_inflation_penalty");
  assert("spec_inflation_penalty exists", specPenalty !== undefined, true);

  assert("risk flags sorted", er.riskFlags, [...er.riskFlags].sort());
  assert("has engineering-heavy flag", er.riskFlags.includes("Engineering-heavy AI execution expected"), true);
  assert("has dominance flag", er.riskFlags.includes("Engineering-heavy AI execution expected for a strategy-level title"), true);
  assert("has buzzword flag", er.riskFlags.includes("High buzzword density with weak business grounding"), true);
  assert("has location flag", er.riskFlags.includes("No preferred location match (not Chicago/remote/hybrid)"), true);

  console.log("\n--- Snapshot: Strategy-Led Role (No Penalties, No Risk Flags) ---");
  const stratJob = makeJob({ title: "VP of Data Strategy", jd_raw_text: STRATEGY_JD, location: "Remote" });
  const stratResult = scoreSingleJob(stratJob, INVENTORY, precisionProfile);
  const sr = stratResult.report;

  assert("strategy VP has zero penalties", sr.penalties.length, 0);
  assert("strategy VP has no engineering risk flags",
    sr.riskFlags.filter((f) => f.includes("Engineering")).length, 0);
  assert("strategy VP has no buzzword flag",
    sr.riskFlags.includes("High buzzword density with weak business grounding"), false);

  console.log("\n--- Snapshot: Recall Mode Differences ---");
  const svpRecall = scoreSingleJob(svpJob, INVENTORY, recallProfile);
  const rr = svpRecall.report;
  assert("recall report mode", rr.mode, "recall");
  assert("recall maxPossible differs from precision", rr.maxPossible, 90);

  const engRecall = scoreSingleJob(engJob, INVENTORY, recallProfile);
  const engRecallDom = engRecall.report.penalties.find((p) => p.key === "dominance_adjustment");
  assert("recall mode: no dominance penalty", engRecallDom, undefined);

  console.log("\n--- Snapshot: Empty JD ---");
  const emptyJob = makeJob({ title: "Unknown", jd_raw_text: "" });
  const emptyResult = scoreSingleJob(emptyJob, INVENTORY, precisionProfile);
  const emptyR = emptyResult.report;
  assert("empty JD total >= 0", emptyR.total >= 0, true);
  assert("empty JD all category phrases are arrays", Object.values(emptyR.categories).every((c) => Array.isArray(c.matchedPhrases)), true);
  assert("empty JD location risk flag",
    emptyR.riskFlags.includes("No preferred location match (not Chicago/remote/hybrid)"), true);

  console.log("\n--- Pretty Print Smoke Test ---");
  const pretty = prettyPrintReport(er, "VP of AI Platform @ TestCorp");
  assert("pretty print contains SCORE REPORT", pretty.includes("SCORE REPORT"), true);
  assert("pretty print contains CATEGORY BREAKDOWN", pretty.includes("CATEGORY BREAKDOWN"), true);
  assert("pretty print contains PENALTIES APPLIED", pretty.includes("PENALTIES APPLIED"), true);
  assert("pretty print contains RISK FLAGS", pretty.includes("RISK FLAGS"), true);
  assert("pretty print contains job label", pretty.includes("VP of AI Platform @ TestCorp"), true);

  const prettyNoRisk = prettyPrintReport(sr, "VP of Data Strategy");
  assert("strategy pretty has no PENALTIES section", prettyNoRisk.includes("PENALTIES APPLIED"), false);

  console.log(`\n--- Pretty Print Output Sample ---`);
  console.log(pretty);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runTests();
