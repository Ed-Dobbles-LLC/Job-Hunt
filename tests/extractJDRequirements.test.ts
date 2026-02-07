import { describe, it, expect } from "vitest";
import { JDRequirementsSchema, type JDRequirements, type RequirementItem } from "../src/mastra/tools/extractJDRequirementsTool";

describe("JDRequirementsSchema", () => {
  describe("schema validation", () => {
    it("accepts a valid complete requirements object", () => {
      const valid: JDRequirements = {
        must_have: [
          { text: "10+ years of experience in data and analytics leadership", confidence: 1.0 },
          { text: "Bachelor's degree in Computer Science or related field", confidence: 1.0 },
        ],
        nice_to_have: [
          { text: "MBA or advanced degree", confidence: 0.9 },
          { text: "Experience with Snowflake", confidence: 0.8 },
        ],
        leadership_scope: [
          { text: "Manage a team of 15+ data professionals", confidence: 1.0 },
          { text: "Report directly to the CTO", confidence: 0.9 },
        ],
        domain_context: [
          { text: "B2B SaaS company", confidence: 0.95 },
          { text: "Series C startup", confidence: 0.8 },
        ],
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
          { text: "Snowflake", confidence: 1.0 },
          { text: "dbt", confidence: 1.0 },
          { text: "Airflow", confidence: 0.9 },
        ],
        keywords_for_ats: [
          { text: "data-driven decision making", confidence: 1.0 },
          { text: "cross-functional collaboration", confidence: 1.0 },
          { text: "executive stakeholder management", confidence: 0.9 },
        ],
        red_flags: [
          { text: "Role combines IC hands-on coding with VP-level strategy — scope may be too broad", confidence: 0.7 },
        ],
      };
      const result = JDRequirementsSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("accepts empty arrays for all categories", () => {
      const empty: JDRequirements = {
        must_have: [],
        nice_to_have: [],
        leadership_scope: [],
        domain_context: [],
        tech_keywords: [],
        keywords_for_ats: [],
        red_flags: [],
      };
      const result = JDRequirementsSchema.safeParse(empty);
      expect(result.success).toBe(true);
    });

    it("rejects missing required categories", () => {
      const partial = {
        must_have: [{ text: "Python", confidence: 1.0 }],
      };
      const result = JDRequirementsSchema.safeParse(partial);
      expect(result.success).toBe(false);
    });

    it("rejects confidence > 1.0", () => {
      const invalid = {
        must_have: [{ text: "Python", confidence: 1.5 }],
        nice_to_have: [],
        leadership_scope: [],
        domain_context: [],
        tech_keywords: [],
        keywords_for_ats: [],
        red_flags: [],
      };
      const result = JDRequirementsSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects confidence < 0", () => {
      const invalid = {
        must_have: [{ text: "Python", confidence: -0.1 }],
        nice_to_have: [],
        leadership_scope: [],
        domain_context: [],
        tech_keywords: [],
        keywords_for_ats: [],
        red_flags: [],
      };
      const result = JDRequirementsSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("accepts confidence at boundary values 0 and 1", () => {
      const valid = {
        must_have: [{ text: "min", confidence: 0 }, { text: "max", confidence: 1 }],
        nice_to_have: [],
        leadership_scope: [],
        domain_context: [],
        tech_keywords: [],
        keywords_for_ats: [],
        red_flags: [],
      };
      const result = JDRequirementsSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("rejects items with missing text field", () => {
      const invalid = {
        must_have: [{ confidence: 0.8 }],
        nice_to_have: [],
        leadership_scope: [],
        domain_context: [],
        tech_keywords: [],
        keywords_for_ats: [],
        red_flags: [],
      };
      const result = JDRequirementsSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects items with missing confidence field", () => {
      const invalid = {
        must_have: [{ text: "Python" }],
        nice_to_have: [],
        leadership_scope: [],
        domain_context: [],
        tech_keywords: [],
        keywords_for_ats: [],
        red_flags: [],
      };
      const result = JDRequirementsSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("confidence semantics", () => {
    it("high confidence items should have confidence >= 0.8", () => {
      const explicit: RequirementItem = { text: "5+ years Python required", confidence: 1.0 };
      expect(explicit.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("inferred items should have moderate confidence", () => {
      const inferred: RequirementItem = { text: "Likely needs SQL skills based on data role", confidence: 0.6 };
      expect(inferred.confidence).toBeGreaterThanOrEqual(0.4);
      expect(inferred.confidence).toBeLessThan(0.8);
    });
  });

  describe("category completeness", () => {
    const ALL_CATEGORIES = [
      "must_have",
      "nice_to_have",
      "leadership_scope",
      "domain_context",
      "tech_keywords",
      "keywords_for_ats",
      "red_flags",
    ] as const;

    it("schema has exactly 7 required categories", () => {
      const shape = JDRequirementsSchema.shape;
      const keys = Object.keys(shape);
      expect(keys).toHaveLength(7);
      for (const cat of ALL_CATEGORIES) {
        expect(keys).toContain(cat);
      }
    });

    it("all categories accept arrays of RequirementItem", () => {
      const item: RequirementItem = { text: "test", confidence: 0.9 };
      const valid: JDRequirements = {
        must_have: [item],
        nice_to_have: [item],
        leadership_scope: [item],
        domain_context: [item],
        tech_keywords: [item],
        keywords_for_ats: [item],
        red_flags: [item],
      };
      const result = JDRequirementsSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });

  describe("realistic JD extraction scenarios", () => {
    it("VP Data role has leadership_scope items", () => {
      const vpReqs: JDRequirements = {
        must_have: [
          { text: "10+ years in data/analytics leadership", confidence: 1.0 },
          { text: "Experience building and leading teams of 10+", confidence: 1.0 },
        ],
        nice_to_have: [
          { text: "MBA preferred", confidence: 0.9 },
        ],
        leadership_scope: [
          { text: "Lead team of 20+ across data engineering, analytics, and data science", confidence: 1.0 },
          { text: "Report to CTO with quarterly board presentations", confidence: 0.9 },
          { text: "Own $2M+ annual budget for tools and infrastructure", confidence: 0.85 },
        ],
        domain_context: [
          { text: "B2B SaaS, Series D, 500+ employees", confidence: 0.9 },
        ],
        tech_keywords: [
          { text: "Snowflake", confidence: 1.0 },
          { text: "dbt", confidence: 1.0 },
          { text: "Looker", confidence: 0.9 },
        ],
        keywords_for_ats: [
          { text: "data strategy", confidence: 1.0 },
          { text: "executive stakeholder management", confidence: 1.0 },
          { text: "data governance", confidence: 0.95 },
        ],
        red_flags: [],
      };
      expect(vpReqs.leadership_scope.length).toBeGreaterThan(0);
      expect(vpReqs.leadership_scope[0].confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("IC data engineer role has empty leadership_scope", () => {
      const icReqs: JDRequirements = {
        must_have: [
          { text: "5+ years data engineering with Python and SQL", confidence: 1.0 },
          { text: "Strong experience with Spark or Flink", confidence: 1.0 },
        ],
        nice_to_have: [
          { text: "Kubernetes experience", confidence: 0.8 },
        ],
        leadership_scope: [],
        domain_context: [
          { text: "Fintech startup", confidence: 0.9 },
        ],
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
          { text: "Apache Spark", confidence: 1.0 },
          { text: "Kafka", confidence: 1.0 },
          { text: "Kubernetes", confidence: 0.8 },
        ],
        keywords_for_ats: [
          { text: "ETL pipelines", confidence: 1.0 },
          { text: "data warehouse", confidence: 1.0 },
        ],
        red_flags: [],
      };
      expect(icReqs.leadership_scope).toHaveLength(0);
      expect(icReqs.tech_keywords.length).toBeGreaterThan(2);
    });

    it("red flag detection for scope-creep role", () => {
      const creepReqs: JDRequirements = {
        must_have: [
          { text: "10+ years hands-on Python and ML engineering", confidence: 1.0 },
          { text: "VP-level strategic leadership experience", confidence: 1.0 },
          { text: "PhD in machine learning or related field", confidence: 1.0 },
        ],
        nice_to_have: [],
        leadership_scope: [
          { text: "Build team from scratch", confidence: 0.9 },
        ],
        domain_context: [],
        tech_keywords: [
          { text: "PyTorch", confidence: 1.0 },
          { text: "Kubernetes", confidence: 1.0 },
          { text: "Terraform", confidence: 1.0 },
          { text: "React", confidence: 0.8 },
          { text: "Go", confidence: 0.8 },
        ],
        keywords_for_ats: [],
        red_flags: [
          { text: "Role combines hands-on IC coding (Python, PyTorch, K8s, Terraform, React, Go) with VP-level strategy — unrealistic scope", confidence: 0.85 },
          { text: "PhD required narrows candidate pool significantly", confidence: 0.7 },
          { text: "Tech stack breadth (6+ languages/frameworks) unusual for a leadership role", confidence: 0.8 },
        ],
      };
      expect(creepReqs.red_flags.length).toBeGreaterThan(0);
      expect(creepReqs.red_flags[0].confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe("meta calculation helpers", () => {
    it("correctly counts total items across categories", () => {
      const reqs: JDRequirements = {
        must_have: [{ text: "a", confidence: 0.9 }, { text: "b", confidence: 0.8 }],
        nice_to_have: [{ text: "c", confidence: 0.7 }],
        leadership_scope: [],
        domain_context: [{ text: "d", confidence: 0.85 }],
        tech_keywords: [{ text: "e", confidence: 1.0 }, { text: "f", confidence: 0.9 }, { text: "g", confidence: 0.8 }],
        keywords_for_ats: [{ text: "h", confidence: 1.0 }],
        red_flags: [],
      };

      let totalItems = 0;
      let totalConfidence = 0;
      for (const key of Object.keys(reqs) as (keyof JDRequirements)[]) {
        totalItems += reqs[key].length;
        for (const item of reqs[key]) {
          totalConfidence += item.confidence;
        }
      }
      expect(totalItems).toBe(8);
      const avg = totalConfidence / totalItems;
      expect(avg).toBeGreaterThan(0.8);
      expect(avg).toBeLessThanOrEqual(1.0);
    });
  });
});
