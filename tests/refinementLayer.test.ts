/**
 * Tests for the Final Refinement Layer
 *
 * Covers all 6 dimensions:
 * 1. Verb Integrity Control (whitelist + semantic validation)
 * 2. Mandate-Anchoring Summary Rule
 * 3. Authority Without Hype
 * 4. Differentiation Strengthening
 * 5. QA Stability Pass
 * 6. Refinement Scoring
 */

import { describe, it, expect } from "vitest";
import {
  VERB_WHITELIST,
  ALL_APPROVED_VERBS,
  inferContentCategory,
  getVerbCategories,
  checkVerbAlignment,
  checkMandateAnchoredSummary,
  checkAuthorityWithoutHype,
  checkDifferentiationStrength,
  findSuppressedPhrasesInResume,
  INFLATED_ADJECTIVES,
  PHRASE_SUPPRESSION_LIST,
  runRefinementLayer,
  type RefinementInput,
} from "../src/resume-engine/refinement-layer";
import type { MandateProfile } from "../src/resume-engine/stage2-mandate-classifier/classifier";

// ── Test Helpers ────────────────────────────────────────────────

function makeMandate(primary: string): MandateProfile {
  return {
    primary_mandate: primary,
    secondary_mandates: [],
    top_3_archetypes: [{ id: primary, label: primary, score: 5 }],
    seniority_level: "VP",
    calibrated_headline: "Test Headline",
    tone_guidance: {
      seniority: "VP",
      summary_posture: "direct",
      bullet_framing: "outcome-first",
      competency_emphasis: "mandate-aligned",
      headline_tone: "authoritative",
    },
    gaps_vs_inventory: [],
    dimensions: [],
  };
}

function makeResume(overrides: any = {}) {
  return {
    target_company: "TestCo",
    target_role: "VP Analytics",
    professional_summary: overrides.summary || "Built and scaled a 45-person analytics organization across 4 business units, establishing governance frameworks and standardized reporting cadences.",
    executive_headline: overrides.headline || "VP, Data & Analytics",
    core_competencies: overrides.competencies || ["Data Governance", "Platform Architecture", "Team Leadership"],
    experience: overrides.experience || [
      {
        employer: "Acme Corp",
        title: "VP Analytics",
        start_date: "2020-01",
        end_date: "Present",
        scope_line: "45 FTEs | $8M budget | 4 BUs",
        bullets: [
          { text: "Built a 45-person analytics organization spanning 4 business units", source_hash: "inv-1", evidence_quote: "Built analytics team from 3 to 45", claim_ids: ["cl-1"] },
          { text: "Implemented Snowflake-based data platform reducing query latency by 80%", source_hash: "inv-2", evidence_quote: "Implemented Snowflake data platform", claim_ids: ["cl-2"] },
          { text: "Standardized KPI frameworks across all divisions — single source of truth", source_hash: "inv-3", evidence_quote: "Standardized KPI framework", claim_ids: ["cl-3"] },
        ],
      },
      {
        employer: "Beta Inc",
        title: "Director Analytics",
        start_date: "2016-06",
        end_date: "2019-12",
        scope_line: "20 FTEs | $3M budget",
        bullets: [
          { text: "Drove $12M annual revenue growth through predictive analytics models", source_hash: "inv-4", evidence_quote: "Drove $12M revenue growth via models", claim_ids: ["cl-4"] },
          { text: "Scaled team from 5 to 20 analysts across 2 offices", source_hash: "inv-5", evidence_quote: "Scaled analytics team from 5 to 20", claim_ids: ["cl-5"] },
        ],
      },
    ],
    education: [{ institution: "MIT", degree: "MBA", year: "2010" }],
    certifications: [],
    skills: { tools_and_platforms: ["Snowflake", "dbt", "Python"] },
    gap_notes: [],
    ats_keywords: ["analytics", "governance"],
  };
}

// ── 1. Verb Whitelist Tests ────────────────────────────────────

describe("Verb Whitelist", () => {
  it("contains all required categories", () => {
    expect(VERB_WHITELIST).toHaveProperty("build_scale");
    expect(VERB_WHITELIST).toHaveProperty("transform_redesign");
    expect(VERB_WHITELIST).toHaveProperty("generate_drive");
    expect(VERB_WHITELIST).toHaveProperty("implement_deploy");
    expect(VERB_WHITELIST).toHaveProperty("standardize_operationalize");
    expect(VERB_WHITELIST).toHaveProperty("influence_advise");
    expect(VERB_WHITELIST).toHaveProperty("optimize_improve");
    expect(VERB_WHITELIST).toHaveProperty("mentor_develop");
  });

  it("ALL_APPROVED_VERBS aggregates all verbs", () => {
    expect(ALL_APPROVED_VERBS.has("built")).toBe(true);
    expect(ALL_APPROVED_VERBS.has("implemented")).toBe(true);
    expect(ALL_APPROVED_VERBS.has("standardized")).toBe(true);
    expect(ALL_APPROVED_VERBS.has("drove")).toBe(true);
    expect(ALL_APPROVED_VERBS.has("mentored")).toBe(true);
  });
});

describe("inferContentCategory", () => {
  it("detects build_scale from team content", () => {
    expect(inferContentCategory("Built a 45-person analytics organization")).toBe("build_scale");
  });

  it("detects generate_drive from revenue content", () => {
    expect(inferContentCategory("Drove $12M annual revenue growth")).toBe("generate_drive");
  });

  it("detects implement_deploy from platform content", () => {
    expect(inferContentCategory("Deployed Snowflake-based data platform")).toBe("implement_deploy");
  });

  it("detects standardize_operationalize from governance content", () => {
    expect(inferContentCategory("Standardized compliance frameworks across divisions")).toBe("standardize_operationalize");
  });

  it("returns null for ambiguous content", () => {
    expect(inferContentCategory("Did some things")).toBeNull();
  });
});

describe("getVerbCategories", () => {
  it("finds categories for a verb", () => {
    const cats = getVerbCategories("built");
    expect(cats).toContain("build_scale");
  });

  it("returns empty for unknown verbs", () => {
    expect(getVerbCategories("xyzverb")).toEqual([]);
  });

  it("verb can belong to multiple categories", () => {
    const cats = getVerbCategories("established");
    expect(cats.length).toBeGreaterThanOrEqual(1);
  });
});

describe("checkVerbAlignment", () => {
  it("aligned: build verb + team content", () => {
    const result = checkVerbAlignment("built", "Built a 45-person analytics team");
    expect(result.aligned).toBe(true);
  });

  it("misaligned: build verb + revenue content", () => {
    const result = checkVerbAlignment("recruited", "$12M annual revenue growth through pricing analytics");
    expect(result.aligned).toBe(false);
    expect(result.explanation).toContain("build_scale");
    expect(result.explanation).toContain("generate_drive");
  });

  it("misaligned: mentor verb + platform content", () => {
    const result = checkVerbAlignment("mentored", "Mentored the Snowflake data platform migration");
    expect(result.aligned).toBe(false);
  });

  it("unknown verb accepted as-is", () => {
    const result = checkVerbAlignment("spearheaded", "Spearheaded the initiative");
    expect(result.aligned).toBe(true);
    expect(result.explanation).toContain("not in whitelist");
  });

  it("ambiguous content accepts any whitelisted verb", () => {
    const result = checkVerbAlignment("built", "Did various things across the org");
    expect(result.aligned).toBe(true);
    expect(result.explanation).toContain("ambiguous");
  });
});

// ── 2. Mandate-Anchoring Summary Tests ─────────────────────────

describe("checkMandateAnchoredSummary", () => {
  it("anchored: governance mandate + governance keywords", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkMandateAnchoredSummary(
      "Established enterprise-wide governance frameworks that standardized reporting across 4 BUs.",
      mandate,
    );
    expect(result.first_sentence_anchored).toBe(true);
    expect(result.uses_generic_opener).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it("not anchored: governance mandate + revenue-first summary", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkMandateAnchoredSummary(
      "Generated $50M in revenue growth by leveraging analytics insights.",
      mandate,
    );
    expect(result.first_sentence_anchored).toBe(false);
    expect(result.revenue_first_non_revenue).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("detects generic opener: 'Data and analytics leader who'", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkMandateAnchoredSummary(
      "Data and analytics leader who drives governance and standardization.",
      mandate,
    );
    expect(result.uses_generic_opener).toBe(true);
    expect(result.issues.some(i => i.includes("generic pattern"))).toBe(true);
  });

  it("detects generic opener: 'Seasoned executive'", () => {
    const mandate = makeMandate("bi_modernization");
    const result = checkMandateAnchoredSummary(
      "Seasoned executive with 20 years of platform modernization experience.",
      mandate,
    );
    expect(result.uses_generic_opener).toBe(true);
  });

  it("revenue-first is OK for revenue mandate", () => {
    const mandate = makeMandate("revenue_ops_forecasting");
    const result = checkMandateAnchoredSummary(
      "Delivered $50M in revenue growth through demand forecasting and pricing optimization.",
      mandate,
    );
    expect(result.revenue_first_non_revenue).toBe(false);
  });

  it("revenue-first flagged for team leadership mandate", () => {
    const mandate = makeMandate("team_scale_org_design");
    const result = checkMandateAnchoredSummary(
      "Generated $12M ARR through analytics-driven pricing models.",
      mandate,
    );
    expect(result.revenue_first_non_revenue).toBe(true);
  });
});

// ── 3. Authority Without Hype Tests ────────────────────────────

describe("checkAuthorityWithoutHype", () => {
  it("replaces inflated adjectives in-place", () => {
    const resume = makeResume({
      summary: "An unprecedented transformation of the analytics powerhouse organization.",
    });
    const result = checkAuthorityWithoutHype(resume);
    expect(result.issues.some(i => i.label === "unprecedented" || i.text === "unprecedented")).toBeTruthy();
    expect(result.issues.some(i => i.label === "powerhouse" || i.text === "powerhouse")).toBeTruthy();
    // Check auto-fix happened
    expect(resume.professional_summary).not.toContain("unprecedented");
    expect(resume.professional_summary).not.toContain("powerhouse");
    expect(resume.professional_summary).toContain("notable");
    expect(resume.professional_summary).toContain("high-performing");
  });

  it("flags ungrounded board attribution", () => {
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Drove board decision to invest $50M in data infrastructure";
    resume.experience[0].bullets[0].evidence_quote = "Presented to leadership on data strategy";
    const result = checkAuthorityWithoutHype(resume);
    expect(result.issues.some(i => i.type === "ungrounded_attribution")).toBe(true);
  });

  it("no issues for clean resume", () => {
    const resume = makeResume();
    const result = checkAuthorityWithoutHype(resume);
    expect(result.issues.filter(i => i.type === "inflated_adjective")).toHaveLength(0);
  });
});

describe("INFLATED_ADJECTIVES list", () => {
  it("contains key hype adjectives", () => {
    const labels = INFLATED_ADJECTIVES.map(a => a.label);
    expect(labels).toContain("powerhouse");
    expect(labels).toContain("unprecedented");
    expect(labels).toContain("single-handedly");
    expect(labels).toContain("exponential");
    expect(labels).toContain("massive");
  });
});

// ── 4. Differentiation Tests ───────────────────────────────────

describe("checkDifferentiationStrength", () => {
  it("no issues with no prior history", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const result = checkDifferentiationStrength(resume, mandate);
    expect(result.force_structural_rewrite).toBe(false);
    expect(result.worst_summary_overlap).toBe(0);
  });

  it("flags high summary overlap > 35%", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    // Prior summary with very similar content
    const priorSummaries = [resume.professional_summary]; // Same text = 100% overlap
    const result = checkDifferentiationStrength(resume, mandate, priorSummaries);
    expect(result.force_structural_rewrite).toBe(true);
    expect(result.worst_summary_overlap).toBeGreaterThan(35);
    expect(result.issues.some(i => i.includes("structural rewrite"))).toBe(true);
  });

  it("flags competency overlap > 50%", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const priorComps = [["Data Governance", "Platform Architecture", "Team Leadership"]];
    const result = checkDifferentiationStrength(resume, mandate, undefined, priorComps);
    expect(result.worst_competency_overlap).toBeGreaterThan(50);
    expect(result.issues.some(i => i.includes("Competency overlap"))).toBe(true);
  });

  it("detects non-mandate-sorted competencies", () => {
    const resume = makeResume({
      competencies: ["Machine Learning", "Deep Learning", "NLP"],
    });
    const mandate = makeMandate("governance_standardization");
    const result = checkDifferentiationStrength(resume, mandate);
    expect(result.competencies_mandate_sorted).toBe(false);
    expect(result.issues.some(i => i.includes("not mandate-sorted"))).toBe(true);
  });

  it("accepts mandate-sorted competencies", () => {
    const resume = makeResume({
      competencies: ["Data Governance", "Compliance Frameworks", "Audit Automation"],
    });
    const mandate = makeMandate("governance_standardization");
    const result = checkDifferentiationStrength(resume, mandate);
    expect(result.competencies_mandate_sorted).toBe(true);
  });
});

describe("findSuppressedPhrasesInResume", () => {
  it("finds banned phrases in resume text", () => {
    const resume = makeResume({
      summary: "A data-driven leader with a track record of driving value through actionable insights.",
    });
    const found = findSuppressedPhrasesInResume(resume);
    expect(found).toContain("track record of");
    expect(found).toContain("driving value");
    expect(found).toContain("actionable insights");
  });

  it("returns empty for clean resume", () => {
    const resume = makeResume();
    const found = findSuppressedPhrasesInResume(resume);
    expect(found).toHaveLength(0);
  });
});

describe("PHRASE_SUPPRESSION_LIST", () => {
  it("contains core banned phrases", () => {
    expect(PHRASE_SUPPRESSION_LIST).toContain("track record of");
    expect(PHRASE_SUPPRESSION_LIST).toContain("proven ability to");
    expect(PHRASE_SUPPRESSION_LIST).toContain("data-driven leader");
    expect(PHRASE_SUPPRESSION_LIST).toContain("cutting-edge");
    expect(PHRASE_SUPPRESSION_LIST).toContain("actionable insights");
    expect(PHRASE_SUPPRESSION_LIST).toContain("career defined by");
  });
});

// ── 5. QA Stability Pass (via runRefinementLayer) ──────────────

describe("QA Stability Pass", () => {
  it("detects malformed tokens in bullets", () => {
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Implementeded the analytics platform";
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });
    // The QA stability pass should catch this
    expect(result.qa_issues.some(i => i.type === "corruption" || i.type === "malformed_token")).toBe(true);
  });

  it("detects ownership inflation pattern", () => {
    const resume = makeResume();
    // Bullet claims "built" but evidence says "contributed"
    resume.experience[0].bullets[0].text = "Built the entire analytics platform from scratch";
    resume.experience[0].bullets[0].evidence_quote = "contributed to analytics platform development";
    resume.experience[0].bullets[0].source_hash = "contributed to platform";
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });
    expect(result.qa_issues.some(i => i.type === "ownership_inflation")).toBe(true);
  });

  it("checks mandate alignment in first 2 bullets", () => {
    const resume = makeResume({
      experience: [
        {
          employer: "TestCo",
          title: "VP",
          start_date: "2020-01",
          end_date: "Present",
          scope_line: "50 FTEs",
          bullets: [
            { text: "Organized team offsites and retreats", source_hash: "s1", evidence_quote: "e1", claim_ids: ["c1"] },
            { text: "Arranged quarterly reviews for management", source_hash: "s2", evidence_quote: "e2", claim_ids: ["c2"] },
          ],
        },
      ],
    });
    const mandate = makeMandate("bi_modernization");
    const result = runRefinementLayer({ resume, mandate });
    expect(result.qa_issues.some(i => i.type === "mandate_gap")).toBe(true);
  });
});

// ── 6. Composite Scoring Tests ─────────────────────────────────

describe("runRefinementLayer", () => {
  it("returns all score dimensions", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });

    expect(result.scores).toHaveProperty("verb_integrity");
    expect(result.scores).toHaveProperty("mandate_alignment");
    expect(result.scores).toHaveProperty("ownership_inflation");
    expect(result.scores).toHaveProperty("differentiation");
    expect(result.scores).toHaveProperty("executive_authority");
    expect(result.scores).toHaveProperty("composite");
    expect(result.scores).toHaveProperty("grade");
  });

  it("scores are 0-100 range", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });

    expect(result.scores.verb_integrity).toBeGreaterThanOrEqual(0);
    expect(result.scores.verb_integrity).toBeLessThanOrEqual(100);
    expect(result.scores.mandate_alignment).toBeGreaterThanOrEqual(0);
    expect(result.scores.mandate_alignment).toBeLessThanOrEqual(100);
    expect(result.scores.ownership_inflation).toBeGreaterThanOrEqual(0);
    expect(result.scores.ownership_inflation).toBeLessThanOrEqual(100);
    expect(result.scores.differentiation).toBeGreaterThanOrEqual(0);
    expect(result.scores.differentiation).toBeLessThanOrEqual(100);
    expect(result.scores.executive_authority).toBeGreaterThanOrEqual(0);
    expect(result.scores.executive_authority).toBeLessThanOrEqual(100);
    expect(result.scores.composite).toBeGreaterThanOrEqual(0);
    expect(result.scores.composite).toBeLessThanOrEqual(100);
  });

  it("grade maps correctly", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });

    const grade = result.scores.grade;
    expect(["A", "B", "C", "D", "F"]).toContain(grade);

    if (result.scores.composite >= 90) expect(grade).toBe("A");
    else if (result.scores.composite >= 80) expect(grade).toBe("B");
    else if (result.scores.composite >= 70) expect(grade).toBe("C");
    else if (result.scores.composite >= 60) expect(grade).toBe("D");
    else expect(grade).toBe("F");
  });

  it("clean resume passes with good scores", () => {
    const resume = makeResume({
      summary: "Established enterprise-wide governance frameworks that standardized reporting across 4 business units, enforcing metric discipline and data quality.",
    });
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });

    // Clean resume should have good verb integrity and ownership scores
    expect(result.scores.verb_integrity).toBeGreaterThanOrEqual(70);
    expect(result.scores.ownership_inflation).toBe(100);
    expect(result.verb_issues.filter(v => v.issue === "misaligned")).toHaveLength(0);
  });

  it("hype-heavy resume gets lower executive authority", () => {
    const resume = makeResume({
      summary: "An unprecedented, transformative powerhouse who single-handedly disrupted the analytics landscape with exponential growth.",
    });
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });

    // Should have many hype issues and lower authority score
    expect(result.hype_issues.length).toBeGreaterThan(0);
    expect(result.scores.executive_authority).toBeLessThan(80);
  });

  it("includes duration_ms", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns actions_taken for auto-fixes", () => {
    const resume = makeResume({
      summary: "A massive, unprecedented transformation of the analytics function.",
    });
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });
    expect(result.actions_taken.length).toBeGreaterThan(0);
  });

  it("blocking issues cause passed=false", () => {
    const resume = makeResume({
      summary: "Data and analytics leader who has transformed organizations through cutting-edge insights.",
    });
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });
    // Generic opener should be blocking
    expect(result.passed).toBe(false);
    expect(result.blocking_issues.length).toBeGreaterThan(0);
  });
});

// ── Verb Integrity: No Blind Mutation ──────────────────────────

describe("Verb Integrity: no blind mutation", () => {
  it("does not mutate bullet text for misaligned verbs", () => {
    const resume = makeResume();
    const originalText = resume.experience[0].bullets[0].text;
    const mandate = makeMandate("governance_standardization");
    runRefinementLayer({ resume, mandate });
    // The refinement layer should NOT mutate bullet verbs
    expect(resume.experience[0].bullets[0].text).toBe(originalText);
  });

  it("flags but does not replace misaligned verbs", () => {
    const resume = makeResume({
      experience: [{
        employer: "TestCo",
        title: "VP",
        start_date: "2020-01",
        end_date: "Present",
        scope_line: "50 FTEs",
        bullets: [
          { text: "Mentored the Snowflake data platform migration to cloud", source_hash: "s1", evidence_quote: "e1", claim_ids: ["c1"] },
        ],
      }],
    });
    const mandate = makeMandate("bi_modernization");
    const result = runRefinementLayer({ resume, mandate });

    // Should flag the misalignment
    const misaligned = result.verb_issues.filter(v => v.issue === "misaligned");
    expect(misaligned.length).toBeGreaterThan(0);
    expect(misaligned[0].verb.toLowerCase()).toBe("mentored");

    // But should NOT change the bullet text
    expect(resume.experience[0].bullets[0].text).toContain("Mentored");
  });
});

// ── Integration: mandate-specific scoring ──────────────────────

describe("Mandate-specific scoring integration", () => {
  it("governance mandate scores well with governance summary", () => {
    const resume = makeResume({
      summary: "Codified enterprise governance frameworks across 4 BUs, establishing metric standardization and reporting rigor that eliminated $2M in data quality costs.",
    });
    const mandate = makeMandate("governance_standardization");
    const result = runRefinementLayer({ resume, mandate });
    expect(result.scores.mandate_alignment).toBeGreaterThanOrEqual(50);
  });

  it("platform mandate scores well with architecture summary", () => {
    const resume = makeResume({
      summary: "Architected a cloud-native data platform serving 2,000 analysts, migrating from legacy infrastructure to Snowflake with zero downtime.",
    });
    const mandate = makeMandate("bi_modernization");
    const result = runRefinementLayer({ resume, mandate });
    expect(result.scores.mandate_alignment).toBeGreaterThanOrEqual(50);
  });

  it("mismatched mandate lowers alignment score", () => {
    const resume = makeResume({
      summary: "Recruited and mentored a team of 30 analysts, building a culture of continuous learning.",
    });
    const mandate = makeMandate("bi_modernization");
    const result = runRefinementLayer({ resume, mandate });
    // Team leadership summary for a platform mandate should score lower
    expect(result.scores.mandate_alignment).toBeLessThan(50);
  });
});
