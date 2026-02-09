import { describe, it, expect } from "vitest";
import {
  layer1EvidenceCompleteness,
  layer2PointerValidity,
  layer3QuoteAccuracy,
  layer4FactAllowlist,
  layer5UnknownCompliance,
  type EvidencePointer,
} from "../src/mastra/tools/verifyTruthTool";
import {
  extractFactRegistry,
  type FactRegistry,
} from "../src/mastra/tools/factRegistry";

function makePointer(
  overrides: Partial<EvidencePointer> = {},
): EvidencePointer {
  return {
    claim_text: "Led a 45-person data organization",
    evidence_id: "exp-001-b1",
    evidence_quote:
      "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
    evidence_source_key: "experience[0].bullets[0]",
    confidence: 0.95,
    ...overrides,
  };
}

describe("FactRegistry", () => {
  const registry = extractFactRegistry();

  it("has employers", () => {
    expect(registry.employers.size).toBeGreaterThan(0);
    expect(registry.employers.has("acme financial group")).toBe(true);
    expect(registry.employers.has("healthtech solutions inc.")).toBe(true);
    expect(registry.employers.has("global retail corp")).toBe(true);
    expect(registry.employers.has("datafirst consulting")).toBe(true);
  });

  it("has titles", () => {
    expect(registry.titles.size).toBeGreaterThan(0);
    expect(registry.titles.has("vp of data & analytics")).toBe(true);
    expect(
      registry.titles.has("senior director, data science & analytics"),
    ).toBe(true);
  });

  it("has dates", () => {
    expect(registry.dates.size).toBeGreaterThan(0);
    expect(registry.dates.has("2021-03")).toBe(true);
    expect(registry.dates.has("present")).toBe(true);
    expect(registry.dates.has("2010")).toBe(true);
  });

  it("has metrics", () => {
    expect(registry.metrics.size).toBeGreaterThan(0);
    expect(registry.metrics.has("45-person team")).toBe(true);
    expect(registry.metrics.has("$12m annual cost savings")).toBe(true);
  });

  it("has tools", () => {
    expect(registry.tools.size).toBeGreaterThan(0);
    expect(registry.tools.has("python")).toBe(true);
    expect(registry.tools.has("snowflake")).toBe(true);
    expect(registry.tools.has("tableau")).toBe(true);
  });

  it("has degrees and certifications", () => {
    expect(registry.degrees.size).toBeGreaterThan(0);
    expect(registry.certifications.size).toBeGreaterThan(0);
    expect(
      registry.certifications.has("aws certified solutions architect"),
    ).toBe(true);
  });

  it("has bullet IDs and texts", () => {
    expect(registry.bulletIds.size).toBeGreaterThan(0);
    expect(registry.bulletIds.has("exp-001-b1")).toBe(true);
    expect(registry.bulletIds.has("exp-002-b2")).toBe(true);
    expect(registry.bulletTexts.has("exp-001-b1")).toBe(true);
    expect(registry.bulletTexts.get("exp-001-b1")).toContain(
      "45-person data organization",
    );
  });
});

describe("Layer 1: Evidence Completeness", () => {
  it("passes when all bullets have pointers", () => {
    const bullets = ["Led a 45-person data organization"];
    const claims: string[] = [];
    const pointers = [makePointer()];
    const result = layer1EvidenceCompleteness(bullets, claims, pointers);
    expect(result.passed).toBe(true);
    expect(result.failures.length).toBe(0);
  });

  it("fails when bullet missing pointer", () => {
    const bullets = [
      "Led a 45-person data organization",
      "Drove $12M annual cost savings",
    ];
    const claims: string[] = [];
    const pointers = [makePointer()];
    const result = layer1EvidenceCompleteness(bullets, claims, pointers);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]).toContain("$12M");
  });

  it("passes for cover letter claims with pointers", () => {
    const bullets: string[] = [];
    const claims = ["I led a 45-person data organization spanning analytics"];
    const pointers = [
      makePointer({
        claim_text: "I led a 45-person data organization spanning analytics",
      }),
    ];
    const result = layer1EvidenceCompleteness(bullets, claims, pointers);
    expect(result.passed).toBe(true);
  });

  it("fails when cover letter claim missing pointer", () => {
    const bullets: string[] = [];
    const claims = [
      "I drove $12M in savings through data platform consolidation",
    ];
    const pointers: EvidencePointer[] = [];
    const result = layer1EvidenceCompleteness(bullets, claims, pointers);
    expect(result.passed).toBe(false);
  });

  it("passes with empty inputs", () => {
    const result = layer1EvidenceCompleteness([], [], []);
    expect(result.passed).toBe(true);
  });
});

describe("Layer 2: Pointer Validity", () => {
  const registry = extractFactRegistry();

  it("passes with valid inventory ID", () => {
    const pointers = [makePointer({ evidence_id: "exp-001-b1" })];
    const result = layer2PointerValidity(pointers, registry);
    expect(result.passed).toBe(true);
  });

  it("fails with invalid inventory ID", () => {
    const pointers = [makePointer({ evidence_id: "exp-999-b99" })];
    const result = layer2PointerValidity(pointers, registry);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("exp-999-b99");
  });

  it("fails with empty evidence_id", () => {
    const pointers = [makePointer({ evidence_id: "" })];
    const result = layer2PointerValidity(pointers, registry);
    expect(result.passed).toBe(false);
  });

  it("passes with education ID", () => {
    const pointers = [makePointer({ evidence_id: "edu-001" })];
    const result = layer2PointerValidity(pointers, registry);
    expect(result.passed).toBe(true);
  });

  it("passes with certification ID", () => {
    const pointers = [makePointer({ evidence_id: "cert-001" })];
    const result = layer2PointerValidity(pointers, registry);
    expect(result.passed).toBe(true);
  });

  it("fails when one of multiple pointers has bad ID", () => {
    const pointers = [
      makePointer({ evidence_id: "exp-001-b1" }),
      makePointer({ evidence_id: "FAKE-ID", claim_text: "fake claim" }),
      makePointer({ evidence_id: "exp-002-b2" }),
    ];
    const result = layer2PointerValidity(pointers, registry);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBe(1);
  });
});

describe("Layer 3: Quote Accuracy", () => {
  const registry = extractFactRegistry();

  it("passes with exact quote", () => {
    const pointers = [
      makePointer({
        evidence_id: "exp-001-b1",
        evidence_quote:
          "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
      }),
    ];
    const result = layer3QuoteAccuracy(pointers, registry);
    expect(result.passed).toBe(true);
  });

  it("passes with partial quote match", () => {
    const pointers = [
      makePointer({
        evidence_id: "exp-001-b1",
        evidence_quote: "Led a 45-person data organization",
      }),
    ];
    const result = layer3QuoteAccuracy(pointers, registry);
    expect(result.passed).toBe(true);
  });

  it("fails with fabricated quote", () => {
    const pointers = [
      makePointer({
        evidence_id: "exp-001-b1",
        evidence_quote:
          "This quote is completely made up and does not exist anywhere in the inventory whatsoever",
      }),
    ];
    const result = layer3QuoteAccuracy(pointers, registry);
    expect(result.passed).toBe(false);
  });

  it("fails with empty quote", () => {
    const pointers = [
      makePointer({
        evidence_id: "exp-001-b1",
        evidence_quote: "",
      }),
    ];
    const result = layer3QuoteAccuracy(pointers, registry);
    expect(result.passed).toBe(false);
  });

  it("passes with partial match from different bullet", () => {
    const pointers = [
      makePointer({
        evidence_id: "exp-001-b2",
        evidence_quote:
          "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
      }),
    ];
    const result = layer3QuoteAccuracy(pointers, registry);
    expect(result.passed).toBe(true);
  });
});

describe("Layer 4: Fact Allowlist", () => {
  const registry = extractFactRegistry();

  it("passes with all facts from inventory", () => {
    const resume =
      "Led a 45-person data organization. Drove $12M annual cost savings using Snowflake and dbt.";
    const cover = "At Acme Financial Group, I led analytics engineering.";
    const result = layer4FactAllowlist(resume, cover, registry);
    expect(result.passed).toBe(true);
  });

  it("fails with fabricated number ($99M)", () => {
    const resume =
      "Led a 45-person data organization. Achieved $99M in savings.";
    const result = layer4FactAllowlist(resume, "", registry);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("$99M"))).toBe(true);
  });

  it("doesn't flag tools not in the match pattern", () => {
    const resume = "Expert in MongoDB and Neo4j.";
    const result = layer4FactAllowlist(resume, "", registry);
    expect(result.passed || result.failures.length === 0).toBe(true);
  });

  it("flags year not in inventory (2019)", () => {
    const cover = "In 2019, I achieved significant results.";
    const result = layer4FactAllowlist("", cover, registry);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("2019"))).toBe(true);
  });

  it("allows year from inventory (2010)", () => {
    const resume = "In 2010, I completed my MBA.";
    const result = layer4FactAllowlist(resume, "", registry);
    expect(result.failures.some((f) => f.includes("2010"))).toBe(false);
  });
});

describe("Layer 5: Unknown Compliance", () => {
  it("passes with clean text", () => {
    const resume = "Led a 45-person data organization. Drove $12M in savings.";
    const cover = "I am excited to apply for this role.";
    const result = layer5UnknownCompliance(resume, cover);
    expect(result.passed).toBe(true);
  });

  it("flags 'I believe that your company'", () => {
    const cover = "I believe that your company is doing amazing work in AI.";
    const result = layer5UnknownCompliance("", cover);
    expect(result.passed).toBe(false);
  });

  it("flags 'from what I understand'", () => {
    const cover = "From what I understand, you need a data leader.";
    const result = layer5UnknownCompliance("", cover);
    expect(result.passed).toBe(false);
  });

  it("flags 'I'm confident that'", () => {
    const cover = "I'm confident that my background aligns with this role.";
    const result = layer5UnknownCompliance("", cover);
    expect(result.passed).toBe(false);
  });
});

describe("Integration Tests", () => {
  const registry = extractFactRegistry();

  it("all bullets, claims, pointers, and quotes are valid", () => {
    const bullets = [
      "Led a 45-person data organization spanning analytics engineering",
      "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
    ];
    const claims = [
      "I managed 28 data scientists and analysts delivering predictive analytics for population health management",
    ];
    const pointers: EvidencePointer[] = [
      {
        claim_text:
          "Led a 45-person data organization spanning analytics engineering",
        evidence_id: "exp-001-b1",
        evidence_quote:
          "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
        evidence_source_key: "experience[0].bullets[0]",
        confidence: 0.95,
      },
      {
        claim_text:
          "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        evidence_id: "exp-001-b2",
        evidence_quote:
          "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses",
        evidence_source_key: "experience[0].bullets[1]",
        confidence: 0.9,
      },
      {
        claim_text:
          "I managed 28 data scientists and analysts delivering predictive analytics for population health management",
        evidence_id: "exp-002-b1",
        evidence_quote:
          "Managed a team of 28 data scientists, analysts, and engineers delivering predictive analytics for population health management",
        evidence_source_key: "experience[1].bullets[0]",
        confidence: 0.9,
      },
    ];

    const l1 = layer1EvidenceCompleteness(bullets, claims, pointers);
    const l2 = layer2PointerValidity(pointers, registry);
    const l3 = layer3QuoteAccuracy(pointers, registry);

    expect(l1.passed).toBe(true);
    expect(l2.passed).toBe(true);
    expect(l3.passed).toBe(true);
  });

  it("fabricated ID and quote fail layers 2 and 3", () => {
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

    expect(l2.passed).toBe(false);
    expect(l3.passed).toBe(false);
  });
});
