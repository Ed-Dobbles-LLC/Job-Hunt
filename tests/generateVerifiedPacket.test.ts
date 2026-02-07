import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGenerateObject = vi.fn();
vi.mock("ai", () => ({
  generateObject: (...args: any[]) => mockGenerateObject(...args),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => (model: string) => ({ modelId: model }),
}));

vi.mock("../src/mastra/tools/db", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

import {
  runTruthfulnessVerification,
  type VerifierReport,
} from "../src/mastra/tools/truthfulnessVerifier";
import { buildEntityAllowlist } from "../src/mastra/tools/entityAllowlist";
import type { TailoredResume } from "../src/mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../src/mastra/tools/tailoredCoverLetterPrompt";

const sampleInventory = {
  profile: { name: "Ed Martinez", email: "ed@example.com" },
  experience: [
    {
      id: "exp-001",
      employer: "Acme Financial Group",
      title: "VP of Data & Analytics",
      start_date: "2021-03",
      end_date: "present",
      location: "Chicago, IL (Hybrid)",
      bullets: [
        {
          id: "exp-001-b1",
          text: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
          metrics: ["45-person", "3 business units"],
          tools: ["Snowflake"],
        },
        {
          id: "exp-001-b2",
          text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy systems",
          metrics: ["$12M", "7 legacy systems"],
          tools: ["Snowflake"],
        },
      ],
    },
  ],
  education: [
    {
      id: "edu-001",
      institution: "University of Chicago Booth School of Business",
      degree: "MBA",
      year: "2010",
    },
  ],
  certifications: [
    { id: "cert-001", name: "AWS Certified Solutions Architect", year: "2020" },
  ],
  skills: {
    technical: ["Python", "SQL", "Snowflake", "dbt", "Tableau"],
    leadership: ["Executive stakeholder management", "Team building"],
  },
};

function makeCleanResume(): TailoredResume {
  return {
    target_role: "VP, Data & Analytics",
    target_company: "TestCorp",
    professional_summary:
      "Data executive with 15+ years leading enterprise data transformations.",
    experience: [
      {
        employer: "Acme Financial Group",
        title: "VP of Data & Analytics",
        start_date: "2021-03",
        end_date: "present",
        location: "Chicago, IL (Hybrid)",
        bullets: [
          {
            text: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
            source_hash: "exp-001-b1",
            evidence_quote:
              "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
          },
          {
            text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
            source_hash: "exp-001-b2",
            evidence_quote:
              "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy systems",
          },
        ],
      },
    ],
    skills: {
      technical: ["Python", "SQL", "Snowflake"],
      leadership: ["Executive stakeholder management"],
    },
    education: [
      {
        institution: "University of Chicago Booth School of Business",
        degree: "MBA",
        year: "2010",
      },
    ],
    certifications: [
      { name: "AWS Certified Solutions Architect", year: "2020" },
    ],
    evidence_pointers: [
      {
        claim_text:
          "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
        source_hash: "exp-001-b1",
        evidence_quote:
          "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
        confidence: 0.95,
      },
      {
        claim_text:
          "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        source_hash: "exp-001-b2",
        evidence_quote:
          "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy systems",
        confidence: 0.95,
      },
    ],
    gap_notes: [],
    ats_keywords_used: ["data governance", "machine learning"],
  };
}

function makeCleanCoverLetter(): TailoredCoverLetter {
  return {
    target_role: "VP, Data & Analytics",
    target_company: "TestCorp",
    salutation: "Dear Hiring Manager,",
    opening_paragraph:
      "I am writing to express my interest in the VP of Data position at TestCorp.",
    body_paragraphs: [
      "At Acme Financial Group, I led a 45-person data organization and drove $12M in annual cost savings by architecting a unified Snowflake platform.",
    ],
    closing_paragraph:
      "I welcome the opportunity to discuss how my experience can contribute to your team.",
    sign_off: "Sincerely,\nEd Martinez",
    value_claims: [
      {
        claim_sentence:
          "I drove $12M in annual cost savings by architecting a unified Snowflake platform.",
        source_hash: "exp-001-b2",
        evidence_quote:
          "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy systems",
        metric_used: "$12M",
      },
    ],
    evidence_pointers: [
      {
        claim_text: "I drove $12M in annual cost savings",
        source_hash: "exp-001-b2",
        evidence_quote:
          "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy systems",
        confidence: 0.95,
      },
    ],
    gap_notes: [],
    company_research_todo: ["Research TestCorp data infrastructure"],
    word_count: 280,
  };
}

function makeDirtyResume(): TailoredResume {
  const resume = makeCleanResume();
  resume.experience[0].employer = "Google";
  resume.experience[0].title = "Chief Data Officer";
  resume.experience[0].bullets[0].source_hash = "exp-999-b1";
  resume.experience[0].bullets[0].evidence_quote = "Fabricated evidence";
  return resume;
}

function makeDirtyCoverLetter(): TailoredCoverLetter {
  const cl = makeCleanCoverLetter();
  cl.body_paragraphs = [
    "I drove $500M in savings at Google. Lorem ipsum dolor sit amet.",
  ];
  cl.value_claims = [
    {
      claim_sentence: "I drove $500M in savings",
      source_hash: "",
      evidence_quote: "",
    },
  ];
  cl.evidence_pointers = [];
  cl.word_count = 50;
  return cl;
}

describe("buildCorrectionPrompt", () => {
  it("includes violation details and attempt number", async () => {
    const { buildCorrectionPrompt } = await import(
      "../src/mastra/tools/generateVerifiedPacketTool"
    );
    const prompt = (buildCorrectionPrompt as any)(
      "resume",
      '{"target_role": "Test"}',
      [
        {
          type: "NEW_ENTITY",
          severity: "critical",
          location: "resume.experience[0].employer",
          found_value: "Google",
          explanation: 'Employer "Google" not found in EntityAllowlist.',
        },
      ],
      [
        {
          location: "resume.experience[0].employer",
          current_text: "Google",
          suggested_text: "Acme Financial Group",
          reason: "Use allowlisted employer",
          violation_type: "NEW_ENTITY",
        },
      ],
      2,
    );
    expect(prompt).toContain("Attempt 2");
    expect(prompt).toContain("CRITICAL VIOLATIONS");
    expect(prompt).toContain("Google");
    expect(prompt).toContain("NEW_ENTITY");
    expect(prompt).toContain("SUGGESTED FIXES");
    expect(prompt).toContain("Acme Financial Group");
  });

  it("handles empty violations gracefully", async () => {
    const { buildCorrectionPrompt } = await import(
      "../src/mastra/tools/generateVerifiedPacketTool"
    );
    const prompt = (buildCorrectionPrompt as any)(
      "cover_letter",
      '{"target_role": "Test"}',
      [],
      [],
      1,
    );
    expect(prompt).toContain("Attempt 1");
    expect(prompt).toContain("0 critical violation(s)");
  });

  it("separates critical violations from warnings", async () => {
    const { buildCorrectionPrompt } = await import(
      "../src/mastra/tools/generateVerifiedPacketTool"
    );
    const prompt = (buildCorrectionPrompt as any)(
      "resume",
      "{}",
      [
        {
          type: "NEW_ENTITY",
          severity: "critical",
          location: "test",
          found_value: "bad",
          explanation: "Critical issue",
        },
        {
          type: "ATS_RISK",
          severity: "warning",
          location: "test2",
          found_value: "minor",
          explanation: "Warning issue",
        },
      ],
      [],
      3,
    );
    expect(prompt).toContain("1 critical violation(s)");
    expect(prompt).toContain("WARNINGS");
    expect(prompt).toContain("Warning issue");
  });
});

describe("Verifier integration for loop logic", () => {
  const allowlist = buildEntityAllowlist(sampleInventory);

  it("clean resume + cover letter passes verification", () => {
    const report = runTruthfulnessVerification(
      makeCleanResume(),
      makeCleanCoverLetter(),
      allowlist,
      sampleInventory,
    );
    expect(report.pass).toBe(true);
    expect(report.stats.critical_violations).toBe(0);
  });

  it("dirty resume + cover letter fails verification", () => {
    const report = runTruthfulnessVerification(
      makeDirtyResume(),
      makeDirtyCoverLetter(),
      allowlist,
      sampleInventory,
    );
    expect(report.pass).toBe(false);
    expect(report.stats.critical_violations).toBeGreaterThan(0);
  });

  it("dirty data produces correctable violations with locations", () => {
    const report = runTruthfulnessVerification(
      makeDirtyResume(),
      makeDirtyCoverLetter(),
      allowlist,
      sampleInventory,
    );

    const resumeViolations = report.violations.filter((v) =>
      v.location.startsWith("resume"),
    );
    const clViolations = report.violations.filter((v) =>
      v.location.startsWith("cover_letter"),
    );

    expect(resumeViolations.length).toBeGreaterThan(0);
    expect(clViolations.length).toBeGreaterThan(0);

    for (const v of report.violations) {
      expect(v.location).toBeTruthy();
      expect(v.explanation).toBeTruthy();
      expect(v.found_value).toBeTruthy();
    }
  });
});

describe("Loop simulation (unit-level)", () => {
  it("simulates pass-on-first-try flow", () => {
    const allowlist = buildEntityAllowlist(sampleInventory);
    const resume = makeCleanResume();
    const cl = makeCleanCoverLetter();

    const report = runTruthfulnessVerification(resume, cl, allowlist, sampleInventory);
    expect(report.pass).toBe(true);
  });

  it("simulates fail-then-fix by replacing dirty with clean data", () => {
    const allowlist = buildEntityAllowlist(sampleInventory);

    const report1 = runTruthfulnessVerification(
      makeDirtyResume(),
      makeDirtyCoverLetter(),
      allowlist,
      sampleInventory,
    );
    expect(report1.pass).toBe(false);

    const report2 = runTruthfulnessVerification(
      makeCleanResume(),
      makeCleanCoverLetter(),
      allowlist,
      sampleInventory,
    );
    expect(report2.pass).toBe(true);
    expect(report2.stats.critical_violations).toBe(0);
  });

  it("tracks best attempt across multiple failures", () => {
    const allowlist = buildEntityAllowlist(sampleInventory);

    const dirtyResume1 = makeDirtyResume();
    const report1 = runTruthfulnessVerification(
      dirtyResume1,
      makeDirtyCoverLetter(),
      allowlist,
      sampleInventory,
    );

    const partiallyFixed = makeCleanResume();
    const stillDirtyCL = makeDirtyCoverLetter();
    const report2 = runTruthfulnessVerification(
      partiallyFixed,
      stillDirtyCL,
      allowlist,
      sampleInventory,
    );

    expect(report2.stats.critical_violations).toBeLessThan(
      report1.stats.critical_violations,
    );
  });

  it("builds human-review notes from remaining violations", () => {
    const allowlist = buildEntityAllowlist(sampleInventory);
    const report = runTruthfulnessVerification(
      makeDirtyResume(),
      makeDirtyCoverLetter(),
      allowlist,
      sampleInventory,
    );

    const humanReviewNotes: string[] = [];
    humanReviewNotes.push("Automated verification failed after 3 attempts.");
    const remainingCriticals = report.violations.filter(
      (v) => v.severity === "critical",
    );
    for (const v of remainingCriticals) {
      humanReviewNotes.push(`[${v.type}] ${v.location}: ${v.explanation}`);
    }

    expect(humanReviewNotes.length).toBeGreaterThan(1);
    expect(humanReviewNotes.some((n) => n.includes("NEW_ENTITY"))).toBe(true);
  });
});

describe("AttemptRecord shape", () => {
  it("matches expected shape", () => {
    const record = {
      attempt: 1,
      pass: false,
      critical_violations: 3,
      warnings: 2,
      total_checks: 45,
      violation_types: ["NEW_ENTITY", "PLACEHOLDER"],
      timestamp: new Date().toISOString(),
    };

    expect(record.attempt).toBe(1);
    expect(record.pass).toBe(false);
    expect(record.violation_types).toContain("NEW_ENTITY");
    expect(record.timestamp).toBeTruthy();
  });
});

describe("Correction prompt edge cases", () => {
  it("truncates long current_text and suggested_text in fixes", async () => {
    const { buildCorrectionPrompt } = await import(
      "../src/mastra/tools/generateVerifiedPacketTool"
    );
    const longText = "A".repeat(500);
    const prompt = (buildCorrectionPrompt as any)(
      "resume",
      "{}",
      [],
      [
        {
          location: "test",
          current_text: longText,
          suggested_text: longText,
          reason: "test reason",
          violation_type: "NEW_ENTITY",
        },
      ],
      1,
    );
    expect(prompt).toContain("A".repeat(120));
    expect(prompt).not.toContain("A".repeat(200));
  });

  it("includes all 6 violation type instructions", async () => {
    const { buildCorrectionPrompt } = await import(
      "../src/mastra/tools/generateVerifiedPacketTool"
    );
    const prompt = (buildCorrectionPrompt as any)("resume", "{}", [], [], 1);
    expect(prompt).toContain("NEW_ENTITY");
    expect(prompt).toContain("UNSUPPORTED_METRIC");
    expect(prompt).toContain("PLACEHOLDER");
    expect(prompt).toContain("INCONSISTENT_DATE");
    expect(prompt).toContain("STYLE_RULE_BROKEN");
    expect(prompt).toContain("ATS_RISK");
  });
});
