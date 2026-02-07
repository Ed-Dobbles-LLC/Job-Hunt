import { describe, it, expect } from "vitest";
import {
  ViolationSchema,
  LineItemFixSchema,
  VerifierReportSchema,
  verifyNewEntities,
  verifyMetrics,
  verifyPlaceholders,
  verifyDates,
  verifyStyleRules,
  verifyATSRisks,
  runTruthfulnessVerification,
} from "../src/mastra/tools/truthfulnessVerifier";
import type { TailoredResume } from "../src/mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../src/mastra/tools/tailoredCoverLetterPrompt";
import type { EntityAllowlist } from "../src/mastra/tools/entityAllowlist";

const MOCK_ALLOWLIST: EntityAllowlist = {
  companies: [
    { value: "Acme Financial Group", normalized: "acme financial group", sourceId: "exp-001", sourcePath: "experience[0].employer" },
    { value: "University of Chicago", normalized: "university of chicago", sourceId: "edu-001", sourcePath: "education[0].institution" },
  ],
  titles: [
    { value: "VP of Data & Analytics", normalized: "vp of data & analytics", sourceId: "exp-001", sourcePath: "experience[0].title" },
    { value: "Director of Analytics", normalized: "director of analytics", sourceId: "exp-002", sourcePath: "experience[1].title" },
  ],
  dates: [
    { value: "2021-03", normalized: "2021-03", sourceId: "exp-001", sourcePath: "experience[0].start_date" },
    { value: "present", normalized: "present", sourceId: "exp-001", sourcePath: "experience[0].end_date" },
    { value: "2017-06", normalized: "2017-06", sourceId: "exp-002", sourcePath: "experience[1].start_date" },
    { value: "2021-02", normalized: "2021-02", sourceId: "exp-002", sourcePath: "experience[1].end_date" },
    { value: "2010", normalized: "2010", sourceId: "edu-001", sourcePath: "education[0].year" },
    { value: "2020", normalized: "2020", sourceId: "cert-001", sourcePath: "certifications[0].year" },
  ],
  locations: [
    { value: "Chicago, IL (Hybrid)", normalized: "chicago, il (hybrid)", sourceId: "exp-001", sourcePath: "experience[0].location" },
    { value: "Chicago, IL", normalized: "chicago, il", sourceId: "exp-002", sourcePath: "experience[1].location" },
  ],
  degrees: [
    { value: "MBA", normalized: "mba", sourceId: "edu-001", sourcePath: "education[0].degree" },
  ],
  certifications: [
    { value: "AWS Certified Solutions Architect", normalized: "aws certified solutions architect", sourceId: "cert-001", sourcePath: "certifications[0]" },
  ],
  tools: [
    { value: "Python", normalized: "python", sourceId: "exp-001-b2", sourcePath: "experience[0].bullets[1].tools" },
    { value: "Snowflake", normalized: "snowflake", sourceId: "exp-001-b2", sourcePath: "experience[0].bullets[1].tools" },
    { value: "dbt", normalized: "dbt", sourceId: "exp-001-b2", sourcePath: "experience[0].bullets[1].tools" },
    { value: "SQL", normalized: "sql", sourceId: "skill-technical", sourcePath: "skills.technical" },
  ],
  metrics: [
    { value: "$12M annual cost savings", normalized: "$12m annual cost savings", sourceId: "exp-001-b2", sourcePath: "experience[0].bullets[1].metrics", number: "12", unit: "$M", raw: "$12M annual cost savings" },
    { value: "45-person team", normalized: "45-person team", sourceId: "exp-001-b1", sourcePath: "experience[0].bullets[0].metrics", number: "45", unit: "person team", raw: "45-person team" },
    { value: "3 business units", normalized: "3 business units", sourceId: "exp-001-b1", sourcePath: "experience[0].bullets[0].metrics", number: "3", unit: "business units", raw: "3 business units" },
  ],
  skills: [
    { value: "Python", normalized: "python", sourceId: "skill-technical", sourcePath: "skills.technical" },
    { value: "SQL", normalized: "sql", sourceId: "skill-technical", sourcePath: "skills.technical" },
    { value: "Machine Learning", normalized: "machine learning", sourceId: "skill-data_science", sourcePath: "skills.data_science" },
    { value: "Executive stakeholder management", normalized: "executive stakeholder management", sourceId: "skill-leadership", sourcePath: "skills.leadership" },
  ],
};

const MOCK_INVENTORY = {
  profile: {
    name: "Ed Martinez",
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
      location: "Chicago, IL (Hybrid)",
      bullets: [
        {
          id: "exp-001-b1",
          text: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
          metrics: ["45-person team", "3 business units"],
        },
        {
          id: "exp-001-b2",
          text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
          metrics: ["$12M annual cost savings"],
          tools: ["Snowflake", "dbt", "Airflow"],
        },
      ],
    },
    {
      id: "exp-002",
      employer: "Acme Financial Group",
      title: "Director of Analytics",
      start_date: "2017-06",
      end_date: "2021-02",
      location: "Chicago, IL",
      bullets: [
        {
          id: "exp-002-b1",
          text: "Built analytics team from 5 to 20 engineers",
          metrics: ["5 to 20 engineers"],
        },
      ],
    },
  ],
  education: [
    { id: "edu-001", institution: "University of Chicago", degree: "MBA", year: "2010" },
  ],
  certifications: [{ id: "cert-001", name: "AWS Certified Solutions Architect", year: "2020" }],
  skills: {
    technical: ["Python", "SQL", "Snowflake"],
    leadership: ["Executive stakeholder management"],
    data_science: ["Machine Learning"],
  },
};

function makeValidResume(): TailoredResume {
  return {
    target_role: "VP of Data",
    target_company: "TechCorp",
    professional_summary: "Data executive with 15+ years of experience leading enterprise data transformations.",
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
            evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
          },
          {
            text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
            source_hash: "exp-001-b2",
            evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
          },
        ],
      },
    ],
    skills: {
      technical: ["Python", "SQL", "Snowflake"],
      leadership: ["Executive stakeholder management"],
    },
    education: [{ institution: "University of Chicago", degree: "MBA", year: "2010" }],
    certifications: [{ name: "AWS Certified Solutions Architect", year: "2020" }],
    evidence_pointers: [
      {
        claim_text: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
        source_hash: "exp-001-b1",
        evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
        confidence: 0.95,
      },
      {
        claim_text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        source_hash: "exp-001-b2",
        evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        confidence: 0.95,
      },
    ],
    gap_notes: [],
    ats_keywords_used: ["data governance", "machine learning"],
  };
}

function makeValidCoverLetter(): TailoredCoverLetter {
  return {
    target_role: "VP of Data",
    target_company: "TechCorp",
    salutation: "Dear Hiring Manager,",
    opening_paragraph: "I am writing to express my interest in the VP of Data position at TechCorp.",
    body_paragraphs: [
      "At Acme Financial Group, I drove $12M in annual cost savings by architecting a unified data platform on Snowflake.",
    ],
    closing_paragraph: "I welcome the opportunity to discuss how my experience can contribute to TechCorp.",
    sign_off: "Sincerely,\nEd Martinez",
    value_claims: [
      {
        claim_sentence: "I drove $12M in annual cost savings by architecting a unified data platform on Snowflake.",
        source_hash: "exp-001-b2",
        evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        metric_used: "$12M",
      },
    ],
    evidence_pointers: [
      {
        claim_text: "I drove $12M in annual cost savings",
        source_hash: "exp-001-b2",
        evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        confidence: 0.95,
      },
    ],
    gap_notes: [],
    company_research_todo: ["Research TechCorp data infrastructure"],
    word_count: 280,
  };
}

describe("Violation Schema", () => {
  it("validates a valid violation", () => {
    const v = {
      type: "NEW_ENTITY",
      severity: "critical",
      location: "resume.experience[0].employer",
      found_value: "FakeCompany Inc.",
      explanation: "Employer not in allowlist",
    };
    expect(ViolationSchema.safeParse(v).success).toBe(true);
  });

  it("rejects unknown violation type", () => {
    const v = {
      type: "UNKNOWN_TYPE",
      severity: "critical",
      location: "x",
      found_value: "y",
      explanation: "z",
    };
    expect(ViolationSchema.safeParse(v).success).toBe(false);
  });

  it("rejects unknown severity", () => {
    const v = {
      type: "NEW_ENTITY",
      severity: "low",
      location: "x",
      found_value: "y",
      explanation: "z",
    };
    expect(ViolationSchema.safeParse(v).success).toBe(false);
  });
});

describe("LineItemFix Schema", () => {
  it("validates a valid fix", () => {
    const fix = {
      location: "resume.experience[0].bullets[1]",
      current_text: "$50M savings",
      suggested_text: "Remove or use $12M from inventory",
      reason: "Metric not in inventory",
      violation_type: "UNSUPPORTED_METRIC",
    };
    expect(LineItemFixSchema.safeParse(fix).success).toBe(true);
  });
});

describe("verifyNewEntities", () => {
  it("passes when all entities are in allowlist", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    const result = verifyNewEntities(resume, coverLetter, MOCK_ALLOWLIST);
    const criticals = result.violations.filter((v) => v.severity === "critical");
    expect(criticals.length).toBe(0);
  });

  it("detects hallucinated employer", () => {
    const resume = makeValidResume();
    resume.experience[0].employer = "FakeCompany Inc.";
    const coverLetter = makeValidCoverLetter();
    const result = verifyNewEntities(resume, coverLetter, MOCK_ALLOWLIST);
    const entityViolations = result.violations.filter((v) => v.type === "NEW_ENTITY" && v.found_value === "FakeCompany Inc.");
    expect(entityViolations.length).toBe(1);
    expect(entityViolations[0].severity).toBe("critical");
  });

  it("detects hallucinated job title", () => {
    const resume = makeValidResume();
    resume.experience[0].title = "Chief Data Officer";
    const coverLetter = makeValidCoverLetter();
    const result = verifyNewEntities(resume, coverLetter, MOCK_ALLOWLIST);
    const titleV = result.violations.filter((v) => v.found_value === "Chief Data Officer");
    expect(titleV.length).toBe(1);
    expect(titleV[0].type).toBe("NEW_ENTITY");
  });

  it("detects hallucinated certification", () => {
    const resume = makeValidResume();
    resume.certifications = [{ name: "Google Cloud Professional Data Engineer", year: "2023" }];
    const coverLetter = makeValidCoverLetter();
    const result = verifyNewEntities(resume, coverLetter, MOCK_ALLOWLIST);
    const certV = result.violations.filter((v) => v.found_value === "Google Cloud Professional Data Engineer");
    expect(certV.length).toBe(1);
    expect(certV[0].severity).toBe("critical");
  });

  it("detects hallucinated degree", () => {
    const resume = makeValidResume();
    resume.education = [{ institution: "University of Chicago", degree: "PhD in Computer Science", year: "2010" }];
    const coverLetter = makeValidCoverLetter();
    const result = verifyNewEntities(resume, coverLetter, MOCK_ALLOWLIST);
    const degV = result.violations.filter((v) => v.found_value === "PhD in Computer Science");
    expect(degV.length).toBe(1);
  });

  it("flags unknown skills as warnings", () => {
    const resume = makeValidResume();
    resume.skills.technical.push("Kubernetes");
    const coverLetter = makeValidCoverLetter();
    const result = verifyNewEntities(resume, coverLetter, MOCK_ALLOWLIST);
    const skillV = result.violations.filter((v) => v.found_value === "Kubernetes");
    expect(skillV.length).toBe(1);
    expect(skillV[0].severity).toBe("warning");
  });
});

describe("verifyMetrics", () => {
  it("passes when all metrics are in allowlist", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    const result = verifyMetrics(resume, coverLetter, MOCK_ALLOWLIST);
    const criticals = result.violations.filter((v) => v.severity === "critical");
    expect(criticals.length).toBe(0);
  });

  it("detects fabricated dollar amount in resume bullet", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[1].text = "Drove $50M annual cost savings by architecting a unified data platform on Snowflake";
    const coverLetter = makeValidCoverLetter();
    const result = verifyMetrics(resume, coverLetter, MOCK_ALLOWLIST);
    const metricV = result.violations.filter((v) => v.type === "UNSUPPORTED_METRIC");
    expect(metricV.length).toBeGreaterThan(0);
    expect(metricV[0].severity).toBe("critical");
  });

  it("detects fabricated percentage in cover letter body", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    coverLetter.body_paragraphs[0] = "I improved data quality by 95% at Acme Financial Group.";
    const result = verifyMetrics(resume, coverLetter, MOCK_ALLOWLIST);
    const metricV = result.violations.filter((v) => v.type === "UNSUPPORTED_METRIC");
    expect(metricV.length).toBeGreaterThan(0);
  });

  it("produces line_item_fixes for fabricated metrics", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[1].text = "Drove $50M annual cost savings";
    const coverLetter = makeValidCoverLetter();
    const result = verifyMetrics(resume, coverLetter, MOCK_ALLOWLIST);
    expect(result.fixes.length).toBeGreaterThan(0);
    expect(result.fixes[0].violation_type).toBe("UNSUPPORTED_METRIC");
  });
});

describe("verifyPlaceholders", () => {
  it("passes on clean content with allowlist", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    const result = verifyPlaceholders(resume, coverLetter, MOCK_ALLOWLIST);
    expect(result.violations.length).toBe(0);
  });

  it("detects template variables", () => {
    const resume = makeValidResume();
    resume.professional_summary = "I am a {{role}} at {{company}}";
    const coverLetter = makeValidCoverLetter();
    const result = verifyPlaceholders(resume, coverLetter, MOCK_ALLOWLIST);
    const templateV = result.violations.filter((v) => v.type === "PLACEHOLDER");
    expect(templateV.length).toBeGreaterThan(0);
  });

  it("detects [object Object]", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    coverLetter.body_paragraphs[0] = "I worked at [object Object] company";
    const result = verifyPlaceholders(resume, coverLetter, MOCK_ALLOWLIST);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("detects placeholder names", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    coverLetter.sign_off = "Sincerely,\nJohn Doe";
    const result = verifyPlaceholders(resume, coverLetter, MOCK_ALLOWLIST);
    const nameV = result.violations.filter((v) => v.found_value.includes("John Doe"));
    expect(nameV.length).toBe(1);
  });

  it("detects lorem ipsum", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[0].text = "Lorem ipsum dolor sit amet";
    const coverLetter = makeValidCoverLetter();
    const result = verifyPlaceholders(resume, coverLetter, MOCK_ALLOWLIST);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("produces fixes for placeholder content", () => {
    const resume = makeValidResume();
    resume.professional_summary = "I have TBD years of experience";
    const coverLetter = makeValidCoverLetter();
    const result = verifyPlaceholders(resume, coverLetter, MOCK_ALLOWLIST);
    expect(result.fixes.length).toBeGreaterThan(0);
    expect(result.fixes[0].violation_type).toBe("PLACEHOLDER");
  });
});

describe("verifyDates", () => {
  it("passes when all dates are in allowlist", () => {
    const resume = makeValidResume();
    const result = verifyDates(resume, MOCK_ALLOWLIST);
    const criticals = result.violations.filter((v) => v.severity === "critical");
    expect(criticals.length).toBe(0);
  });

  it("detects fabricated start date", () => {
    const resume = makeValidResume();
    resume.experience[0].start_date = "2019-01";
    const result = verifyDates(resume, MOCK_ALLOWLIST);
    const dateV = result.violations.filter((v) => v.type === "INCONSISTENT_DATE" && v.found_value === "2019-01");
    expect(dateV.length).toBe(1);
    expect(dateV[0].severity).toBe("critical");
  });

  it("detects start date after end date", () => {
    const resume = makeValidResume();
    resume.experience.push({
      employer: "Acme Financial Group",
      title: "Director of Analytics",
      start_date: "2022-01",
      end_date: "2021-02",
      location: "Chicago, IL",
      bullets: [{ text: "Built team", source_hash: "exp-002-b1", evidence_quote: "Built analytics team" }],
    });
    const result = verifyDates(resume, MOCK_ALLOWLIST);
    const chronoV = result.violations.filter((v) =>
      v.explanation.includes("Start date is after end date"),
    );
    expect(chronoV.length).toBe(1);
  });

  it("allows 'present' as end date without checking allowlist", () => {
    const resume = makeValidResume();
    const result = verifyDates(resume, MOCK_ALLOWLIST);
    const presentV = result.violations.filter((v) => v.found_value === "present");
    expect(presentV.length).toBe(0);
  });
});

describe("verifyStyleRules", () => {
  it("passes on valid resume with complete evidence", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const criticals = result.violations.filter((v) => v.severity === "critical");
    expect(criticals.length).toBe(0);
  });

  it("detects missing source_hash on bullet", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[0].source_hash = "";
    const coverLetter = makeValidCoverLetter();
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const hashV = result.violations.filter((v) =>
      v.explanation.includes("missing source_hash"),
    );
    expect(hashV.length).toBe(1);
  });

  it("detects hallucinated source_hash", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[0].source_hash = "exp-999-b1";
    const coverLetter = makeValidCoverLetter();
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const hashV = result.violations.filter((v) =>
      v.explanation.includes("does not exist in the experience inventory"),
    );
    expect(hashV.length).toBe(1);
  });

  it("detects insufficient evidence pointer count", () => {
    const resume = makeValidResume();
    resume.evidence_pointers = [resume.evidence_pointers[0]];
    const coverLetter = makeValidCoverLetter();
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const countV = result.violations.filter((v) =>
      v.explanation.includes("Evidence pointer count"),
    );
    expect(countV.length).toBe(1);
  });

  it("detects low confidence evidence pointers", () => {
    const resume = makeValidResume();
    resume.evidence_pointers[0].confidence = 0.5;
    const coverLetter = makeValidCoverLetter();
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const confV = result.violations.filter((v) =>
      v.explanation.includes("below the 0.7 minimum"),
    );
    expect(confV.length).toBe(1);
    expect(confV[0].severity).toBe("warning");
  });

  it("detects clichés in cover letter", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    coverLetter.body_paragraphs[0] = "I am passionate about data and synergy in business operations.";
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const clicheV = result.violations.filter((v) =>
      v.explanation.includes("Cliché"),
    );
    expect(clicheV.length).toBeGreaterThanOrEqual(2);
  });

  it("detects word count outside range", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    coverLetter.word_count = 500;
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const wcV = result.violations.filter((v) =>
      v.explanation.includes("word count"),
    );
    expect(wcV.length).toBe(1);
  });

  it("detects missing evidence_quote on value claim", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    coverLetter.value_claims[0].evidence_quote = "";
    const result = verifyStyleRules(resume, coverLetter, MOCK_INVENTORY);
    const eqV = result.violations.filter((v) =>
      v.explanation.includes("missing evidence_quote"),
    );
    expect(eqV.length).toBe(1);
  });
});

describe("verifyATSRisks", () => {
  it("passes on clean resume", () => {
    const resume = makeValidResume();
    const result = verifyATSRisks(resume);
    const criticals = result.violations.filter((v) => v.severity === "critical");
    expect(criticals.length).toBe(0);
  });

  it("warns when no ATS keywords tracked", () => {
    const resume = makeValidResume();
    resume.ats_keywords_used = [];
    const result = verifyATSRisks(resume);
    const kw = result.violations.filter((v) =>
      v.explanation.includes("No ATS keywords"),
    );
    expect(kw.length).toBe(1);
  });

  it("detects table characters", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[0].text = "Led team │ across units ├ business";
    const result = verifyATSRisks(resume);
    const tableV = result.violations.filter((v) =>
      v.explanation.includes("tables"),
    );
    expect(tableV.length).toBe(1);
    expect(tableV[0].severity).toBe("critical");
  });

  it("warns on low bullet count per role", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets = [resume.experience[0].bullets[0]];
    resume.evidence_pointers = [resume.evidence_pointers[0]];
    const result = verifyATSRisks(resume);
    const bulletV = result.violations.filter((v) =>
      v.explanation.includes("bullet"),
    );
    expect(bulletV.length).toBeGreaterThan(0);
  });
});

describe("runTruthfulnessVerification (full pipeline)", () => {
  it("returns PASS for valid inputs", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    expect(report.pass).toBe(true);
    expect(report.stats.critical_violations).toBe(0);
    expect(report.stats.total_checks).toBeGreaterThan(0);
  });

  it("returns FAIL for hallucinated employer", () => {
    const resume = makeValidResume();
    resume.experience[0].employer = "Google";
    const coverLetter = makeValidCoverLetter();
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    expect(report.pass).toBe(false);
    expect(report.stats.critical_violations).toBeGreaterThan(0);
    const entityV = report.violations.filter((v) => v.type === "NEW_ENTITY" && v.found_value === "Google");
    expect(entityV.length).toBe(1);
  });

  it("returns FAIL for fabricated metric", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[1].text = "Drove $100M in savings";
    const coverLetter = makeValidCoverLetter();
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    expect(report.pass).toBe(false);
    const metricV = report.violations.filter((v) => v.type === "UNSUPPORTED_METRIC");
    expect(metricV.length).toBeGreaterThan(0);
  });

  it("returns FAIL for placeholder content", () => {
    const resume = makeValidResume();
    resume.professional_summary = "I am a {{role}} with undefined experience at ACME Corp";
    const coverLetter = makeValidCoverLetter();
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    expect(report.pass).toBe(false);
    const placeholderV = report.violations.filter((v) => v.type === "PLACEHOLDER");
    expect(placeholderV.length).toBeGreaterThan(0);
  });

  it("returns FAIL for hallucinated source_hash", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[0].source_hash = "exp-999-b99";
    const coverLetter = makeValidCoverLetter();
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    expect(report.pass).toBe(false);
    const styleV = report.violations.filter(
      (v) => v.type === "STYLE_RULE_BROKEN" && v.explanation.includes("does not exist"),
    );
    expect(styleV.length).toBe(1);
  });

  it("validates VerifierReportSchema on output", () => {
    const resume = makeValidResume();
    const coverLetter = makeValidCoverLetter();
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    const result = VerifierReportSchema.safeParse(report);
    expect(result.success).toBe(true);
  });

  it("multiple violation types accumulate correctly", () => {
    const resume = makeValidResume();
    resume.experience[0].employer = "FakeCompany";
    resume.experience[0].start_date = "2019-01";
    resume.experience[0].bullets[1].text = "Drove $50M annual cost savings";
    resume.professional_summary = "I have TBD experience at {{company}}";
    const coverLetter = makeValidCoverLetter();
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    expect(report.pass).toBe(false);
    const types = new Set(report.violations.map((v) => v.type));
    expect(types.has("NEW_ENTITY")).toBe(true);
    expect(types.has("UNSUPPORTED_METRIC")).toBe(true);
    expect(types.has("PLACEHOLDER")).toBe(true);
    expect(types.has("INCONSISTENT_DATE")).toBe(true);
  });

  it("includes line_item_fixes for fixable violations", () => {
    const resume = makeValidResume();
    resume.experience[0].bullets[1].text = "Drove $50M annual cost savings";
    const coverLetter = makeValidCoverLetter();
    coverLetter.body_paragraphs[0] = "I am passionate about data synergy.";
    const report = runTruthfulnessVerification(resume, coverLetter, MOCK_ALLOWLIST, MOCK_INVENTORY);
    expect(report.line_item_fixes.length).toBeGreaterThan(0);
  });
});
