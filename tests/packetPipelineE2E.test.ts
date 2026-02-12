/**
 * End-to-end test for the resume/cover letter generation pipeline.
 *
 * Tests the full flow:
 *   Inventory → EntityAllowlist → Prompts → (mock) LLM → Verification → DOCX Render
 *
 * Uses deterministic mock LLM output so the test is reproducible without an API key.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ─── Mock LLM (no API calls) ─────────────────────────────────────────
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

// ─── Imports (after mocks) ───────────────────────────────────────────
import { buildEntityAllowlist } from "../src/mastra/tools/entityAllowlist";
import {
  buildResumeSystemPrompt,
  buildResumeUserPrompt,
  TailoredResumeSchema,
  type TailoredResume,
} from "../src/mastra/tools/tailoredResumePrompt";
import {
  buildCoverLetterSystemPrompt,
  buildCoverLetterUserPrompt,
  TailoredCoverLetterSchema,
  type TailoredCoverLetter,
} from "../src/mastra/tools/tailoredCoverLetterPrompt";
import {
  runTruthfulnessVerification,
  type VerifierReport,
} from "../src/mastra/tools/truthfulnessVerifier";
import { renderResumeDocx, renderCoverLetterDocx, checkPagination } from "../src/mastra/tools/docxRenderer";
import { buildCorrectionPrompt } from "../src/mastra/tools/generateVerifiedPacketTool";

// ─── Fixtures ────────────────────────────────────────────────────────

const INVENTORY_PATH = path.resolve(__dirname, "../experience_inventory.json");
let inventory: any;
let allowlist: any;

beforeAll(() => {
  inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
  allowlist = buildEntityAllowlist(inventory);
});

/** A compliant TailoredResume built entirely from real inventory data */
function buildCompliantResume(): TailoredResume {
  return {
    target_role: "VP of Data & Analytics",
    target_company: "Ignite Corp",
    professional_summary:
      "Data & Analytics executive with 15+ years of experience leading enterprise-scale data transformations across financial services, healthcare, and technology sectors. Proven track record building high-performing teams and driving measurable business impact through advanced analytics and AI/ML.",
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
            text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses",
            source_hash: "exp-001-b2",
            evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses",
          },
          {
            text: "Launched enterprise ML ops pipeline processing 2B+ daily events for real-time fraud detection, reducing false positive rate by 38%",
            source_hash: "exp-001-b3",
            evidence_quote: "Launched enterprise ML ops pipeline processing 2B+ daily events for real-time fraud detection, reducing false positive rate by 38%",
          },
        ],
      },
      {
        employer: "HealthTech Solutions Inc.",
        title: "Senior Director, Data Science & Analytics",
        start_date: "2018-06",
        end_date: "2021-02",
        location: "Chicago, IL",
        bullets: [
          {
            text: "Managed a team of 28 data scientists, analysts, and engineers delivering predictive analytics for population health management",
            source_hash: "exp-002-b1",
            evidence_quote: "Managed a team of 28 data scientists, analysts, and engineers delivering predictive analytics for population health management",
          },
          {
            text: "Developed patient readmission prediction model achieving 0.89 AUC, preventing an estimated 4,200 unnecessary readmissions annually saving $31M",
            source_hash: "exp-002-b2",
            evidence_quote: "Developed patient readmission prediction model achieving 0.89 AUC, preventing an estimated 4,200 unnecessary readmissions annually saving $31M",
          },
        ],
      },
    ],
    skills: {
      technical: ["Python", "SQL", "Snowflake", "dbt", "Airflow", "Tableau"],
      leadership: ["Executive stakeholder management", "Team building & mentorship", "Strategic planning"],
      data_science: ["Machine Learning", "Deep Learning", "A/B Testing"],
    },
    education: [
      { institution: "University of Chicago", degree: "MBA, Concentrations in Econometrics & Statistics and Strategic Management", year: "2010" },
      { institution: "University of Illinois at Urbana-Champaign", degree: "BS in Computer Science, Minor in Mathematics", year: "2006" },
    ],
    certifications: [
      { name: "AWS Certified Solutions Architect", year: "2020" },
      { name: "Google Cloud Professional Data Engineer", year: "2021" },
    ],
    evidence_pointers: [
      { claim_text: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units", source_hash: "exp-001-b1", evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units", confidence: 0.95 },
      { claim_text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses", source_hash: "exp-001-b2", evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses", confidence: 0.95 },
      { claim_text: "Launched enterprise ML ops pipeline processing 2B+ daily events for real-time fraud detection, reducing false positive rate by 38%", source_hash: "exp-001-b3", evidence_quote: "Launched enterprise ML ops pipeline processing 2B+ daily events for real-time fraud detection, reducing false positive rate by 38%", confidence: 0.95 },
      { claim_text: "Managed a team of 28 data scientists, analysts, and engineers delivering predictive analytics for population health management", source_hash: "exp-002-b1", evidence_quote: "Managed a team of 28 data scientists, analysts, and engineers delivering predictive analytics for population health management", confidence: 0.90 },
      { claim_text: "Developed patient readmission prediction model achieving 0.89 AUC, preventing an estimated 4,200 unnecessary readmissions annually saving $31M", source_hash: "exp-002-b2", evidence_quote: "Developed patient readmission prediction model achieving 0.89 AUC, preventing an estimated 4,200 unnecessary readmissions annually saving $31M", confidence: 0.90 },
    ],
    gap_notes: [
      { requirement_text: "5+ years of Kubernetes orchestration", reason: "No Kubernetes-specific leadership experience in inventory; Kubernetes listed as a tool in exp-001-b3 context only.", closest_match: "exp-001-b3" },
    ],
    ats_keywords_used: ["data governance", "machine learning", "Snowflake", "analytics", "data platform"],
  };
}

function buildCompliantCoverLetter(): TailoredCoverLetter {
  return {
    target_role: "VP of Data & Analytics",
    target_company: "Ignite Corp",
    salutation: "Dear Hiring Manager,",
    opening_paragraph: "I am excited to apply for the VP of Data & Analytics role at Ignite Corp, where my experience building enterprise data organizations and delivering measurable business impact aligns directly with your team's objectives.",
    body_paragraphs: [
      "At Acme Financial Group, I led a 45-person data organization and drove $12M in annual cost savings by architecting a unified Snowflake data platform that consolidated 7 legacy data warehouses. This initiative required cross-functional alignment with engineering, finance, and executive stakeholders to deliver on an aggressive 18-month timeline.",
      "Previously at HealthTech Solutions Inc., I developed a patient readmission prediction model achieving 0.89 AUC that prevented an estimated 4,200 unnecessary readmissions annually, saving $31M. This work demonstrated my ability to translate advanced analytics into direct business and patient outcomes.",
    ],
    closing_paragraph: "I would welcome the opportunity to discuss how my experience leading data transformations at scale can contribute to your data strategy. Thank you for your consideration.",
    sign_off: "Sincerely,\nEd Martinez",
    value_claims: [
      {
        claim_sentence: "I drove $12M in annual cost savings by architecting a unified Snowflake data platform that consolidated 7 legacy data warehouses.",
        source_hash: "exp-001-b2",
        evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses",
        metric_used: "$12M",
      },
      {
        claim_sentence: "I developed a patient readmission prediction model achieving 0.89 AUC that prevented an estimated 4,200 unnecessary readmissions annually, saving $31M.",
        source_hash: "exp-002-b2",
        evidence_quote: "Developed patient readmission prediction model achieving 0.89 AUC, preventing an estimated 4,200 unnecessary readmissions annually saving $31M",
        metric_used: "$31M",
      },
    ],
    evidence_pointers: [
      { claim_text: "I led a 45-person data organization", source_hash: "exp-001-b1", evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units", confidence: 0.90 },
      { claim_text: "I drove $12M in annual cost savings by architecting a unified Snowflake data platform", source_hash: "exp-001-b2", evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses", confidence: 0.95 },
      { claim_text: "I developed a patient readmission prediction model achieving 0.89 AUC", source_hash: "exp-002-b2", evidence_quote: "Developed patient readmission prediction model achieving 0.89 AUC, preventing an estimated 4,200 unnecessary readmissions annually saving $31M", confidence: 0.95 },
    ],
    gap_notes: [],
    company_research_todo: ["Research Ignite Corp data infrastructure and strategic priorities"],
    word_count: 290,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("E2E: Full Packet Pipeline", () => {
  describe("Stage 1: Allowlist construction from inventory", () => {
    it("extracts all companies from experience + education", () => {
      expect(allowlist.companies.length).toBeGreaterThanOrEqual(6); // 4 employers + 2 institutions
    });

    it("extracts all metrics with parsed numbers", () => {
      expect(allowlist.metrics.length).toBeGreaterThan(10);
      const has12M = allowlist.metrics.some((m: any) => m.raw.includes("$12M"));
      expect(has12M).toBe(true);
    });

    it("extracts skills across all categories", () => {
      expect(allowlist.skills.length).toBeGreaterThan(20);
    });
  });

  describe("Stage 2: Prompt construction", () => {
    it("resume system prompt includes all 8 rules", () => {
      const prompt = buildResumeSystemPrompt();
      expect(prompt).toContain("ENTITY ALLOWLIST LOCK-DOWN");
      expect(prompt).toContain("EVIDENCE ON EVERY BULLET");
      expect(prompt).toContain("REJECT, DON'T FABRICATE");
      expect(prompt).toContain("NUMBERS ARE SACRED");
    });

    it("resume user prompt includes inventory and allowlist", () => {
      const prompt = buildResumeUserPrompt(inventory, allowlist, { must_have: [], nice_to_have: [] } as any, "VP Data", "TestCo");
      expect(prompt).toContain("Acme Financial Group");
      expect(prompt).toContain("ENTITY ALLOWLIST");
      expect(prompt).toContain("JOB REQUIREMENTS");
    });

    it("cover letter system prompt includes word count rule", () => {
      const prompt = buildCoverLetterSystemPrompt();
      expect(prompt).toContain("250-350");
      expect(prompt).toContain("EXACTLY 1-3 VALUE CLAIMS");
    });
  });

  describe("Stage 3: Schema validation", () => {
    it("compliant resume passes Zod schema", () => {
      const result = TailoredResumeSchema.safeParse(buildCompliantResume());
      expect(result.success).toBe(true);
    });

    it("compliant cover letter passes Zod schema", () => {
      const result = TailoredCoverLetterSchema.safeParse(buildCompliantCoverLetter());
      expect(result.success).toBe(true);
    });

    it("resume missing evidence_pointers fails schema", () => {
      const resume = buildCompliantResume();
      (resume as any).evidence_pointers = undefined;
      const result = TailoredResumeSchema.safeParse(resume);
      expect(result.success).toBe(false);
    });

    it("cover letter with 0 value_claims fails schema", () => {
      const cl = buildCompliantCoverLetter();
      cl.value_claims = [];
      const result = TailoredCoverLetterSchema.safeParse(cl);
      expect(result.success).toBe(false);
    });
  });

  describe("Stage 4: Truthfulness verification", () => {
    it("compliant resume + cover letter passes all 6 layers", () => {
      const report = runTruthfulnessVerification(
        buildCompliantResume(),
        buildCompliantCoverLetter(),
        allowlist,
        inventory,
      );
      expect(report.pass).toBe(true);
      expect(report.stats.critical_violations).toBe(0);
      expect(report.stats.total_checks).toBeGreaterThan(20);
    });

    it("hallucinated employer triggers NEW_ENTITY critical", () => {
      const resume = buildCompliantResume();
      resume.experience[0].employer = "Google DeepMind";
      const report = runTruthfulnessVerification(resume, buildCompliantCoverLetter(), allowlist, inventory);
      expect(report.pass).toBe(false);
      expect(report.violations.some(v => v.type === "NEW_ENTITY" && v.severity === "critical")).toBe(true);
    });

    it("fabricated metric triggers UNSUPPORTED_METRIC critical", () => {
      const resume = buildCompliantResume();
      resume.experience[0].bullets[0].text = "Led a 200-person team saving $750M through revolutionary AI";
      const report = runTruthfulnessVerification(resume, buildCompliantCoverLetter(), allowlist, inventory);
      const metricViolations = report.violations.filter(v => v.type === "UNSUPPORTED_METRIC");
      expect(metricViolations.length).toBeGreaterThan(0);
    });

    it("missing source_hash triggers STYLE_RULE_BROKEN critical", () => {
      const resume = buildCompliantResume();
      resume.experience[0].bullets[0].source_hash = "";
      const report = runTruthfulnessVerification(resume, buildCompliantCoverLetter(), allowlist, inventory);
      const styleViolations = report.violations.filter(v => v.type === "STYLE_RULE_BROKEN" && v.severity === "critical");
      expect(styleViolations.length).toBeGreaterThan(0);
    });

    it("wrong date triggers INCONSISTENT_DATE critical", () => {
      const resume = buildCompliantResume();
      resume.experience[0].start_date = "2019-01";
      const report = runTruthfulnessVerification(resume, buildCompliantCoverLetter(), allowlist, inventory);
      const dateViolations = report.violations.filter(v => v.type === "INCONSISTENT_DATE");
      expect(dateViolations.length).toBeGreaterThan(0);
    });
  });

  describe("Stage 5: DOCX rendering", () => {
    it("renders compliant resume to valid DOCX", async () => {
      const buffer = await renderResumeDocx(buildCompliantResume(), inventory.profile);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
      // ZIP magic number
      expect(buffer[0]).toBe(0x50);
      expect(buffer[1]).toBe(0x4b);
    });

    it("renders compliant cover letter to valid DOCX", async () => {
      const buffer = await renderCoverLetterDocx(buildCompliantCoverLetter(), inventory.profile);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(500);
    });

    it("resume with missing fields renders without crash", async () => {
      const resume = buildCompliantResume();
      delete (resume as any).certifications;
      delete (resume as any).skills.data_science;
      const buffer = await renderResumeDocx(resume, { name: "Test User" });
      expect(buffer).toBeInstanceOf(Buffer);
    });
  });

  describe("Stage 6: Correction prompt", () => {
    it("builds correction prompt with violation details", () => {
      const prompt = buildCorrectionPrompt(
        "resume",
        '{"target_role": "Test"}',
        [{ type: "NEW_ENTITY", severity: "critical", location: "resume.experience[0].employer", found_value: "Google", explanation: "Not in allowlist" }],
        [{ location: "resume.experience[0].employer", current_text: "Google", suggested_text: "Acme Financial Group", reason: "Use allowlisted employer", violation_type: "NEW_ENTITY" }],
        2,
      );
      expect(prompt).toContain("Attempt 2");
      expect(prompt).toContain("Google");
      expect(prompt).toContain("Acme Financial Group");
    });
  });

  describe("Stage 7: Gap notes (missing data handling)", () => {
    it("gap notes are preserved through verification", () => {
      const resume = buildCompliantResume();
      expect(resume.gap_notes.length).toBeGreaterThan(0);
      expect(resume.gap_notes[0].requirement_text).toContain("Kubernetes");

      const report = runTruthfulnessVerification(resume, buildCompliantCoverLetter(), allowlist, inventory);
      // Gap notes should NOT cause verification failures
      expect(report.pass).toBe(true);
    });

    it("company_research_todo in cover letter is preserved", () => {
      const cl = buildCompliantCoverLetter();
      expect(cl.company_research_todo.length).toBeGreaterThan(0);
    });
  });
});

describe("Pagination checks", () => {
  it("1 page resume is within 2-page limit", () => {
    expect(checkPagination(1, 2).withinLimit).toBe(true);
  });
  it("3 page resume exceeds 2-page limit", () => {
    expect(checkPagination(3, 2).withinLimit).toBe(false);
  });
  it("2 page cover letter exceeds 1-page limit", () => {
    expect(checkPagination(2, 1).withinLimit).toBe(false);
  });
});
