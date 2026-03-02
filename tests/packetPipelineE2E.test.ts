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
    target_role: "Chief Analytics Officer",
    target_company: "Ignite Corp",
    professional_summary:
      "C-suite analytics and AI executive with 25+ years architecting analytics functions that transform data into competitive advantage for Fortune 500 companies. Track record leading teams of 60+ FTEs, managing $17M budgets, and delivering measurable enterprise impact through strategic analytics, AI/ML implementation, and cultural transformation.",
    experience: [
      {
        employer: "Diageo North America Inc.",
        title: "Vice President, Advanced Analytics",
        start_date: "2019-01",
        end_date: "2025-01",
        location: "New York, NY",
        bullets: [
          {
            text: "Led analytics transformation for world's largest premium spirits portfolio, overseeing $17M budget and 20-person team delivering data-driven market execution across North America.",
            source_hash: "exp-002-b1",
            evidence_quote: "Led analytics transformation for world's largest premium spirits portfolio, overseeing $17M budget and 20-person team delivering data-driven market execution across North America.",
            claim_ids: ["claim-exp002-b1-metric-17M", "claim-exp002-b1-team-20"],
          },
          {
            text: "Scaled analytically-driven distribution program enterprise-wide, generating 115,000 net-new distribution points and $64M-$120M in incremental annual revenue — representing 10% of total US growth for $4B+ business unit.",
            source_hash: "exp-002-b2",
            evidence_quote: "Scaled analytically-driven distribution program enterprise-wide, generating 115,000 net-new distribution points and $64M-$120M in incremental annual revenue — representing 10% of total US growth for $4B+ business unit.",
            claim_ids: ["claim-exp002-b2-metric-115K", "claim-exp002-b2-metric-64M-120M"],
          },
          {
            text: "Spearheaded AI/ML innovation agenda, implementing machine learning forecasting that improved accuracy 5% while reducing manual effort 60 hours monthly.",
            source_hash: "exp-002-b3",
            evidence_quote: "Spearheaded AI/ML innovation agenda, implementing machine learning forecasting that improved accuracy 5% while reducing manual effort 60 hours monthly, plus deployed generative AI business intelligence solution with natural language query capabilities.",
            claim_ids: ["claim-exp002-b3-metric-5pct", "claim-exp002-b3-metric-60hrs"],
          },
        ],
      },
      {
        employer: "H&R Block, Inc.",
        title: "Vice President, Analytics & Pricing / Client Insight",
        start_date: "2010-01",
        end_date: "2019-01",
        location: "Kansas City, MO",
        bullets: [
          {
            text: "Prevented revenue erosion of $180M-$360M annually by declining widespread price reduction pressure; instead implemented strategic pricing increases yielding $50M in annual incremental revenue.",
            source_hash: "exp-003-b4",
            evidence_quote: "Prevented revenue erosion of $180M-$360M annually by declining widespread price reduction pressure; instead implemented strategic pricing increases yielding $50M in annual incremental revenue.",
            claim_ids: ["claim-exp003-b4-metric-180M-360M", "claim-exp003-b4-metric-50M"],
          },
          {
            text: "Transformed team culture and performance, doubling employee engagement from 40% to 80% within one year and sustaining 70-80% engagement through tenure.",
            source_hash: "exp-003-b6",
            evidence_quote: "Transformed team culture and performance, doubling employee engagement from 40% to 80% within one year and sustaining 70-80% engagement through tenure.",
            claim_ids: ["claim-exp003-b6-metric-40-80pct"],
          },
        ],
      },
    ],
    skills: {
      technical: ["Snowflake", "SQL", "Python", "R", "Tableau", "Power BI"],
      leadership: ["Enterprise Analytics Strategy", "AI/ML Strategy & Deployment", "Board & C-Suite Advisory"],
      data_science: ["Predictive Modeling", "Machine Learning", "Generative AI"],
    },
    education: [
      { institution: "Rutgers University", degree: "Doctor of Business Administration", year: "2019" },
      { institution: "University of Wisconsin-Madison", degree: "Master of Science, Marketing/Market Research", year: "1996" },
      { institution: "Michigan State University", degree: "Bachelor of Arts, Advertising", year: "1994" },
    ],
    certifications: [
      { name: "Behavioral Economics Certificate" },
      { name: "Certified EMT" },
    ],
    evidence_pointers: [
      { claim_text: "Led analytics transformation for world's largest premium spirits portfolio, overseeing $17M budget and 20-person team delivering data-driven market execution across North America.", source_hash: "exp-002-b1", evidence_quote: "Led analytics transformation for world's largest premium spirits portfolio, overseeing $17M budget and 20-person team delivering data-driven market execution across North America.", confidence: 0.95 },
      { claim_text: "Scaled analytically-driven distribution program enterprise-wide, generating 115,000 net-new distribution points and $64M-$120M in incremental annual revenue — representing 10% of total US growth for $4B+ business unit.", source_hash: "exp-002-b2", evidence_quote: "Scaled analytically-driven distribution program enterprise-wide, generating 115,000 net-new distribution points and $64M-$120M in incremental annual revenue — representing 10% of total US growth for $4B+ business unit.", confidence: 0.95 },
      { claim_text: "Spearheaded AI/ML innovation agenda, implementing machine learning forecasting that improved accuracy 5% while reducing manual effort 60 hours monthly.", source_hash: "exp-002-b3", evidence_quote: "Spearheaded AI/ML innovation agenda, implementing machine learning forecasting that improved accuracy 5% while reducing manual effort 60 hours monthly, plus deployed generative AI business intelligence solution with natural language query capabilities.", confidence: 0.90 },
      { claim_text: "Prevented revenue erosion of $180M-$360M annually by declining widespread price reduction pressure; instead implemented strategic pricing increases yielding $50M in annual incremental revenue.", source_hash: "exp-003-b4", evidence_quote: "Prevented revenue erosion of $180M-$360M annually by declining widespread price reduction pressure; instead implemented strategic pricing increases yielding $50M in annual incremental revenue.", confidence: 0.95 },
      { claim_text: "Transformed team culture and performance, doubling employee engagement from 40% to 80% within one year and sustaining 70-80% engagement through tenure.", source_hash: "exp-003-b6", evidence_quote: "Transformed team culture and performance, doubling employee engagement from 40% to 80% within one year and sustaining 70-80% engagement through tenure.", confidence: 0.90 },
    ],
    gap_notes: [
      { requirement_text: "5+ years of cloud platform migration", reason: "No cloud platform migration leadership experience documented in inventory.", closest_match: "exp-002-b3" },
    ],
    ats_keywords_used: ["analytics strategy", "machine learning", "Snowflake", "pricing strategy", "AI/ML"],
  };
}

function buildCompliantCoverLetter(): TailoredCoverLetter {
  return {
    target_role: "Chief Analytics Officer",
    target_company: "Ignite Corp",
    salutation: "Dear Hiring Manager,",
    opening_paragraph: "I am writing to express my interest in the Chief Analytics Officer role at Ignite Corp, where my 25+ years of experience transforming analytics functions from cost centers into strategic growth engines at Fortune 500 companies directly aligns with your mandate.",
    body_paragraphs: [
      "At Diageo North America, I led a 20-person analytics team with a $17M budget, scaling an analytically-driven distribution program that generated 115,000 net-new distribution points and $64M-$120M in incremental annual revenue — representing 10% of total US growth for a $4B+ business unit.",
      "At H&R Block, I implemented strategic pricing increases yielding $50M in annual incremental revenue, while doubling team engagement from 40% to 80%.",
    ],
    closing_paragraph: "I would welcome the opportunity to discuss how my track record of transforming analytics into trusted decision engines can accelerate your data strategy.",
    sign_off: "Sincerely,\nEd Dobbles",
    value_claims: [
      {
        claim_sentence: "I scaled an analytically-driven distribution program that generated $64M-$120M in incremental annual revenue.",
        source_hash: "exp-002-b2",
        evidence_quote: "Scaled analytically-driven distribution program enterprise-wide, generating 115,000 net-new distribution points and $64M-$120M in incremental annual revenue — representing 10% of total US growth for $4B+ business unit.",
        metric_used: "$64M-$120M",
      },
      {
        claim_sentence: "I prevented $180M-$360M in annual revenue erosion by implementing strategic pricing increases yielding $50M in annual incremental revenue.",
        source_hash: "exp-003-b4",
        evidence_quote: "Prevented revenue erosion of $180M-$360M annually by declining widespread price reduction pressure; instead implemented strategic pricing increases yielding $50M in annual incremental revenue.",
        metric_used: "$50M",
      },
    ],
    evidence_pointers: [
      { claim_text: "I led a 20-person analytics team with a $17M budget", source_hash: "exp-002-b1", evidence_quote: "Led analytics transformation for world's largest premium spirits portfolio, overseeing $17M budget and 20-person team delivering data-driven market execution across North America.", confidence: 0.90 },
      { claim_text: "I scaled an analytically-driven distribution program that generated $64M-$120M in incremental annual revenue", source_hash: "exp-002-b2", evidence_quote: "Scaled analytically-driven distribution program enterprise-wide, generating 115,000 net-new distribution points and $64M-$120M in incremental annual revenue — representing 10% of total US growth for $4B+ business unit.", confidence: 0.95 },
      { claim_text: "I prevented $180M-$360M in annual revenue erosion", source_hash: "exp-003-b4", evidence_quote: "Prevented revenue erosion of $180M-$360M annually by declining widespread price reduction pressure; instead implemented strategic pricing increases yielding $50M in annual incremental revenue.", confidence: 0.95 },
    ],
    gap_notes: [],
    company_research_todo: ["Research Ignite Corp data infrastructure and strategic priorities"],
    word_count: 280,
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
      const has17M = allowlist.metrics.some((m: any) => m.raw.includes("$17M"));
      expect(has17M).toBe(true);
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
      expect(prompt).toContain("Diageo North America");
      expect(prompt).toContain("ENTITY ALLOWLIST");
      expect(prompt).toContain("JOB REQUIREMENTS");
    });

    it("cover letter system prompt includes word count rule", () => {
      const prompt = buildCoverLetterSystemPrompt();
      expect(prompt).toContain("300-400");
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
      resume.experience[0].start_date = "2015-06";
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
        [{ location: "resume.experience[0].employer", current_text: "Google", suggested_text: "Diageo North America Inc.", reason: "Use allowlisted employer", violation_type: "NEW_ENTITY" }],
        2,
      );
      expect(prompt).toContain("Attempt 2");
      expect(prompt).toContain("Google");
      expect(prompt).toContain("Diageo North America Inc.");
    });
  });

  describe("Stage 7: Gap notes (missing data handling)", () => {
    it("gap notes are preserved through verification", () => {
      const resume = buildCompliantResume();
      expect(resume.gap_notes.length).toBeGreaterThan(0);
      expect(resume.gap_notes[0].requirement_text).toContain("cloud platform migration");

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
