import { describe, it, expect } from "vitest";
import {
  checkSummaryMandateAnchoring,
  checkBulletImpact,
  checkAuthorityTone,
  checkCoverLetterPositioning,
  checkDifferentiation,
  runPositioningPass,
  CORPORATE_CLICHE_REPLACEMENTS,
  type PositioningInput,
} from "../src/resume-engine/positioning-pass";
import type { MandateProfile } from "../src/resume-engine/stage2-mandate-classifier/classifier";
import type { TailoredResume } from "../src/mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../src/mastra/tools/tailoredCoverLetterPrompt";

// ── Fixture Factories ──────────────────────────────────────────

function makeMandate(primary: string): MandateProfile {
  return {
    primary_mandate: primary,
    secondary_mandates: ["team_leadership_scale"],
    top_3_archetypes: [
      { id: primary, label: primary.replace(/_/g, " "), score: 4.5 },
      { id: "team_leadership_scale", label: "Team Leadership & Scale", score: 3.0 },
      { id: "executive_storytelling", label: "Executive Storytelling", score: 2.0 },
    ],
    seniority_level: "VP",
    calibrated_headline: "VP, Data & Analytics",
    tone_guidance: {
      seniority: "VP",
      summary_posture: "outcome-first",
      bullet_framing: "enterprise scale",
      competency_emphasis: "mandate-aligned",
      headline_tone: "authoritative",
    },
    gaps_vs_inventory: [],
    dimensions: [
      {
        id: primary,
        label: primary.replace(/_/g, " "),
        weight: 0.4,
        score_0_5: 4.5,
        signal_phrases: [],
        description: "Primary mandate",
      },
    ],
  };
}

function makeResume(overrides: Partial<TailoredResume> = {}): TailoredResume {
  return {
    target_company: "Acme Corp",
    target_role: "VP, Data Analytics",
    candidate_name: "Test Candidate",
    contact_info: "test@example.com | 555-1234",
    linkedin_url: "linkedin.com/in/test",
    executive_headline: "VP, Data & Analytics",
    professional_summary:
      "Enterprise governance architect who established compliance frameworks across 6 business units, reducing audit gaps 40% and standardizing data quality reporting for 200+ stakeholders.",
    core_competencies: [
      "Data Governance",
      "Compliance Frameworks",
      "Platform Architecture",
      "Team Leadership",
      "Analytics Strategy",
      "Reporting Infrastructure",
    ],
    experience: [
      {
        employer: "TechCorp",
        title: "VP, Data Analytics",
        start_date: "2020-01",
        end_date: "present",
        location: "New York, NY",
        scope_line: "25-person analytics org, $4M budget",
        bullets: [
          {
            text: "Architected enterprise governance framework across 6 BUs — reducing compliance gaps 40%",
            source_hash: "inv-0-0",
            evidence_quote: "Built governance framework across 6 business units, reducing compliance gaps by 40%",
            claim_ids: ["cl-0-metric-1"],
          },
          {
            text: "Established real-time reporting infrastructure serving 200+ stakeholders — driving $2.1M in cost savings",
            source_hash: "inv-0-1",
            evidence_quote: "Created real-time reporting serving 200+ stakeholders, saving $2.1M",
            claim_ids: ["cl-0-metric-2"],
          },
          {
            text: "Recruited and developed 15-person analytics team, promoting 4 to senior roles within 18 months",
            source_hash: "inv-0-2",
            evidence_quote: "Recruited 15-person analytics team, promoted 4 to senior roles",
            claim_ids: ["cl-0-scope-1"],
          },
          {
            text: "Standardized data quality protocols across cloud and on-prem environments",
            source_hash: "inv-0-3",
            evidence_quote: "Standardized data quality protocols",
            claim_ids: ["cl-0-tool-1"],
          },
        ],
      },
      {
        employer: "DataInc",
        title: "Senior Director, Analytics",
        start_date: "2017-01",
        end_date: "2019-12",
        location: "Chicago, IL",
        scope_line: "12-person team, $2M budget",
        bullets: [
          {
            text: "Migrated legacy BI platform to Snowflake — cutting query latency 60% and saving $800K annually",
            source_hash: "inv-1-0",
            evidence_quote: "Migrated BI to Snowflake, cut query latency 60%, saved $800K/yr",
            claim_ids: ["cl-1-metric-1"],
          },
          {
            text: "Delivered executive dashboard suite adopted by C-suite — generating $1.5M pipeline attribution",
            source_hash: "inv-1-1",
            evidence_quote: "Built dashboard suite for C-suite, $1.5M pipeline attribution",
            claim_ids: ["cl-1-metric-2"],
          },
          {
            text: "Implemented automated ETL pipeline processing 500M+ records daily",
            source_hash: "inv-1-2",
            evidence_quote: "Built ETL pipeline processing 500M+ records daily",
            claim_ids: ["cl-1-tool-1"],
          },
        ],
      },
      {
        employer: "StartupCo",
        title: "Director, Data",
        start_date: "2014-01",
        end_date: "2016-12",
        location: "San Francisco, CA",
        scope_line: "5-person team",
        bullets: [
          {
            text: "Built analytics function from scratch, growing from 2 to 8 team members in 18 months",
            source_hash: "inv-2-0",
            evidence_quote: "Built analytics function, grew team from 2 to 8",
            claim_ids: ["cl-2-scope-1"],
          },
          {
            text: "Deployed self-service BI platform — increasing stakeholder adoption 300%",
            source_hash: "inv-2-1",
            evidence_quote: "Deployed self-service BI, 300% adoption increase",
            claim_ids: ["cl-2-metric-1"],
          },
        ],
      },
    ],
    education: [{ institution: "MIT", degree: "MS Computer Science", year: "2013" }],
    certifications: [],
    skills: ["Python", "SQL", "Snowflake", "dbt", "Tableau"],
    gap_notes: [],
    ats_keywords_used: ["governance", "compliance", "Snowflake", "ETL"],
    evidence_pointers: [],
    ...overrides,
  } as any;
}

function makeCoverLetter(overrides: Partial<TailoredCoverLetter> = {}): TailoredCoverLetter {
  return {
    target_company: "Acme Corp",
    target_role: "VP, Data Analytics",
    salutation: "Dear Hiring Team,",
    opening_paragraph:
      "The VP, Data Analytics role at Acme Corp calls for enterprise-grade governance leadership. At TechCorp, I established compliance frameworks across 6 business units that eliminated 40% of audit gaps.",
    body_paragraphs: [
      "My governance-first approach produced measurable enterprise outcomes. At TechCorp, I built the reporting infrastructure that serves 200+ stakeholders while standardizing data quality across cloud and on-prem environments.",
      "At DataInc, I executed a full Snowflake migration that cut query latency 60% and saved $800K annually — demonstrating the platform modernization depth this role demands.",
    ],
    closing_paragraph:
      "I would welcome a conversation about how to apply this governance and platform architecture experience to Acme Corp's analytics transformation agenda.",
    sign_off: "Best regards,\nTest Candidate",
    value_claims: [
      {
        claim: "Established compliance frameworks across 6 BUs, reducing audit gaps 40%",
        source: "inv-0-0",
        confidence: 0.95,
      },
    ],
    evidence_pointers: [],
    ...overrides,
  } as any;
}

// ── 1. Summary Mandate Anchoring ───────────────────────────────

describe("Summary Mandate Anchoring", () => {
  it("should pass when first sentence matches governance mandate", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkSummaryMandateAnchoring(
      "Enterprise governance architect who established compliance frameworks across 6 business units.",
      mandate,
    );
    expect(result.anchored).toBe(true);
    expect(result.strategic_dimension_found).toBe(true);
    expect(result.generic_opener_detected).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it("should fail on generic opener pattern", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkSummaryMandateAnchoring(
      "Seasoned data analytics leader with 15 years of experience driving enterprise transformation.",
      mandate,
    );
    expect(result.generic_opener_detected).toBe(true);
    expect(result.anchored).toBe(false);
    expect(result.score).toBeLessThan(50);
    expect(result.issues.some(i => i.severity === "blocking")).toBe(true);
  });

  it("should flag revenue-first framing for non-revenue mandate", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkSummaryMandateAnchoring(
      "$50M revenue leader who drives financial outcomes through analytics.",
      mandate,
    );
    expect(result.issues.some(i => i.issue.includes("Mandate-mismatched opener"))).toBe(true);
  });

  it("should flag missing strategic dimension", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkSummaryMandateAnchoring(
      "Built 25-person team across three offices, driving organizational growth.",
      mandate,
    );
    expect(result.strategic_dimension_found).toBe(false);
    expect(result.issues.some(i => i.issue.includes("lacks strategic dimension"))).toBe(true);
  });

  it("should pass for revenue mandate with revenue framing", () => {
    const mandate = makeMandate("revenue_ops_forecasting");
    const result = checkSummaryMandateAnchoring(
      "Revenue operations leader who built forecasting models driving $12M pipeline growth across 3 markets.",
      mandate,
    );
    expect(result.anchored).toBe(true);
    expect(result.strategic_dimension_found).toBe(true);
  });

  it("should detect known-for opener", () => {
    const mandate = makeMandate("bi_platform_modernization");
    const result = checkSummaryMandateAnchoring(
      "Known for building modern analytics platforms and cloud migrations.",
      mandate,
    );
    expect(result.generic_opener_detected).toBe(true);
  });

  it("should accept platform mandate signals", () => {
    const mandate = makeMandate("bi_platform_modernization");
    const result = checkSummaryMandateAnchoring(
      "Platform architect who modernized enterprise data infrastructure across 3 cloud environments.",
      mandate,
    );
    expect(result.strategic_dimension_found).toBe(true);
    expect(result.anchored).toBe(true);
  });
});

// ── 2. Bullet Impact Strengthening ─────────────────────────────

describe("Bullet Impact Strengthening", () => {
  it("should pass when major roles have sufficient impact bullets", () => {
    const resume = makeResume();
    const result = checkBulletImpact(resume);
    expect(result.total_impact_bullets).toBeGreaterThanOrEqual(4);
    expect(result.roles_with_impact).toBeGreaterThanOrEqual(2);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("should flag major role with zero impact bullets", () => {
    const resume = makeResume();
    resume.experience[0].bullets = [
      {
        text: "Managed team of analysts across multiple departments",
        source_hash: "inv-0-0",
        evidence_quote: "Managed team of analysts",
        claim_ids: ["cl-0-scope-1"],
      },
      {
        text: "Oversaw daily operations and stakeholder communications",
        source_hash: "inv-0-1",
        evidence_quote: "Oversaw daily operations",
        claim_ids: ["cl-0-scope-2"],
      },
    ];
    const result = checkBulletImpact(resume);
    expect(result.roles_without_impact).toContain("TechCorp");
    expect(result.issues.some(i => i.severity === "blocking")).toBe(true);
  });

  it("should flag top-2 bullets lacking outcomes", () => {
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Managed enterprise governance processes across all business units";
    resume.experience[0].bullets[1].text = "Oversaw reporting infrastructure for stakeholder communications";
    const result = checkBulletImpact(resume);
    expect(result.issues.filter(i => i.issue.includes("Top-2 bullet lacks")).length).toBeGreaterThanOrEqual(2);
  });

  it("should detect roles without impact", () => {
    const resume = makeResume();
    resume.experience[2].bullets = [
      {
        text: "Supported analytics team across two departments",
        source_hash: "inv-2-0",
        evidence_quote: "Supported analytics team",
        claim_ids: ["cl-2-scope-1"],
      },
    ];
    const result = checkBulletImpact(resume);
    expect(result.roles_without_impact).toContain("StartupCo");
  });
});

// ── 3. Authority Without Hype ──────────────────────────────────

describe("Authority Without Hype", () => {
  it("should auto-replace corporate clichés", () => {
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Leveraged data governance frameworks to drive actionable insights across 6 BUs";
    const result = checkAuthorityTone(resume);
    expect(result.clichés_replaced).toBeGreaterThanOrEqual(2);
    expect(resume.experience[0].bullets[0].text).not.toContain("Leveraged");
    expect(resume.experience[0].bullets[0].text).not.toContain("actionable insights");
    expect(result.issues.some(i => i.auto_fixed)).toBe(true);
  });

  it("should flag safe managerial phrasing", () => {
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Managed a team of 15 to deliver quarterly reports";
    resume.experience[0].bullets[1].text = "Responsible for managing all reporting infrastructure";
    const result = checkAuthorityTone(resume);
    expect(result.safe_managerial_flags).toBeGreaterThanOrEqual(2);
    expect(result.issues.some(i => i.issue.includes("Safe managerial"))).toBe(true);
  });

  it("should flag hedge phrases", () => {
    const resume = makeResume();
    resume.professional_summary = "I believe that data governance is key. Helped to implement frameworks.";
    const result = checkAuthorityTone(resume);
    expect(result.hedge_phrases_found).toBeGreaterThanOrEqual(1);
  });

  it("should not flag clean executive language", () => {
    const resume = makeResume(); // default resume has clean language
    const result = checkAuthorityTone(resume);
    expect(result.safe_managerial_flags).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it("should replace leveraged with applied", () => {
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Leveraged Snowflake to modernize reporting";
    checkAuthorityTone(resume);
    expect(resume.experience[0].bullets[0].text).toContain("Applied");
  });

  it("should have replacement for every defined corporate cliché", () => {
    for (const cliché of CORPORATE_CLICHE_REPLACEMENTS) {
      expect(cliché.replacement).toBeDefined();
      expect(cliché.replacement.length).toBeGreaterThan(0);
      expect(cliché.label).toBeDefined();
    }
  });
});

// ── 4. Cover Letter QA ─────────────────────────────────────────

describe("Cover Letter Positioning", () => {
  it("should pass well-structured cover letter", () => {
    const mandate = makeMandate("governance_standardization");
    const cl = makeCoverLetter();
    const result = checkCoverLetterPositioning(cl, mandate);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.issues.filter(i => i.severity === "blocking").length).toBe(0);
  });

  it("should flag generic opener", () => {
    const mandate = makeMandate("governance_standardization");
    const cl = makeCoverLetter({
      opening_paragraph: "I am writing to apply for the VP, Data Analytics position at Acme Corp.",
    });
    const result = checkCoverLetterPositioning(cl, mandate);
    expect(result.issues.some(i => i.issue.includes("Generic opener"))).toBe(true);
    expect(result.issues.some(i => i.severity === "blocking")).toBe(true);
  });

  it("should flag supplicant closing", () => {
    const mandate = makeMandate("governance_standardization");
    const cl = makeCoverLetter({
      closing_paragraph: "Thank you for considering my application. I hope to hear from you soon.",
    });
    const result = checkCoverLetterPositioning(cl, mandate);
    expect(result.issues.some(i => i.issue.includes("Supplicant language"))).toBe(true);
  });

  it("should flag missing value claims", () => {
    const mandate = makeMandate("governance_standardization");
    const cl = makeCoverLetter({ value_claims: [] });
    const result = checkCoverLetterPositioning(cl, mandate);
    expect(result.issues.some(i => i.issue.includes("No value claims"))).toBe(true);
    expect(result.issues.some(i => i.severity === "blocking")).toBe(true);
  });

  it("should flag missing mandate signal in opening", () => {
    const mandate = makeMandate("governance_standardization");
    const cl = makeCoverLetter({
      opening_paragraph: "My career has been defined by building high-performing analytics teams across enterprise organizations.",
    });
    const result = checkCoverLetterPositioning(cl, mandate);
    expect(result.issues.some(i => i.issue.includes("lacks mandate signal"))).toBe(true);
  });

  it("should return score 0 for undefined cover letter", () => {
    const mandate = makeMandate("governance_standardization");
    const result = checkCoverLetterPositioning(undefined, mandate);
    expect(result.score).toBe(0);
    expect(result.issues.length).toBe(0);
  });
});

// ── 5. Differentiation Maintenance ─────────────────────────────

describe("Differentiation Maintenance", () => {
  it("should pass with no prior resumes", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const result = checkDifferentiation(resume, mandate);
    expect(result.worst_summary_overlap).toBe(0);
    expect(result.force_rewrite).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("should flag high summary overlap", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    // Use almost-identical summary as prior
    const priorSummaries = [resume.professional_summary];
    const result = checkDifferentiation(resume, mandate, priorSummaries);
    expect(result.worst_summary_overlap).toBeGreaterThan(35);
    expect(result.force_rewrite).toBe(true);
    expect(result.issues.some(i => i.severity === "blocking")).toBe(true);
  });

  it("should flag high competency overlap", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");
    const priorComps = [["Data Governance", "Compliance Frameworks", "Platform Architecture", "Team Leadership"]];
    const result = checkDifferentiation(resume, mandate, undefined, priorComps);
    expect(result.worst_competency_overlap).toBeGreaterThan(50);
    expect(result.issues.some(i => i.issue.includes("Competency overlap"))).toBe(true);
  });

  it("should reorder competencies by mandate alignment", () => {
    const mandate = makeMandate("bi_platform_modernization");
    const resume = makeResume({
      core_competencies: [
        "Team Leadership",
        "Data Governance",
        "Platform Architecture",
        "Cloud Migration",
        "ETL Design",
      ],
    } as any);
    const result = checkDifferentiation(resume, mandate);
    // After reorder, platform/cloud/architecture should be near the top
    const comps = (resume as any).core_competencies;
    expect(result.actions_taken.some(a => a.includes("Reordered"))).toBe(true);
    // The top competency should now be platform-related
    const topComp = comps[0].toLowerCase();
    expect(
      topComp.includes("platform") || topComp.includes("cloud") || topComp.includes("migration"),
    ).toBe(true);
  });

  it("should not reorder if already mandate-sorted", () => {
    const mandate = makeMandate("governance_standardization");
    const resume = makeResume({
      core_competencies: [
        "Data Governance",
        "Compliance Frameworks",
        "Audit Controls",
        "Team Leadership",
      ],
    } as any);
    const result = checkDifferentiation(resume, mandate);
    // Already sorted — no reordering action
    expect(result.competencies_mandate_sorted).toBe(true);
    expect(result.actions_taken.length).toBe(0);
  });
});

// ── 6. Composite Positioning Pass ──────────────────────────────

describe("runPositioningPass", () => {
  it("should return composite score across all 5 dimensions", () => {
    const resume = makeResume();
    const cl = makeCoverLetter();
    const mandate = makeMandate("governance_standardization");

    const result = runPositioningPass({
      resume,
      coverLetter: cl,
      mandate,
    });

    expect(result.scores).toHaveProperty("summary_anchoring");
    expect(result.scores).toHaveProperty("bullet_impact");
    expect(result.scores).toHaveProperty("authority_tone");
    expect(result.scores).toHaveProperty("cover_letter");
    expect(result.scores).toHaveProperty("differentiation");
    expect(result.scores).toHaveProperty("composite");
    expect(result.scores).toHaveProperty("grade");
    expect(result.scores.composite).toBeGreaterThanOrEqual(0);
    expect(result.scores.composite).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(result.scores.grade);
    expect(typeof result.passed).toBe("boolean");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("should pass a well-constructed resume+CL", () => {
    const resume = makeResume();
    const cl = makeCoverLetter();
    const mandate = makeMandate("governance_standardization");

    const result = runPositioningPass({
      resume,
      coverLetter: cl,
      mandate,
    });

    expect(result.passed).toBe(true);
    expect(result.blocking_issues.length).toBe(0);
    expect(result.scores.composite).toBeGreaterThanOrEqual(60);
  });

  it("should fail on generic summary + supplicant CL", () => {
    const resume = makeResume({
      professional_summary: "Seasoned analytics executive with 15 years of experience driving organizational transformation.",
    });
    const cl = makeCoverLetter({
      opening_paragraph: "I am excited to apply for this role.",
      closing_paragraph: "Thank you for considering my application.",
      value_claims: [],
    });
    const mandate = makeMandate("governance_standardization");

    const result = runPositioningPass({
      resume,
      coverLetter: cl,
      mandate,
    });

    expect(result.passed).toBe(false);
    expect(result.blocking_issues.length).toBeGreaterThan(0);
    expect(result.scores.composite).toBeLessThan(70);
  });

  it("should report actions taken for auto-fixes", () => {
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Leveraged governance frameworks to drive actionable insights across 6 BUs — reducing gaps 40%";
    const mandate = makeMandate("governance_standardization");

    const result = runPositioningPass({
      resume,
      mandate,
    });

    expect(result.actions_taken.length).toBeGreaterThan(0);
    expect(result.actions_taken.some(a => a.includes("Replaced"))).toBe(true);
  });

  it("should grade correctly: A for 90+, B for 80+, etc.", () => {
    const resume = makeResume();
    const cl = makeCoverLetter();
    const mandate = makeMandate("governance_standardization");

    const result = runPositioningPass({ resume, coverLetter: cl, mandate });

    const grade = result.scores.grade;
    const composite = result.scores.composite;
    if (composite >= 90) expect(grade).toBe("A");
    else if (composite >= 80) expect(grade).toBe("B");
    else if (composite >= 70) expect(grade).toBe("C");
    else if (composite >= 60) expect(grade).toBe("D");
    else expect(grade).toBe("F");
  });

  it("should handle resume without cover letter gracefully", () => {
    const resume = makeResume();
    const mandate = makeMandate("governance_standardization");

    const result = runPositioningPass({
      resume,
      mandate,
    });

    expect(result.scores.cover_letter).toBe(0);
    // Should still complete and score other dimensions
    expect(result.scores.summary_anchoring).toBeGreaterThan(0);
    expect(result.scores.bullet_impact).toBeGreaterThan(0);
    expect(result.scores.authority_tone).toBeGreaterThan(0);
  });
});

// ── Outcome Integrity (Governor) ───────────────────────────────

describe("Outcome Integrity Verification", () => {
  it("should export verifyOutcomeIntegrity", async () => {
    const { verifyOutcomeIntegrity } = await import(
      "../src/resume-engine/stage6-layout-governor/governor"
    );
    expect(typeof verifyOutcomeIntegrity).toBe("function");
  });

  it("should clean trailing truncation artifacts", async () => {
    const { verifyOutcomeIntegrity } = await import(
      "../src/resume-engine/stage6-layout-governor/governor"
    );
    const resume = makeResume();
    resume.experience[0].bullets[0].text = "Architected governance framework across 6 BUs resulting in";
    const result = verifyOutcomeIntegrity(resume);
    expect(result.cleanups_applied).toBeGreaterThanOrEqual(1);
    // The trailing "resulting in" should be cleaned
    expect(resume.experience[0].bullets[0].text).not.toMatch(/resulting in$/);
  });

  it("should detect outcome losses when evidence has metrics but bullet does not", async () => {
    const { verifyOutcomeIntegrity } = await import(
      "../src/resume-engine/stage6-layout-governor/governor"
    );
    const resume = makeResume();
    // Bullet stripped of its metric, but evidence has one
    resume.experience[0].bullets[0].text = "Architected enterprise governance framework across all business units";
    resume.experience[0].bullets[0].evidence_quote = "Built governance framework, reducing compliance gaps by 40%";
    const result = verifyOutcomeIntegrity(resume);
    expect(result.outcome_losses_detected).toBeGreaterThanOrEqual(1);
  });

  it("should not flag bullets that retain their outcomes", async () => {
    const { verifyOutcomeIntegrity } = await import(
      "../src/resume-engine/stage6-layout-governor/governor"
    );
    const resume = makeResume(); // default has clean bullets with outcomes
    const result = verifyOutcomeIntegrity(resume);
    expect(result.outcome_losses_detected).toBe(0);
  });
});
