import { describe, it, expect } from "vitest";
import { evaluateRules } from "../src/mastra/tools/hardFlagEngine";
import type { HardFlagRule } from "../src/mastra/tools/hardFlagRules";
import { HARD_FLAG_RULES } from "../src/mastra/tools/hardFlagRules";

function makeJob(
  overrides: Partial<{
    title: string;
    jd_raw_text: string;
    location: string;
    remote_hybrid: string;
  }>,
) {
  return {
    title: overrides.title || "",
    jd_raw_text: overrides.jd_raw_text || "",
    location: overrides.location || "",
    remote_hybrid: overrides.remote_hybrid || "",
  };
}

const INVENTORY = {
  profile: { name: "Ed Martinez", location: "Chicago, IL" },
  skills: {
    technical: ["Python", "SQL", "Snowflake", "Kubernetes", "Docker", "Git"],
    data_science: ["Machine Learning", "Deep Learning", "NLP", "MLOps"],
    domains: ["Financial Services", "Healthcare"],
  },
};

describe("Hard Flag Engine", () => {
  describe("Rule 1: CI/CD + K8s+MLOps (hf-001)", () => {
    it("fires for 'building ci/cd pipelines'", () => {
      const job = makeJob({
        title: "VP of ML Platform",
        jd_raw_text:
          "Must have hands-on experience building CI/CD pipelines and deploying models at scale",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf1 = result.flags.find((f) => f.ruleId === "hf-001");
      expect(hf1).toBeDefined();
      expect(
        result.gateOverride === "REVIEW" || result.gateOverride === "NO",
      ).toBe(true);
      expect(result.scoreAdjustment).toBeLessThanOrEqual(-10);
    });

    it("fires for K8s+MLOps combo", () => {
      const job = makeJob({
        title: "VP of ML Platform",
        jd_raw_text:
          "Lead kubernetes and mlops platform team to build scalable infrastructure",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf1 = result.flags.find((f) => f.ruleId === "hf-001");
      expect(hf1).toBeDefined();
    });

    it("does NOT fire when inventory has DevOps tools", () => {
      const inventoryWithDevOps = {
        ...INVENTORY,
        skills: {
          ...INVENTORY.skills,
          technical: [...INVENTORY.skills.technical, "Terraform", "Jenkins"],
        },
      };
      const job = makeJob({
        title: "VP of ML Platform",
        jd_raw_text: "Must have hands-on experience building CI/CD pipelines",
      });
      const result = evaluateRules(job, inventoryWithDevOps, HARD_FLAG_RULES);
      const hf1 = result.flags.find((f) => f.ruleId === "hf-001");
      expect(hf1).toBeUndefined();
    });
  });

  describe("Rule 2: Sponsorship restriction (hf-002)", () => {
    it("fires for sponsorship restriction + needs_sponsorship=true", () => {
      const job = makeJob({
        jd_raw_text:
          "Candidates must be authorized to work in the United States. We will not sponsor visas.",
      });
      const inventoryNeedsSponsor = {
        ...INVENTORY,
        profile: { ...INVENTORY.profile, needs_sponsorship: true },
      };
      const result = evaluateRules(job, inventoryNeedsSponsor, HARD_FLAG_RULES);
      const hf2 = result.flags.find((f) => f.ruleId === "hf-002");
      expect(hf2).toBeDefined();
      expect(result.gateOverride).toBe("NO");
      expect(hf2?.message).toContain("sponsorship");
    });

    it("does NOT fire when needs_sponsorship is absent", () => {
      const job = makeJob({
        jd_raw_text:
          "Must be authorized to work in the US. No sponsorship available.",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf2 = result.flags.find((f) => f.ruleId === "hf-002");
      expect(hf2).toBeUndefined();
    });
  });

  describe("Rule 3: Onsite-only location mismatch (hf-003)", () => {
    it("fires for onsite-only non-Chicago location", () => {
      const job = makeJob({
        title: "VP Data & AI",
        jd_raw_text:
          "This is an onsite only position in our San Francisco headquarters. No remote.",
        location: "San Francisco, CA",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf3 = result.flags.find((f) => f.ruleId === "hf-003");
      expect(hf3).toBeDefined();
      expect(
        result.gateOverride === "REVIEW" || result.gateOverride === "NO",
      ).toBe(true);
    });

    it("does NOT fire for onsite-only Chicago", () => {
      const job = makeJob({
        title: "VP Data & AI",
        jd_raw_text: "This is an onsite only position in our Chicago office.",
        location: "Chicago, IL",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf3 = result.flags.find((f) => f.ruleId === "hf-003");
      expect(hf3).toBeUndefined();
    });
  });

  describe("Rule 4: PhD required (hf-004)", () => {
    it("fires for PhD required without PhD in inventory", () => {
      const job = makeJob({
        title: "Head of Data Science",
        jd_raw_text:
          "PhD required in Computer Science, Statistics, or related quantitative field.",
      });
      const inventoryNoPhD = {
        ...INVENTORY,
        education: ["MBA", "BS Computer Science"],
      };
      const result = evaluateRules(job, inventoryNoPhD, HARD_FLAG_RULES);
      const hf4 = result.flags.find((f) => f.ruleId === "hf-004");
      expect(hf4).toBeDefined();
      expect(result.scoreAdjustment).toBeLessThanOrEqual(-5);
    });

    it("does NOT fire when inventory has PhD", () => {
      const job = makeJob({
        title: "Head of Data Science",
        jd_raw_text: "PhD required in Computer Science.",
      });
      const inventoryWithPhD = {
        ...INVENTORY,
        education: ["PhD Computer Science", "BS Mathematics"],
      };
      const result = evaluateRules(job, inventoryWithPhD, HARD_FLAG_RULES);
      const hf4 = result.flags.find((f) => f.ruleId === "hf-004");
      expect(hf4).toBeUndefined();
    });
  });

  describe("Rule 5: IC/Staff engineer mislabel (hf-005)", () => {
    it("fires for 'Staff Engineer' title", () => {
      const job = makeJob({
        title: "Staff Engineer, Machine Learning",
        jd_raw_text: "Design and implement ML systems at scale.",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf5 = result.flags.find((f) => f.ruleId === "hf-005");
      expect(hf5).toBeDefined();
      expect(result.gateOverride).toBe("NO");
      expect(result.scoreAdjustment).toBeLessThanOrEqual(-15);
    });

    it("fires for 'Principal Scientist' title", () => {
      const job = makeJob({
        title: "Principal Scientist, AI Research",
        jd_raw_text: "Conduct cutting-edge research in AI.",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf5 = result.flags.find((f) => f.ruleId === "hf-005");
      expect(hf5).toBeDefined();
    });

    it("does NOT fire for VP title", () => {
      const job = makeJob({
        title: "VP of Data & AI",
        jd_raw_text: "Lead the enterprise data strategy.",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      const hf5 = result.flags.find((f) => f.ruleId === "hf-005");
      expect(hf5).toBeUndefined();
    });
  });

  describe("Edge Cases", () => {
    it("clean job: no flags, gate is PASS, adjustment is 0", () => {
      const job = makeJob({
        title: "VP Data",
        jd_raw_text: "Lead analytics strategy",
      });
      const result = evaluateRules(job, INVENTORY, HARD_FLAG_RULES);
      expect(result.flags.length).toBe(0);
      expect(result.gateOverride).toBe("PASS");
      expect(result.scoreAdjustment).toBe(0);
    });

    it("all rules disabled: no flags fire, gate is PASS", () => {
      const allRulesDisabled = HARD_FLAG_RULES.map((r) => ({
        ...r,
        enabled: false,
      }));
      const job = makeJob({
        title: "Staff Engineer",
        jd_raw_text:
          "Build CI/CD, PhD required, onsite only San Francisco, no sponsorship",
        location: "San Francisco",
      });
      const inventoryNeedsSponsor = {
        ...INVENTORY,
        profile: { ...INVENTORY.profile, needs_sponsorship: true },
      };
      const result = evaluateRules(
        job,
        inventoryNeedsSponsor,
        allRulesDisabled,
      );
      expect(result.flags.length).toBe(0);
      expect(result.gateOverride).toBe("PASS");
    });

    it("multi-rule trigger: multiple flags fire, worst gate is NO, flags sorted", () => {
      const job = makeJob({
        title: "Staff Engineer, ML Platform",
        jd_raw_text:
          "Hands-on building CI/CD pipelines. PhD required. Must be onsite only in our NYC office. Will not sponsor visas.",
        location: "New York, NY",
      });
      const inv = {
        ...INVENTORY,
        profile: { ...INVENTORY.profile, needs_sponsorship: true },
        education: ["MBA"],
      };
      const result = evaluateRules(job, inv, HARD_FLAG_RULES);
      expect(result.flags.length).toBeGreaterThanOrEqual(4);
      expect(result.gateOverride).toBe("NO");
      expect(result.flags.map((f) => f.ruleId)).toEqual(
        [...result.flags.map((f) => f.ruleId)].sort(),
      );
    });
  });
});
