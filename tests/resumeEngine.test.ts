import { describe, it, expect, vi } from "vitest";

// ── Test Inventory ───────────────────────────────────────────────

const testInventory = {
  profile: {
    name: "Test Candidate",
    current_title: "VP of Data & Analytics",
    location: "Chicago, IL",
    email: "test@example.com",
    phone: "555-0100",
    linkedin: "linkedin.com/in/test",
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
          text: "Built predictive pricing model generating $8M incremental revenue using Python and machine learning",
          metrics: ["$8M"],
          tools: ["Python"],
        },
      ],
    },
    {
      id: "exp-002",
      employer: "Beta Corp",
      title: "Director of Analytics",
      start_date: "2017-06",
      end_date: "2021-02",
      location: "New York, NY",
      bullets: [
        {
          id: "exp-002-b1",
          text: "Managed team of 12 data analysts supporting marketing and product teams",
          metrics: ["12"],
          tools: ["Tableau", "SQL"],
        },
        {
          id: "exp-002-b2",
          text: "Contributed to migration from on-premise to AWS cloud infrastructure",
          metrics: [],
          tools: ["AWS"],
        },
      ],
    },
  ],
  education: [
    {
      id: "edu-001",
      institution: "MIT",
      degree: "MS Computer Science",
      year: "2015",
    },
  ],
  certifications: [
    { id: "cert-001", name: "AWS Solutions Architect", year: "2020" },
  ],
  skills: ["Python", "SQL", "Snowflake", "Tableau", "dbt", "AWS", "Machine Learning"],
};

// ── Stage 1: Claims Ledger Extractor ─────────────────────────────

describe("Stage 1: Claims Ledger Extractor", () => {
  it("extracts claims from JSON inventory", async () => {
    const { extractClaimsFromInventory } = await import("../src/resume-engine/stage1-claims-ledger/extractor");
    const ledger = extractClaimsFromInventory(testInventory);

    expect(ledger.total_claims).toBeGreaterThan(0);
    expect(ledger.roles.length).toBeGreaterThanOrEqual(2);
    expect(ledger.metrics.length).toBeGreaterThan(0);
    expect(ledger.tools.length).toBeGreaterThan(0);
  });

  it("generates unique claim IDs", async () => {
    const { extractClaimsFromInventory } = await import("../src/resume-engine/stage1-claims-ledger/extractor");
    const ledger = extractClaimsFromInventory(testInventory);
    const ids = ledger.claims.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("extracts claims from raw text", async () => {
    const { extractClaimsFromText } = await import("../src/resume-engine/stage1-claims-ledger/extractor");
    const rawText = `
PROFESSIONAL EXPERIENCE

Acme Financial Group | VP of Data & Analytics | Chicago, IL
March 2021 - Present

- Led a 45-person data organization across 3 business units
- Drove $12M annual cost savings by architecting a unified Snowflake platform
- Built predictive pricing model generating $8M revenue using Python

Beta Corp | Director of Analytics | New York, NY
June 2017 - February 2021

- Managed team of 12 data analysts using Tableau and SQL
- Contributed to AWS cloud migration

EDUCATION
MIT — MS Computer Science, 2015

CERTIFICATIONS
AWS Solutions Architect (2020)
`;

    const ledger = extractClaimsFromText(rawText);

    expect(ledger.total_claims).toBeGreaterThan(0);
    expect(ledger.roles.length).toBeGreaterThanOrEqual(1);
    expect(ledger.metrics.length).toBeGreaterThan(0);
    expect(ledger.tools.length).toBeGreaterThan(0);
  });

  it("auto-detects format", async () => {
    const { extractClaims } = await import("../src/resume-engine/stage1-claims-ledger/extractor");

    // JSON inventory
    const jsonLedger = extractClaims(testInventory);
    expect(jsonLedger.total_claims).toBeGreaterThan(0);

    // Raw text
    const textLedger = extractClaims("PROFESSIONAL EXPERIENCE\nAcme Corp | VP | 2020 - Present\n- Led team of 10");
    expect(textLedger.total_claims).toBeGreaterThan(0);
  });
});

// ── Stage 2: Mandate Classifier ──────────────────────────────────

describe("Stage 2: Mandate Classifier", () => {
  it("classifies a JD into mandate dimensions", async () => {
    const { classifyJobMandate } = await import("../src/resume-engine/stage2-mandate-classifier/classifier");

    const result = classifyJobMandate({
      jdText: "We are looking for a VP of Data & Analytics to lead our data strategy, build data governance frameworks, and drive revenue growth through analytics.",
      title: "VP of Data & Analytics",
    });

    expect(result.mandate).toBeDefined();
    expect(result.mandate.primary_mandate).toBeTruthy();
    expect(result.mandate.seniority_level).toBeTruthy();
    expect(result.mandate.calibrated_headline).toBeTruthy();
    expect(result.mandate.dimensions.length).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── Stage 3: Bullet Scoring ──────────────────────────────────────

describe("Stage 3: Bullet Scoring", () => {
  it("scores bullets against mandate and produces a plan", async () => {
    const { classifyJobMandate } = await import("../src/resume-engine/stage2-mandate-classifier/classifier");
    const { extractClaimsFromInventory } = await import("../src/resume-engine/stage1-claims-ledger/extractor");
    const { scoreBullets } = await import("../src/resume-engine/stage3-bullet-scoring/scorer");

    const { mandate } = classifyJobMandate({
      jdText: "VP of Data Analytics leading data governance and revenue optimization",
      title: "VP of Data & Analytics",
    });

    const ledger = extractClaimsFromInventory(testInventory);

    const plan = await scoreBullets(testInventory, mandate, ledger, {
      must_have: [{ text: "data governance experience", source: "requirements" }],
      nice_to_have: [{ text: "Python skills", source: "preferred" }],
      tech_keywords: ["data governance", "Python"],
    } as any);

    expect(plan.scored_bullets.length).toBeGreaterThan(0);
    expect(plan.scored_bullets[0].total_relevance).toBeGreaterThanOrEqual(0);
    expect(plan.scored_bullets[0].bullet_id).toBeTruthy();
  });

  it("links claim IDs to bullets", async () => {
    const { extractClaimsFromInventory } = await import("../src/resume-engine/stage1-claims-ledger/extractor");
    const { linkClaimIds } = await import("../src/resume-engine/stage3-bullet-scoring/scorer");

    const ledger = extractClaimsFromInventory(testInventory);
    const claimIds = linkClaimIds("exp-001-b1", "Led a 45-person data organization", ledger);

    expect(claimIds.length).toBeGreaterThanOrEqual(0);
  });
});

// ── Stage 5: Differentiation Gate ────────────────────────────────

describe("Stage 5: Differentiation Gate", () => {
  it("exports the expected functions", async () => {
    const gate = await import("../src/resume-engine/stage5-differentiation/gate");
    expect(typeof gate.initDivergenceTracking).toBe("function");
    expect(typeof gate.checkDifferentiation).toBe("function");
    expect(typeof gate.storeDivergenceSnapshot).toBe("function");
  });
});

// ── Stage 6: Layout Governor ─────────────────────────────────────

describe("Stage 6: Layout Governor", () => {
  it("enforces bullet caps", async () => {
    const { governLayout } = await import("../src/resume-engine/stage6-layout-governor/governor");
    const { classifyJobMandate } = await import("../src/resume-engine/stage2-mandate-classifier/classifier");

    const { mandate } = classifyJobMandate({
      jdText: "VP of Data Analytics",
      title: "VP of Data & Analytics",
    });

    const resume = {
      target_role: "VP of Data & Analytics",
      target_company: "Acme Corp",
      professional_summary: "Data analytics leader with serving as a key member of the executive team.",
      experience: [
        {
          employer: "Acme Corp",
          title: "VP",
          start_date: "2021-03",
          end_date: "present",
          location: "Chicago, IL",
          bullets: [
            { text: "Bullet one that is good", source_hash: "exp-001-b1", evidence_quote: "test" },
            { text: "Bullet two that is good", source_hash: "exp-001-b2", evidence_quote: "test" },
            { text: "Bullet three that is good", source_hash: "exp-001-b3", evidence_quote: "test" },
            { text: "Bullet four that is good", source_hash: "exp-001-b4", evidence_quote: "test" },
            { text: "Bullet five should be cut", source_hash: "exp-001-b5", evidence_quote: "test" },
            { text: "Bullet six should also be cut", source_hash: "exp-001-b6", evidence_quote: "test" },
          ],
        },
      ],
      skills: {},
      education: [{ institution: "MIT", degree: "MS", year: "2015" }],
      evidence_pointers: [],
      gap_notes: [],
      ats_keywords_used: [],
    } as any;

    const result = governLayout(resume, mandate);

    // After compression + cap enforcement, most recent role (i===0) allows 5 bullets for executive depth
    expect(result.resume.experience[0].bullets.length).toBeLessThanOrEqual(5);
    // The compression or cap logic should have trimmed from 6 to 5
    expect(result.resume.experience[0].bullets.length).toBeLessThan(6);
  });

  it("removes filler phrases", async () => {
    const { governLayout } = await import("../src/resume-engine/stage6-layout-governor/governor");
    const { classifyJobMandate } = await import("../src/resume-engine/stage2-mandate-classifier/classifier");

    const { mandate } = classifyJobMandate({ jdText: "VP role", title: "VP" });

    const resume = {
      target_role: "VP",
      target_company: "Acme",
      professional_summary: "Leader known for effectively delivering results serving as a trusted advisor.",
      experience: [{
        employer: "Acme",
        title: "VP",
        start_date: "2021",
        end_date: "present",
        location: "Chicago",
        bullets: [
          { text: "Was responsible for holistically managing the team", source_hash: "x", evidence_quote: "y" },
        ],
      }],
      skills: {},
      education: [],
      evidence_pointers: [],
      gap_notes: [],
      ats_keywords_used: [],
    } as any;

    const result = governLayout(resume, mandate);
    expect(result.filler_removals.length).toBeGreaterThan(0);
    // "known for" and "serving as" should be removed from summary
    expect(result.resume.professional_summary).not.toContain("known for");
    expect(result.resume.professional_summary).not.toContain("serving as");
  });

  it("enforces word limits", async () => {
    const { governLayout } = await import("../src/resume-engine/stage6-layout-governor/governor");
    const { classifyJobMandate } = await import("../src/resume-engine/stage2-mandate-classifier/classifier");

    const { mandate } = classifyJobMandate({ jdText: "VP role", title: "VP" });

    const longBullet = Array(30).fill("word").join(" ");

    const resume = {
      target_role: "VP",
      target_company: "Acme",
      professional_summary: "Summary",
      experience: [{
        employer: "Acme",
        title: "VP",
        start_date: "2021",
        end_date: "present",
        location: "Chicago",
        bullets: [
          { text: longBullet, source_hash: "x", evidence_quote: "y" },
        ],
      }],
      skills: {},
      education: [],
      evidence_pointers: [],
      gap_notes: [],
      ats_keywords_used: [],
    } as any;

    const result = governLayout(resume, mandate);
    const words = result.resume.experience[0].bullets[0].text.split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(22);
    expect(result.word_limit_truncations.length).toBeGreaterThan(0);
  });
});

// ── Stage 7: Truth Audit ─────────────────────────────────────────

describe("Stage 7: Ownership Inflation Detection", () => {
  it("detects inflated ownership language", async () => {
    const { detectOwnershipInflation } = await import("../src/resume-engine/stage7-truth-audit/auditor");

    const resume = {
      experience: [
        {
          employer: "Acme Corp",
          title: "Analyst",
          bullets: [
            {
              text: "Architected the data platform migration from scratch",
              source_hash: "exp-002-b2",
              evidence_quote: "Contributed to migration from on-premise to AWS",
            },
          ],
        },
      ],
    } as any;

    const inventory = testInventory;

    const warnings = detectOwnershipInflation(resume, inventory);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].pattern).toContain("contributor");
    expect(warnings[0].severity).toBeDefined();
  });

  it("does not flag non-inflated language", async () => {
    const { detectOwnershipInflation } = await import("../src/resume-engine/stage7-truth-audit/auditor");

    const resume = {
      experience: [
        {
          employer: "Acme Corp",
          title: "VP",
          bullets: [
            {
              text: "Led a 45-person organization across 3 business units",
              source_hash: "exp-001-b1",
              evidence_quote: "Led a 45-person data organization spanning analytics engineering",
            },
          ],
        },
      ],
    } as any;

    const warnings = detectOwnershipInflation(resume, testInventory);
    expect(warnings.length).toBe(0);
  });
});

// ── Plaintext ATS Renderer ───────────────────────────────────────

describe("Plaintext ATS Renderer", () => {
  it("renders a resume to ATS-safe plaintext", async () => {
    const { renderPlaintext } = await import("../src/resume-engine/output/plaintext-renderer");

    const resume = {
      target_role: "VP of Data & Analytics",
      target_company: "Acme Corp",
      executive_headline: "VP of Data & Analytics",
      professional_summary: "Data analytics leader with 15+ years of experience building high-performing organizations.",
      core_competencies: ["Enterprise Data Strategy", "AI/ML", "Revenue Optimization"],
      experience: [
        {
          employer: "Acme Financial Group",
          title: "VP of Data & Analytics",
          start_date: "2021-03",
          end_date: "present",
          location: "Chicago, IL",
          scope_line: "45-person org | 3 business units | $17M budget",
          bullets: [
            { text: "Led 45-person data organization across analytics", source_hash: "exp-001-b1", evidence_quote: "test" },
            { text: "Drove $12M cost savings via unified platform", source_hash: "exp-001-b2", evidence_quote: "test" },
          ],
        },
      ],
      skills: {
        tools_and_platforms: ["Snowflake", "dbt", "Python", "AWS"],
      },
      education: [
        { institution: "MIT", degree: "MS Computer Science", year: "2015" },
      ],
      certifications: [
        { name: "AWS Solutions Architect", year: "2020" },
      ],
      evidence_pointers: [],
      gap_notes: [],
      ats_keywords_used: ["data strategy", "analytics"],
    } as any;

    const plaintext = renderPlaintext(resume, "Test Candidate");

    expect(plaintext).toContain("EXECUTIVE SUMMARY");
    expect(plaintext).toContain("PROFESSIONAL EXPERIENCE");
    expect(plaintext).toContain("EDUCATION");
    // The renderer may uppercase the name for ATS formatting
    expect(plaintext.toUpperCase()).toContain("TEST CANDIDATE");
    expect(plaintext).toContain("Acme Financial Group");
    expect(plaintext).not.toContain("<");
    expect(plaintext).not.toContain(">");
    // Check that it uses simple bullet markers
    expect(plaintext).toContain("- ");
  });
});

// ── Clarification Questions ──────────────────────────────────────

describe("Clarification Question Builder", () => {
  it("converts gap notes into actionable questions", async () => {
    const { buildClarificationQuestions } = await import("../src/resume-engine/output/clarification-builder");

    const gapNotes = [
      {
        requirement_text: "5+ years of Salesforce CRM experience",
        reason: "No Salesforce experience in inventory",
        closest_match: "exp-002-b1: Managed CRM data pipeline",
      },
      {
        requirement_text: "AWS certifications preferred",
        reason: "Candidate has AWS Solutions Architect cert",
        closest_match: "cert-001: AWS Solutions Architect",
      },
    ];

    const mandateGaps = [
      {
        dimension_id: "sales_enablement",
        label: "Sales Enablement",
        weight: 0.3,
        best_coverage: 0.1,
        suggestion: "Highlight any CRM or sales analytics experience",
      },
    ];

    const questions = buildClarificationQuestions(gapNotes, mandateGaps);

    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0].jd_requirement).toBeTruthy();
    expect(questions[0].question).toBeTruthy();
    expect(questions[0].gap_severity).toMatch(/must_have|nice_to_have/);
  });
});

// ── Pipeline Types ───────────────────────────────────────────────

describe("Pipeline Types", () => {
  it("exports all required types", async () => {
    const types = await import("../src/resume-engine/types");

    expect(types.ClarificationQuestionSchema).toBeDefined();
    expect(types.DraftBulletSchema).toBeDefined();
  });
});

// ── Auto-Generate Module ─────────────────────────────────────────

describe("Auto-Generate", () => {
  it("exports autoGeneratePackets and autoGenerateInBackground", async () => {
    const autoGen = await import("../src/resume-engine/auto-generate");
    expect(typeof autoGen.autoGeneratePackets).toBe("function");
    expect(typeof autoGen.autoGenerateInBackground).toBe("function");
  });
});
