import { classifyRoleShape, type RoleShapeResult } from "../src/mastra/tools/roleShapeClassifier";

function makeJob(title: string, jd: string) {
  return { title, jd_raw_text: jd };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(name: string, actual: any, expected: any, comparator: string = "eq") {
    let ok = false;
    if (comparator === "eq") ok = JSON.stringify(actual) === JSON.stringify(expected);
    else if (comparator === "gte") ok = actual >= expected;
    else if (comparator === "lte") ok = actual <= expected;
    else if (comparator === "range") ok = actual >= expected[0] && actual <= expected[1];

    if (ok) {
      console.log(`  PASS: ${name} => ${JSON.stringify(actual)}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name} => got ${JSON.stringify(actual)}, expected ${comparator} ${JSON.stringify(expected)}`);
      failed++;
    }
  }

  console.log("\n=== RoleShape Classifier Tests ===\n");

  console.log("--- Shape A: Strategy-Led AI/Data Leadership ---");
  {
    const job = makeJob("SVP, Data & AI", `
      Define the enterprise AI strategy and data roadmap. Drive digital transformation
      and adoption across the portfolio. Present to executive stakeholders and the board.
      Own the operating model for AI initiatives. Deliver measurable ROI through
      strategic vision and cross-functional collaboration. Lead a team of 40+.
      Budget and P&L ownership. Change management and innovation agenda.
    `);
    const r = classifyRoleShape(job);
    assert("Shape A for strategy-led SVP", r.shape, "A");
    assert("Shape A confidence >= 0.6", r.confidence, 0.6, "gte");
    assert("Shape A label", r.label, "Strategy-Led AI/Data Leadership");
    assert("Shape A has strategy signals", r.signals.strategy.length, 3, "gte");
    assert("Shape A has leadership signals", r.signals.leadership.length, 2, "gte");
    assert("Shape A engineering signals low", r.signals.engineering.length, 2, "lte");
    console.log(`    reason: ${r.reason}`);
  }

  {
    const job = makeJob("VP of Data Strategy", `
      Lead data strategy and business value creation. Own the analytics roadmap,
      transformation initiatives, and executive stakeholder management. Board-level
      presentations. Build and mentor a team. Budget oversight.
    `);
    const r = classifyRoleShape(job);
    assert("Shape A for VP Data Strategy", r.shape, "A");
    assert("Shape A confidence >= 0.5", r.confidence, 0.5, "gte");
  }

  console.log("\n--- Shape B: Hybrid Strategy + Engineering ---");
  {
    const job = makeJob("VP of AI Platform & Strategy", `
      Own the AI strategy and roadmap while also overseeing platform engineering.
      Lead transformation initiatives and executive stakeholder engagement.
      Manage CI/CD pipelines, MLOps infrastructure, Kubernetes deployments,
      and model serving. Board presentations and ROI delivery.
      Build and scale the engineering organization. Budget and P&L ownership.
      Monitor SLAs and system scalability.
    `);
    const r = classifyRoleShape(job);
    assert("Shape B for hybrid VP", r.shape, "B");
    assert("Shape B confidence >= 0.5", r.confidence, 0.5, "gte");
    assert("Shape B label", r.label, "Hybrid Strategy + Engineering");
    assert("Shape B has both strategy and engineering signals", r.signals.strategy.length >= 3 && r.signals.engineering.length >= 3, true);
    console.log(`    reason: ${r.reason}`);
  }

  {
    const job = makeJob("Head of Data & AI", `
      Drive AI strategy, roadmap, and digital transformation. Also architect and
      deploy ML pipelines, MLOps infrastructure, and monitoring systems.
      Cross-functional collaboration and adoption. Lead a team of 25+.
    `);
    const r = classifyRoleShape(job);
    assert("Shape B for mixed Head of Data", r.shape, "B");
  }

  console.log("\n--- Shape C: Analytics/BI Leadership ---");
  {
    const job = makeJob("Director of Business Intelligence", `
      Lead the BI team responsible for dashboards, reporting, and data visualization.
      Own KPIs, metrics, executive reporting, and self-service analytics.
      Manage Tableau and Power BI implementations. Data governance and data quality
      oversight. Build data catalog. Ad-hoc analysis for business stakeholders.
    `);
    const r = classifyRoleShape(job);
    assert("Shape C for BI Director", r.shape, "C");
    assert("Shape C confidence >= 0.5", r.confidence, 0.5, "gte");
    assert("Shape C label", r.label, "Analytics/BI Leadership");
    assert("Shape C has analytics signals", r.signals.analytics.length, 3, "gte");
    console.log(`    reason: ${r.reason}`);
  }

  {
    const job = makeJob("Director, Analytics", `
      Own reporting and dashboards for the executive team. Drive data quality
      initiatives and self-service analytics adoption. Manage a team of analysts.
      Looker and Tableau expertise required.
    `);
    const r = classifyRoleShape(job);
    assert("Shape C for analytics director", r.shape, "C");
  }

  console.log("\n--- Shape D: Engineering/Platform/IC-Heavy ---");
  {
    const job = makeJob("VP of ML Platform", `
      Build and own the ML platform including CI/CD pipelines, MLOps, Kubernetes
      clusters, model serving, monitoring, infrastructure, and deployment automation.
      Architect distributed systems for scalability and low latency. Manage SLAs
      and DevOps practices. Design APIs and microservices.
    `);
    const r = classifyRoleShape(job);
    assert("Shape D for ML Platform VP", r.shape, "D");
    assert("Shape D confidence >= 0.5", r.confidence, 0.5, "gte");
    assert("Shape D label", r.label, "Engineering/Platform/IC-Heavy");
    assert("Shape D has engineering signals", r.signals.engineering.length, 4, "gte");
    console.log(`    reason: ${r.reason}`);
  }

  {
    const job = makeJob("Staff Engineer, ML Infrastructure", `
      Design and implement ML infrastructure including deployment pipelines,
      model serving, feature stores, and monitoring. Work with Kubernetes,
      distributed systems, and microservices architecture.
    `);
    const r = classifyRoleShape(job);
    assert("Shape D for Staff ML Engineer", r.shape, "D");
  }

  console.log("\n--- Edge Cases ---");
  {
    const job = makeJob("Manager", "");
    const r = classifyRoleShape(job);
    assert("Empty JD defaults to C", r.shape, "C");
    assert("Empty JD low confidence", r.confidence, 0.4, "lte");
    console.log(`    reason: ${r.reason}`);
  }

  {
    const job = makeJob("VP of Something", "Great opportunity at a leading company.");
    const r = classifyRoleShape(job);
    assert("Minimal signals: classified with low confidence", r.confidence, 0.5, "lte");
    console.log(`    shape: ${r.shape}, confidence: ${r.confidence}, reason: ${r.reason}`);
  }

  console.log("\n--- Deterministic Ordering ---");
  {
    const job = makeJob("SVP, Data & AI", `
      Strategy roadmap transformation adoption board executive stakeholders ROI
      CI/CD pipelines MLOps deployment monitoring Kubernetes infrastructure platform
      dashboards reporting KPIs metrics Tableau
      lead a team build a team manage direct reports budget P&L
    `);
    const r1 = classifyRoleShape(job);
    const r2 = classifyRoleShape(job);
    assert("Same input produces same shape", r1.shape, r2.shape);
    assert("Same input produces same confidence", r1.confidence, r2.confidence);
    assert("Signals are sorted", r1.signals.strategy, [...r1.signals.strategy].sort());
    assert("Engineering signals sorted", r1.signals.engineering, [...r1.signals.engineering].sort());
    assert("Analytics signals sorted", r1.signals.analytics, [...r1.signals.analytics].sort());
    assert("Leadership signals sorted", r1.signals.leadership, [...r1.signals.leadership].sort());
  }

  console.log("\n--- Confidence Ranges ---");
  {
    const strongA = classifyRoleShape(makeJob("SVP Data & AI", `
      AI strategy roadmap operating model transformation adoption portfolio
      executive stakeholders board ROI strategic vision cross-functional
      enterprise-wide center of excellence change management innovation agenda
      lead a team direct reports budget P&L executive c-suite hire mentor
    `));
    assert("Strong A confidence >= 0.8", strongA.confidence, 0.8, "gte");

    const weakA = classifyRoleShape(makeJob("Director Analytics", "Data strategy and roadmap. Manage team."));
    assert("Weak A confidence < 0.7", weakA.confidence, 0.7, "lte");
    assert("Weak A still classified as A", weakA.shape, "A");
  }

  console.log("\n--- Signals Capped at 5 ---");
  {
    const job = makeJob("SVP", `
      roadmap strategy business value operating model adoption portfolio
      executive stakeholders board roi strategic vision go-to-market
      innovation agenda center of excellence change management enterprise-wide
    `);
    const r = classifyRoleShape(job);
    assert("Strategy signals capped at 5", r.signals.strategy.length, 5, "lte");
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runTests();
