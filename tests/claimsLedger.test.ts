import { describe, it, expect } from "vitest";
import {
  extractClaimsLedger,
  validateMetric,
  validateTool,
  validateEmployer,
  validateAllMetricsInText,
  validateBulletClaims,
} from "../src/mastra/tools/claimsLedger";

// ── Test Inventory (minimal but representative) ──
const testInventory = {
  profile: {
    name: "Test Candidate",
    current_title: "VP of Data & Analytics",
    location: "Chicago, IL",
  },
  experience: [
    {
      id: "exp-001",
      employer: "Acme Financial Group",
      title: "VP of Data & Analytics",
      start_date: "2021-03",
      end_date: "present",
      location: "Chicago, IL",
      bullets: [
        {
          id: "exp-001-b1",
          text: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
          metrics: ["45-person", "3 business units"],
          tools: ["Snowflake", "dbt"],
        },
        {
          id: "exp-001-b2",
          text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses",
          metrics: ["$12M", "7"],
          tools: ["Snowflake", "Redshift"],
        },
        {
          id: "exp-001-b3",
          text: "Built real-time fraud detection ML pipeline processing 2B+ daily events, reducing false positives by 38%",
          metrics: ["2B+", "38%"],
          tools: ["Python", "Spark", "MLflow"],
        },
      ],
    },
    {
      id: "exp-002",
      employer: "HealthTech Solutions Inc.",
      title: "Senior Director, Data Science & Analytics",
      start_date: "2018-06",
      end_date: "2021-02",
      location: "Chicago, IL",
      bullets: [
        {
          id: "exp-002-b1",
          text: "Built and led a 28-person analytics and data science team across 4 functional areas",
          metrics: ["28-person", "4"],
          tools: ["Python", "R", "Tableau"],
        },
      ],
    },
  ],
  education: [
    { id: "edu-001", institution: "University of Chicago", degree: "MBA", year: "2010" },
  ],
  certifications: [
    { id: "cert-001", name: "AWS Certified Solutions Architect", year: "2020" },
  ],
  skills: {
    technical: ["Python", "SQL", "Snowflake", "Tableau"],
    leadership: ["Team Building", "Strategy"],
  },
};

describe("Claims Ledger", () => {
  const ledger = extractClaimsLedger(testInventory);

  // ── UNIT TEST 1: No new tools inserted ──
  it("should reject tools/platforms NOT in inventory", () => {
    // Looker, GCP, and Salesforce are NOT in the test inventory
    expect(validateTool("Looker", ledger).valid).toBe(false);
    expect(validateTool("Salesforce", ledger).valid).toBe(false);

    // Snowflake and Python ARE in the inventory
    expect(validateTool("Snowflake", ledger).valid).toBe(true);
    expect(validateTool("Python", ledger).valid).toBe(true);
  });

  // ── UNIT TEST 2: No new metrics inserted ──
  it("should reject metrics NOT in inventory (no-new-numbers rule)", () => {
    // $12M is in the inventory
    expect(validateMetric("$12M", ledger).valid).toBe(true);

    // $500M is NOT in the inventory — fabricated
    expect(validateMetric("$500M", ledger).valid).toBe(false);

    // 38% is in the inventory
    expect(validateMetric("38%", ledger).valid).toBe(true);

    // 50% is NOT in the inventory — fabricated
    expect(validateMetric("50%", ledger).valid).toBe(false);

    // 45-person is in the inventory
    expect(validateMetric("45-person", ledger).valid).toBe(true);
  });

  // ── UNIT TEST 3: Bullets must cite ledger claims ──
  it("should validate bullet source_claim_ids against ledger", () => {
    // Valid bullet referencing an existing inventory item
    const validResult = validateBulletClaims(
      "Drove $12M annual cost savings via Snowflake",
      ["exp-001-b2"],
      ledger,
    );
    expect(validResult.valid).toBe(true);
    expect(validResult.matched_claims.length).toBeGreaterThan(0);

    // Invalid: bullet references non-existent claim
    const invalidResult = validateBulletClaims(
      "Led $500M enterprise transformation",
      ["exp-999-b99"],
      ledger,
    );
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.issues.length).toBeGreaterThan(0);

    // Invalid: bullet has no source claim IDs at all
    const noSourceResult = validateBulletClaims(
      "Built innovative data pipeline",
      [],
      ledger,
    );
    expect(noSourceResult.valid).toBe(false);
  });

  // ── UNIT TEST 4: validateAllMetricsInText catches fabricated numbers ──
  it("should catch ALL fabricated metrics in a text block", () => {
    // Text with one real metric ($12M) and one fabricated ($300M)
    const result = validateAllMetricsInText(
      "Managed $12M budget across a $300M enterprise transformation",
      ledger,
    );
    expect(result.all_valid).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].metric).toContain("300");
  });

  // ── UNIT TEST 5: Employer validation ──
  it("should validate employers against ledger", () => {
    expect(validateEmployer("Acme Financial Group", ledger).valid).toBe(true);
    expect(validateEmployer("HealthTech Solutions Inc.", ledger).valid).toBe(true);

    // Fabricated employer
    expect(validateEmployer("Google", ledger).valid).toBe(false);
    expect(validateEmployer("McKinsey & Company", ledger).valid).toBe(false);
  });
});
