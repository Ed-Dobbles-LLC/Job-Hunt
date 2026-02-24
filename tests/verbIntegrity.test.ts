/**
 * Verb Integrity + Semantic Drift Guard — Tests
 *
 * Tests cover:
 *   1. Corruption detection: "Influencedd", "Briefedd", "Mentoredd", doubled suffixes
 *   2. Semantic drift: "Mentored growth…" → replacement verb
 *   3. Facts/numbers/tools unchanged after repair
 *   4. Bullet word count within tolerance after repair
 *   5. Hype verb flagging
 *   6. Category inference from content cues
 */

import { describe, it, expect } from "vitest";
import {
  runVerbIntegrityGuard,
  CORRUPTION_PATTERNS,
  CATEGORY_VERB_MAP,
  MISFIT_VERBS,
  HYPE_VERB_LIST,
} from "../src/resume-engine/qa/verbIntegrityGuard";

// ── Test Fixture ────────────────────────────────────────────────

function makeTestResume(overrides?: { bullets?: Array<{ text: string; [key: string]: any }> }): any {
  const defaultBullets = [
    { text: "Led a 45-person data organization spanning analytics engineering and BI", source_hash: "h1", evidence_quote: "Led a 45-person", claim_ids: ["cl-0-metric-2"] },
    { text: "Delivered $12M annual cost savings through Snowflake migration", source_hash: "h2", evidence_quote: "Delivered $12M", claim_ids: ["cl-0-metric-1"] },
    { text: "Built real-time reporting dashboard serving 200+ stakeholders", source_hash: "h3", evidence_quote: "Built real-time", claim_ids: ["cl-0-tool-1"] },
  ];

  return {
    professional_summary: "Data platform leader who architected enterprise Snowflake migrations.",
    executive_headline: "VP, Data & Analytics",
    target_role: "VP, Data & Analytics",
    target_company: "TestCorp",
    ats_keywords_used: ["Snowflake", "data governance"],
    core_competencies: ["Data Governance", "Analytics Engineering"],
    experience: [
      {
        employer: "Acme Financial Group",
        title: "VP of Data & Analytics",
        start_date: "2021-03",
        end_date: "present",
        location: "Chicago, IL",
        bullets: overrides?.bullets || defaultBullets,
      },
    ],
    education: [],
    certifications: [],
    skills: { tools_and_platforms: [], enterprise_capabilities: [] },
    gap_notes: [],
    evidence_pointers: [],
  };
}

// ── Corruption Detection Tests ──────────────────────────────────

describe("Corruption Detection", () => {
  it("detects 'Influencedd' and fixes to 'Influenced'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Influencedd team to adopt modern analytics practices", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    expect(result.issues.length).toBeGreaterThan(0);
    const corruptionIssue = result.issues.find(i => i.type === "CORRUPTION" && i.original === "Influencedd");
    expect(corruptionIssue).toBeDefined();
    expect(corruptionIssue!.replacement).toBe("Influenced");
    expect(corruptionIssue!.auto_fixed).toBe(true);
    // Verify the text was actually fixed
    expect(resume.experience[0].bullets[0].text).toBe("Influenced team to adopt modern analytics practices");
  });

  it("detects 'Briefedd' and fixes to 'Briefed'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Briefedd executive leadership on quarterly analytics roadmap", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const issue = result.issues.find(i => i.original === "Briefedd");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe("Briefed");
    expect(resume.experience[0].bullets[0].text).toContain("Briefed");
  });

  it("detects 'Mentoredd' and fixes to 'Mentored'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Mentoredd 12 junior analysts on SQL best practices", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const issue = result.issues.find(i => i.original === "Mentoredd");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe("Mentored");
    expect(resume.experience[0].bullets[0].text).toContain("Mentored");
  });

  it("detects 'Recruitedd' and fixes to 'Recruited'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Recruitedd 15 senior engineers across 3 offices", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const issue = result.issues.find(i => i.original === "Recruitedd");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe("Recruited");
  });

  it("detects doubled '-ed' suffix: 'implementeded'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Implementeded a data governance framework across 3 BUs", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const issue = result.issues.find(i => i.type === "CORRUPTION");
    expect(issue).toBeDefined();
    expect(issue!.auto_fixed).toBe(true);
  });

  it("detects doubled '-ing' suffix: 'managinging'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Responsible for managinging quarterly OKR reporting cadence", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const issue = result.issues.find(i => i.type === "CORRUPTION" && i.original.includes("managinging"));
    expect(issue).toBeDefined();
    expect(issue!.auto_fixed).toBe(true);
  });

  it("detects corruption in professional_summary", () => {
    const resume = makeTestResume();
    resume.professional_summary = "Experiencedd data leader driving platform modernization.";

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const issue = result.issues.find(i => i.location === "resume.professional_summary");
    expect(issue).toBeDefined();
    expect(resume.professional_summary).toContain("Experienced");
  });

  it("does not corrupt 'succeeded', 'exceeded', 'needed'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Succeeded in delivering $3.2M revenue growth while exceeding quarterly targets", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
        { text: "Exceeded expectations by implementing needed infrastructure changes", source_hash: "h2", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    // These are legitimate words, not doubled suffixes
    const corruptionIssues = result.issues.filter(i => i.type === "CORRUPTION");
    expect(corruptionIssues.length).toBe(0);
    expect(resume.experience[0].bullets[0].text).toContain("Succeeded");
    expect(resume.experience[0].bullets[0].text).toContain("exceeding");
    expect(resume.experience[0].bullets[1].text).toContain("Exceeded");
    expect(resume.experience[0].bullets[1].text).toContain("needed");
  });

  it("does not corrupt 'singing', 'bringing', 'ringing'", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Bringing together cross-functional stakeholders for quarterly planning", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    const corruptionIssues = result.issues.filter(i => i.type === "CORRUPTION");
    expect(corruptionIssues.length).toBe(0);
    expect(resume.experience[0].bullets[0].text).toContain("Bringing");
  });

  it("does not flag legitimate 'add' or 'odd' words", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Added new ETL pipelines for odd data formats across systems", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    // Should have no corruption issues
    const corruptionIssues = result.issues.filter(i => i.type === "CORRUPTION");
    expect(corruptionIssues).toHaveLength(0);
  });

  it("does not modify resume when detectOnly=true", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Influencedd team to adopt modern practices", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: true });

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].auto_fixed).toBe(false);
    // Text should NOT be modified
    expect(resume.experience[0].bullets[0].text).toContain("Influencedd");
  });
});

// ── Semantic Drift Detection Tests ──────────────────────────────

describe("Semantic Drift Detection", () => {
  it("detects 'Mentored growth from…' and replaces with revenue verb", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Mentored growth from $5M to $15M ARR through strategic partnerships", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const driftIssue = result.issues.find(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssue).toBeDefined();
    expect(driftIssue!.original).toBe("mentored");
    expect(driftIssue!.category).toBe("growth_revenue");
    expect(driftIssue!.auto_fixed).toBe(true);

    // The leading verb should have been replaced
    const newText = resume.experience[0].bullets[0].text;
    expect(newText).not.toMatch(/^Mentored/);
    // Should start with a growth/revenue verb
    const leadingWord = newText.split(/\s+/)[0].toLowerCase();
    expect(CATEGORY_VERB_MAP.growth_revenue.valid_verbs).toContain(leadingWord);
  });

  it("detects 'Organized analytics model…' and replaces", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Organized analytics model deployment pipeline on Kubernetes", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume, { detectOnly: false });

    const driftIssue = result.issues.find(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssue).toBeDefined();
    expect(driftIssue!.original).toBe("organized");
    expect(driftIssue!.auto_fixed).toBe(true);
  });

  it("detects 'Coached insights team…' as drift for build/scale", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Coached insights team from 5 to 25 FTEs across 3 offices", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    const driftIssue = result.issues.find(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssue).toBeDefined();
    expect(driftIssue!.original).toBe("coached");
  });

  it("detects 'Elevated Big Relief…' as drift for platform content", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Elevated data platform infrastructure to support 10x throughput on AWS", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    const driftIssue = result.issues.find(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssue).toBeDefined();
    expect(driftIssue!.original).toBe("elevated");
  });

  it("does NOT flag 'Mentored' for interpersonal content", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Mentored 12 junior analysts on advanced SQL and dashboard design", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    // "Mentored" with no category cues shouldn't trigger drift
    const driftIssues = result.issues.filter(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssues).toHaveLength(0);
  });

  it("does NOT flag 'Built' for build/scale content", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Built a 30-person analytics team spanning 3 business units", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    const driftIssues = result.issues.filter(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssues).toHaveLength(0);
  });
});

// ── Fact Preservation Tests ─────────────────────────────────────

describe("Fact Preservation", () => {
  it("preserves numbers/metrics after corruption repair", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Influencedd $12M cost savings initiative across 3 business units", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    runVerbIntegrityGuard(resume, { detectOnly: false });

    const text = resume.experience[0].bullets[0].text;
    expect(text).toContain("$12M");
    expect(text).toContain("3 business units");
  });

  it("preserves tools/technologies after corruption repair", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Implementeded Snowflake and dbt migration for enterprise data lake", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    runVerbIntegrityGuard(resume, { detectOnly: false });

    const text = resume.experience[0].bullets[0].text;
    expect(text).toContain("Snowflake");
    expect(text).toContain("dbt");
    expect(text).toContain("enterprise data lake");
  });

  it("preserves numbers/tools after semantic drift repair", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Mentored revenue growth from $5M to $15M ARR using Salesforce CRM", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    runVerbIntegrityGuard(resume, { detectOnly: false });

    const text = resume.experience[0].bullets[0].text;
    expect(text).toContain("$5M");
    expect(text).toContain("$15M");
    expect(text).toContain("ARR");
    expect(text).toContain("Salesforce CRM");
  });

  it("preserves claim_ids and source_hash after repair", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Influencedd team to adopt dbt", source_hash: "orig-hash", evidence_quote: "test quote", claim_ids: ["cl-0-tool-1", "cl-0-metric-2"] },
      ],
    });

    runVerbIntegrityGuard(resume, { detectOnly: false });

    const bullet = resume.experience[0].bullets[0];
    expect(bullet.source_hash).toBe("orig-hash");
    expect(bullet.evidence_quote).toBe("test quote");
    expect(bullet.claim_ids).toEqual(["cl-0-tool-1", "cl-0-metric-2"]);
  });

  it("word count stays within tolerance after repair", () => {
    const originalText = "Mentored growth from $5M to $15M ARR through strategic partnerships";
    const originalWordCount = originalText.split(/\s+/).length;

    const resume = makeTestResume({
      bullets: [
        { text: originalText, source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    runVerbIntegrityGuard(resume, { detectOnly: false });

    const newText = resume.experience[0].bullets[0].text;
    const newWordCount = newText.split(/\s+/).length;
    // Word count should be the same (only verb changed)
    expect(newWordCount).toBe(originalWordCount);
  });
});

// ── Hype Verb Tests ─────────────────────────────────────────────

describe("Hype Verb Flagging", () => {
  it("flags 'catalyzed' as hype verb", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Catalyzed board decision to increase AI investment by 50%", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    const hypeIssue = result.issues.find(i => i.type === "HYPE_VERB");
    expect(hypeIssue).toBeDefined();
    expect(hypeIssue!.original).toBe("catalyzed");
    expect(hypeIssue!.auto_fixed).toBe(false); // Deferred to Stage 6
  });

  it("flags 'revolutionized' as hype verb", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Revolutionized data ingestion pipeline using Apache Spark", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    const hypeIssue = result.issues.find(i => i.type === "HYPE_VERB");
    expect(hypeIssue).toBeDefined();
    expect(hypeIssue!.original).toBe("revolutionized");
  });
});

// ── Category Inference Tests ────────────────────────────────────

describe("Category Inference", () => {
  it("infers growth_revenue from $XM and revenue cues", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Generated $15M in new revenue through data monetization", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);
    // No drift expected — "Generated" is valid for growth_revenue
    const driftIssues = result.issues.filter(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssues).toHaveLength(0);
  });

  it("infers platform_implementation from tech stack cues", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Deployed Snowflake data lake infrastructure across 3 regions", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);
    const driftIssues = result.issues.filter(i => i.type === "SEMANTIC_DRIFT");
    expect(driftIssues).toHaveLength(0);
  });
});

// ── Result Structure Tests ──────────────────────────────────────

describe("VerbGuardResult", () => {
  it("returns correct structure with no issues", () => {
    const resume = makeTestResume();
    const result = runVerbIntegrityGuard(resume);

    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("auto_fixed_count");
    expect(result).toHaveProperty("remaining_count");
    expect(result).toHaveProperty("needs_llm_repair");
    expect(result).toHaveProperty("duration_ms");
    expect(result.auto_fixed_count).toBe(0);
    expect(result.remaining_count).toBe(0);
    expect(result.needs_llm_repair).toBe(false);
  });

  it("sets needs_llm_repair when >2 unfixed issues", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Catalyzed enterprise-wide data platform transformation", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
        { text: "Revolutionized reporting cadence for executive stakeholders", source_hash: "h2", evidence_quote: "test", claim_ids: [] },
        { text: "Pioneered new ML pipeline deployment on Kubernetes", source_hash: "h3", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    // All three hype verbs are not auto-fixed (deferred to Stage 6)
    expect(result.remaining_count).toBeGreaterThanOrEqual(3);
    expect(result.needs_llm_repair).toBe(true);
  });

  it("handles mixed corruption and drift in same bullet", () => {
    const resume = makeTestResume({
      bullets: [
        { text: "Mentoredd $12M revenue growth from strategic partnerships", source_hash: "h1", evidence_quote: "test", claim_ids: [] },
      ],
    });

    const result = runVerbIntegrityGuard(resume);

    // Should have at least one corruption issue (Mentoredd)
    const corruptionIssues = result.issues.filter(i => i.type === "CORRUPTION");
    expect(corruptionIssues.length).toBeGreaterThan(0);
  });
});

// ── Exports Test ────────────────────────────────────────────────

describe("Module Exports", () => {
  it("exports CORRUPTION_PATTERNS with fix functions", () => {
    expect(CORRUPTION_PATTERNS).toBeInstanceOf(Array);
    expect(CORRUPTION_PATTERNS.length).toBeGreaterThan(0);
    for (const cp of CORRUPTION_PATTERNS) {
      expect(cp).toHaveProperty("name");
      expect(cp).toHaveProperty("pattern");
      expect(cp).toHaveProperty("fix");
      expect(typeof cp.fix).toBe("function");
    }
  });

  it("exports CATEGORY_VERB_MAP with all categories", () => {
    expect(Object.keys(CATEGORY_VERB_MAP)).toContain("growth_revenue");
    expect(Object.keys(CATEGORY_VERB_MAP)).toContain("build_scale_org");
    expect(Object.keys(CATEGORY_VERB_MAP)).toContain("platform_implementation");
    expect(Object.keys(CATEGORY_VERB_MAP)).toContain("governance_standardization");
    expect(Object.keys(CATEGORY_VERB_MAP)).toContain("reporting_okr");
  });

  it("exports MISFIT_VERBS with expected groups", () => {
    expect(Object.keys(MISFIT_VERBS)).toContain("mentor_coach");
    expect(Object.keys(MISFIT_VERBS)).toContain("organize_arrange");
    expect(Object.keys(MISFIT_VERBS)).toContain("elevate_uplift");
  });

  it("exports HYPE_VERB_LIST", () => {
    expect(HYPE_VERB_LIST).toContain("catalyzed");
    expect(HYPE_VERB_LIST).toContain("revolutionized");
    expect(HYPE_VERB_LIST).toContain("disrupted");
  });
});
