import {
  layer1EvidenceCompleteness,
  layer2PointerValidity,
  layer3QuoteAccuracy,
  layer4FactAllowlist,
  layer5UnknownCompliance,
  type EvidencePointer,
} from "../src/mastra/tools/verifyTruthTool";
import { extractFactRegistry, type FactRegistry } from "../src/mastra/tools/factRegistry";

let registry: FactRegistry;
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

function makePointer(overrides: Partial<EvidencePointer> = {}): EvidencePointer {
  return {
    claim_text: "Led a 45-person data organization",
    evidence_id: "exp-001-b1",
    evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
    evidence_source_key: "experience[0].bullets[0]",
    confidence: 0.95,
    ...overrides,
  };
}

console.log("\n=== FactRegistry Tests ===");

registry = extractFactRegistry();

assert(registry.employers.size > 0, "Registry has employers");
assert(registry.employers.has("acme financial group"), "Registry has Acme Financial Group");
assert(registry.employers.has("healthtech solutions inc."), "Registry has HealthTech Solutions");
assert(registry.employers.has("global retail corp"), "Registry has Global Retail Corp");
assert(registry.employers.has("datafirst consulting"), "Registry has DataFirst Consulting");

assert(registry.titles.size > 0, "Registry has titles");
assert(registry.titles.has("vp of data & analytics"), "Registry has VP title");
assert(registry.titles.has("senior director, data science & analytics"), "Registry has Senior Director title");

assert(registry.dates.size > 0, "Registry has dates");
assert(registry.dates.has("2021-03"), "Registry has 2021-03");
assert(registry.dates.has("present"), "Registry has 'present'");
assert(registry.dates.has("2010"), "Registry has education year 2010");

assert(registry.metrics.size > 0, "Registry has metrics");
assert(registry.metrics.has("45-person team"), "Registry has 45-person team metric");
assert(registry.metrics.has("$12m annual cost savings"), "Registry has $12M metric");

assert(registry.tools.size > 0, "Registry has tools");
assert(registry.tools.has("python"), "Registry has Python");
assert(registry.tools.has("snowflake"), "Registry has Snowflake");
assert(registry.tools.has("tableau"), "Registry has Tableau");

assert(registry.degrees.size > 0, "Registry has degrees");
assert(registry.certifications.size > 0, "Registry has certifications");
assert(registry.certifications.has("aws certified solutions architect"), "Registry has AWS cert");

assert(registry.bulletIds.size > 0, "Registry has bullet IDs");
assert(registry.bulletIds.has("exp-001-b1"), "Registry has exp-001-b1");
assert(registry.bulletIds.has("exp-002-b2"), "Registry has exp-002-b2");

assert(registry.bulletTexts.has("exp-001-b1"), "Registry has bullet text for exp-001-b1");
assert(
  registry.bulletTexts.get("exp-001-b1")?.includes("45-person data organization") || false,
  "Bullet text matches expected content",
);

console.log("\n=== Layer 1: Evidence Completeness ===");

{
  const bullets = ["Led a 45-person data organization"];
  const claims: string[] = [];
  const pointers = [makePointer()];
  const result = layer1EvidenceCompleteness(bullets, claims, pointers);
  assert(result.passed, "L1: Passes when all bullets have pointers");
  assert(result.failures.length === 0, "L1: No failures when complete");
}

{
  const bullets = ["Led a 45-person data organization", "Drove $12M annual cost savings"];
  const claims: string[] = [];
  const pointers = [makePointer()];
  const result = layer1EvidenceCompleteness(bullets, claims, pointers);
  assert(!result.passed, "L1: Fails when bullet missing pointer");
  assert(result.failures.length === 1, "L1: One failure for missing bullet");
  assert(result.failures[0].includes("$12M"), "L1: Failure identifies the missing bullet");
}

{
  const bullets: string[] = [];
  const claims = ["I led a 45-person data organization spanning analytics"];
  const pointers = [makePointer({ claim_text: "I led a 45-person data organization spanning analytics" })];
  const result = layer1EvidenceCompleteness(bullets, claims, pointers);
  assert(result.passed, "L1: Passes for cover letter claims with pointers");
}

{
  const bullets: string[] = [];
  const claims = ["I drove $12M in savings through data platform consolidation"];
  const pointers: EvidencePointer[] = [];
  const result = layer1EvidenceCompleteness(bullets, claims, pointers);
  assert(!result.passed, "L1: Fails when cover letter claim missing pointer");
}

{
  const bullets: string[] = [];
  const claims: string[] = [];
  const pointers: EvidencePointer[] = [];
  const result = layer1EvidenceCompleteness(bullets, claims, pointers);
  assert(result.passed, "L1: Passes with empty inputs");
}

console.log("\n=== Layer 2: Pointer Validity ===");

{
  const pointers = [makePointer({ evidence_id: "exp-001-b1" })];
  const result = layer2PointerValidity(pointers, registry);
  assert(result.passed, "L2: Passes with valid inventory ID");
}

{
  const pointers = [makePointer({ evidence_id: "exp-999-b99" })];
  const result = layer2PointerValidity(pointers, registry);
  assert(!result.passed, "L2: Fails with invalid inventory ID");
  assert(result.failures[0].includes("exp-999-b99"), "L2: Failure identifies the bad ID");
}

{
  const pointers = [makePointer({ evidence_id: "" })];
  const result = layer2PointerValidity(pointers, registry);
  assert(!result.passed, "L2: Fails with empty evidence_id");
}

{
  const pointers = [makePointer({ evidence_id: "edu-001" })];
  const result = layer2PointerValidity(pointers, registry);
  assert(result.passed, "L2: Passes with education ID");
}

{
  const pointers = [makePointer({ evidence_id: "cert-001" })];
  const result = layer2PointerValidity(pointers, registry);
  assert(result.passed, "L2: Passes with certification ID");
}

{
  const pointers = [
    makePointer({ evidence_id: "exp-001-b1" }),
    makePointer({ evidence_id: "FAKE-ID", claim_text: "fake claim" }),
    makePointer({ evidence_id: "exp-002-b2" }),
  ];
  const result = layer2PointerValidity(pointers, registry);
  assert(!result.passed, "L2: Fails when one of multiple pointers has bad ID");
  assert(result.failures.length === 1, "L2: Only one failure for one bad ID");
}

console.log("\n=== Layer 3: Quote Accuracy ===");

{
  const pointers = [makePointer({
    evidence_id: "exp-001-b1",
    evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
  })];
  const result = layer3QuoteAccuracy(pointers, registry);
  assert(result.passed, "L3: Passes with exact quote");
}

{
  const pointers = [makePointer({
    evidence_id: "exp-001-b1",
    evidence_quote: "Led a 45-person data organization",
  })];
  const result = layer3QuoteAccuracy(pointers, registry);
  assert(result.passed, "L3: Passes with partial quote match");
}

{
  const pointers = [makePointer({
    evidence_id: "exp-001-b1",
    evidence_quote: "This quote is completely made up and does not exist anywhere in the inventory whatsoever",
  })];
  const result = layer3QuoteAccuracy(pointers, registry);
  assert(!result.passed, "L3: Fails with fabricated quote");
}

{
  const pointers = [makePointer({
    evidence_id: "exp-001-b1",
    evidence_quote: "",
  })];
  const result = layer3QuoteAccuracy(pointers, registry);
  assert(!result.passed, "L3: Fails with empty quote");
}

{
  const pointers = [makePointer({
    evidence_id: "exp-001-b2",
    evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
  })];
  const result = layer3QuoteAccuracy(pointers, registry);
  assert(result.passed, "L3: Passes with partial match from different bullet");
}

console.log("\n=== Layer 4: Fact Allowlist ===");

{
  const resume = "Led a 45-person data organization. Drove $12M annual cost savings using Snowflake and dbt.";
  const cover = "At Acme Financial Group, I led analytics engineering.";
  const result = layer4FactAllowlist(resume, cover, registry);
  assert(result.passed, "L4: Passes with all facts from inventory");
}

{
  const resume = "Led a 45-person data organization. Achieved $99M in savings.";
  const cover = "";
  const result = layer4FactAllowlist(resume, cover, registry);
  assert(!result.passed, "L4: Fails with fabricated number ($99M)");
  assert(result.failures.some(f => f.includes("$99M")), "L4: Identifies fabricated number");
}

{
  const resume = "Expert in MongoDB and Neo4j.";
  const cover = "";
  const result = layer4FactAllowlist(resume, cover, registry);
  assert(result.passed || result.failures.length === 0, "L4: Doesn't flag tools not in the match pattern");
}

{
  const resume = "";
  const cover = "In 2019, I achieved significant results.";
  const result = layer4FactAllowlist(resume, cover, registry);
  assert(!result.passed, "L4: Flags year not in inventory (2019)");
  assert(result.failures.some(f => f.includes("2019")), "L4: Identifies fabricated year 2019");
}

{
  const resume = "In 2010, I completed my MBA.";
  const cover = "";
  const result = layer4FactAllowlist(resume, cover, registry);
  assert(!result.failures.some(f => f.includes("2010")), "L4: Allows year from inventory (2010)");
}

console.log("\n=== Layer 5: Unknown Compliance ===");

{
  const resume = "Led a 45-person data organization. Drove $12M in savings.";
  const cover = "I am excited to apply for this role.";
  const result = layer5UnknownCompliance(resume, cover);
  assert(result.passed, "L5: Passes with clean text");
}

{
  const resume = "";
  const cover = "I believe that your company is doing amazing work in AI.";
  const result = layer5UnknownCompliance(resume, cover);
  assert(!result.passed, "L5: Flags 'I believe that your company'");
}

{
  const resume = "";
  const cover = "From what I understand, you need a data leader.";
  const result = layer5UnknownCompliance(resume, cover);
  assert(!result.passed, "L5: Flags 'from what I understand'");
}

{
  const resume = "";
  const cover = "I'm confident that my background aligns with this role.";
  const result = layer5UnknownCompliance(resume, cover);
  assert(!result.passed, "L5: Flags 'I'm confident that'");
}

console.log("\n=== Integration Tests ===");

{
  const bullets = [
    "Led a 45-person data organization spanning analytics engineering",
    "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
  ];
  const claims = [
    "I managed 28 data scientists and analysts delivering predictive analytics for population health management",
  ];
  const pointers: EvidencePointer[] = [
    {
      claim_text: "Led a 45-person data organization spanning analytics engineering",
      evidence_id: "exp-001-b1",
      evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
      evidence_source_key: "experience[0].bullets[0]",
      confidence: 0.95,
    },
    {
      claim_text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
      evidence_id: "exp-001-b2",
      evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses",
      evidence_source_key: "experience[0].bullets[1]",
      confidence: 0.9,
    },
    {
      claim_text: "I managed 28 data scientists and analysts delivering predictive analytics for population health management",
      evidence_id: "exp-002-b1",
      evidence_quote: "Managed a team of 28 data scientists, analysts, and engineers delivering predictive analytics for population health management",
      evidence_source_key: "experience[1].bullets[0]",
      confidence: 0.9,
    },
  ];

  const l1 = layer1EvidenceCompleteness(bullets, claims, pointers);
  const l2 = layer2PointerValidity(pointers, registry);
  const l3 = layer3QuoteAccuracy(pointers, registry);

  assert(l1.passed, "Integration: All bullets and claims have pointers");
  assert(l2.passed, "Integration: All evidence_ids are valid");
  assert(l3.passed, "Integration: All quotes match inventory");
}

{
  const pointers: EvidencePointer[] = [
    {
      claim_text: "I led 100 engineers at Google",
      evidence_id: "FAKE-001",
      evidence_quote: "This never happened",
      evidence_source_key: "experience[99].bullets[0]",
      confidence: 0.5,
    },
  ];

  const l2 = layer2PointerValidity(pointers, registry);
  const l3 = layer3QuoteAccuracy(pointers, registry);

  assert(!l2.passed, "Integration: Fabricated ID fails L2");
  assert(!l3.passed, "Integration: Fabricated quote fails L3");
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
