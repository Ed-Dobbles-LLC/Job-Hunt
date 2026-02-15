/**
 * Stage 8: Recruiter Review — Unit & Integration Tests
 *
 * Tests cover:
 *   1. Zod schema validation for RecruiterReviewReport
 *   2. buildRepairContext output structure
 *   3. Reviewer flags new numbers not in ledger (via mock)
 *   4. Reviewer flags "board increased AI investment by 50%" if absent
 *   5. Reviewer flags corrupted words ("Influencedd")
 *   6. Reviewer flags generic summary template
 *   7. Reviewer PASS when clean
 *   8. Integration: pipeline result includes recruiter_review field
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RecruiterReviewReportSchema,
  RecruiterReviewIssueSchema,
  RecruiterReviewScoresSchema,
  type RecruiterReviewReport,
  type RecruiterReviewIssue,
} from "../src/resume-engine/types";

// ── Mock the LLM retry wrapper ────────────────────────────────────

const mockResilientGenerateObject = vi.fn();

vi.mock("../src/resume-engine/llm-retry", () => ({
  resilientGenerateObject: (...args: any[]) => mockResilientGenerateObject(...args),
  LLMError: class LLMError extends Error {
    errorType: string;
    requestId: string;
    attempts: number;
    telemetry: any[];
    constructor(msg: string, errorType: string, requestId: string, attempts: number, telemetry: any[]) {
      super(msg);
      this.name = "LLMError";
      this.errorType = errorType;
      this.requestId = requestId;
      this.attempts = attempts;
      this.telemetry = telemetry;
    }
    toUserMessage() { return this.message; }
    toDebugPayload() { return {}; }
  },
}));

// ── Import after mocks ────────────────────────────────────────────

import { runRecruiterReview, buildRepairContext } from "../src/resume-engine/stage8-recruiter-review/reviewer";
import type { ClaimsLedger, MandateProfile } from "../src/resume-engine/types";
import type { VerifierReport } from "../src/mastra/tools/truthfulnessVerifier";

// ── Test Fixtures ────────────────────────────────────────────────

function makeTestLedger(): ClaimsLedger {
  return {
    claims: [],
    roles: [
      { id: "cl-0-role-1", type: "role", value: "VP of Data & Analytics at Acme Financial Group", normalized: "vp of data & analytics at acme financial group", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0]", original_text: "VP of Data & Analytics" } },
    ],
    metrics: [
      { id: "cl-0-metric-1", type: "metric", value: "$12M annual cost savings", normalized: "$12m annual cost savings", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0].bullets[1]", original_text: "Delivered $12M annual cost savings" }, metric_detail: { number: 12000000, unit: "$M", display: "$12M" } },
      { id: "cl-0-metric-2", type: "metric", value: "45-person team", normalized: "45-person team", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0].bullets[0]", original_text: "Led a 45-person data organization" }, metric_detail: { number: 45, unit: "person", display: "45-person" } },
    ],
    scopes: [],
    tools: [
      { id: "cl-0-tool-1", type: "tool", value: "Snowflake", normalized: "snowflake", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0].bullets[1]", original_text: "Snowflake" }, tool_detail: { category: "platform" } },
      { id: "cl-0-tool-2", type: "tool", value: "dbt", normalized: "dbt", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0].bullets[1]", original_text: "dbt" }, tool_detail: { category: "framework" } },
      { id: "cl-0-tool-3", type: "tool", value: "Python", normalized: "python", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0].bullets[1]", original_text: "Python" }, tool_detail: { category: "language" } },
    ],
    capabilities: [],
    certifications: [],
    education: [],
    bullet_texts: [
      { id: "cl-0-bullet-1", type: "bullet_text", value: "Led a 45-person data organization spanning analytics engineering, data science, and BI across 3 business units", normalized: "led a 45-person data organization spanning analytics engineering, data science, and bi across 3 business units", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0].bullets[0]", original_text: "Led a 45-person data organization" } },
      { id: "cl-0-bullet-2", type: "bullet_text", value: "Delivered $12M annual cost savings through data pipeline modernization on Snowflake and dbt", normalized: "delivered $12m annual cost savings through data pipeline modernization on snowflake and dbt", role_index: 0, role_label: "Acme Financial Group", source_span: { section: "experience[0].bullets[1]", original_text: "Delivered $12M annual cost savings" } },
    ],
    total_claims: 7,
  };
}

function makeTestMandate(): MandateProfile {
  return {
    dimensions: [],
    primary_mandate: "bi_platform_modernization",
    secondary_mandates: ["governance_standardization"],
    top_3_archetypes: [
      { id: "bi_platform_modernization", label: "BI Platform Modernization", score: 4.2 },
      { id: "governance_standardization", label: "Governance Standardization", score: 3.1 },
      { id: "team_leadership_scale", label: "Team Leadership & Scale", score: 2.8 },
    ],
    seniority_level: "VP",
    calibrated_headline: "VP, Data & Analytics",
    tone_guidance: {
      seniority: "VP",
      summary_posture: "mandate-anchored thesis",
      bullet_framing: "outcome-first, metric-rich",
      competency_emphasis: "platform + governance",
      headline_tone: "functional authority",
    },
    gaps_vs_inventory: [],
  };
}

function makeTestTruthAuditReport(): VerifierReport {
  return {
    pass: true,
    violations: [],
    line_item_fixes: [],
    stats: {
      total_checks: 24,
      critical_violations: 0,
      warnings: 0,
      entities_checked: 6,
      metrics_checked: 4,
      dates_checked: 4,
      evidence_pointers_validated: 8,
      denylist_scans: 2,
    },
  };
}

function makePassingReviewReport(): RecruiterReviewReport {
  return {
    status: "PASS",
    critical_issues: [],
    major_issues: [],
    minor_issues: [],
    scores: {
      truthfulness: 95,
      ownership_inflation: 100,
      mandate_alignment: 90,
      differentiation: 85,
      readability: 95,
      aesthetics: 88,
    },
    recommended_actions: [],
    safe_rewrite_allowed: true,
  };
}

function makeFailingReviewReport(): RecruiterReviewReport {
  return {
    status: "FAIL",
    critical_issues: [
      {
        type: "UNGROUNDED_METRIC",
        evidence: "$50M revenue increase",
        location: "resume.experience[0].bullets[2]",
        fix: "Remove the $50M claim — it does not appear in the Claims Ledger.",
      },
    ],
    major_issues: [
      {
        type: "CORRUPTED_WORD",
        evidence: "Influencedd",
        location: "resume.experience[0].bullets[0]",
        fix: "Correct to 'Influenced'",
      },
    ],
    minor_issues: [],
    scores: {
      truthfulness: 60,
      ownership_inflation: 75,
      mandate_alignment: 80,
      differentiation: 70,
      readability: 55,
      aesthetics: 80,
    },
    recommended_actions: [
      "Remove $50M claim — not in Claims Ledger",
      "Fix corrupted word 'Influencedd' → 'Influenced'",
    ],
    safe_rewrite_allowed: true,
  };
}

function makeTestResume(): any {
  return {
    target_role: "VP, Data & Analytics",
    target_company: "TestCorp",
    professional_summary: "Data platform leader who architected enterprise Snowflake migrations delivering $12M in annual cost savings across 3 business units.",
    executive_headline: "VP, Data & Analytics",
    ats_keywords_used: ["Snowflake", "data governance", "analytics"],
    core_competencies: ["Data Governance", "Analytics Engineering", "Team Leadership", "Cloud Migration", "BI Modernization"],
    experience: [
      {
        employer: "Acme Financial Group",
        title: "VP of Data & Analytics",
        start_date: "2021-03",
        end_date: "present",
        location: "Chicago, IL (Hybrid)",
        bullets: [
          { text: "Led a 45-person data organization spanning analytics engineering, data science, and BI across 3 business units", source_hash: "exp-001-b1", evidence_quote: "Led a 45-person data organization", claim_ids: ["cl-0-metric-2", "cl-0-bullet-1"] },
          { text: "Delivered $12M annual cost savings through data pipeline modernization on Snowflake and dbt", source_hash: "exp-001-b2", evidence_quote: "Delivered $12M annual cost savings", claim_ids: ["cl-0-metric-1", "cl-0-tool-1"] },
        ],
      },
    ],
    education: [{ institution: "University of Chicago", degree: "MBA", year: "2010" }],
    certifications: [{ name: "AWS Certified Solutions Architect", year: "2020" }],
    skills: {
      tools_and_platforms: ["Python", "Snowflake", "dbt", "SQL"],
      enterprise_capabilities: ["Data Governance", "Analytics Engineering"],
    },
    gap_notes: [],
    evidence_pointers: [],
  };
}

function makeTestCoverLetter(): any {
  return {
    salutation: "Dear Hiring Manager,",
    opening_paragraph: "With deep expertise in enterprise data platform modernization, I am well-positioned to lead TestCorp's next phase of analytics transformation.",
    body_paragraphs: ["At Acme Financial Group, I led a 45-person team that delivered $12M in annual cost savings through a Snowflake migration that consolidated three legacy warehouses."],
    closing_paragraph: "I look forward to discussing how my platform modernization and governance expertise can accelerate TestCorp's data strategy.",
    sign_off: "Best regards,\nEd Martinez",
    word_count: 280,
    evidence_pointers: [],
  };
}

// ── Schema Validation Tests ──────────────────────────────────────

describe("RecruiterReviewReport Schema", () => {
  it("validates a PASS report", () => {
    const report = makePassingReviewReport();
    const result = RecruiterReviewReportSchema.safeParse(report);
    expect(result.success).toBe(true);
  });

  it("validates a FAIL report with issues", () => {
    const report = makeFailingReviewReport();
    const result = RecruiterReviewReportSchema.safeParse(report);
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const report = { ...makePassingReviewReport(), status: "MAYBE" };
    const result = RecruiterReviewReportSchema.safeParse(report);
    expect(result.success).toBe(false);
  });

  it("rejects scores outside 0-100 range", () => {
    const report = makePassingReviewReport();
    report.scores.truthfulness = 150;
    const result = RecruiterReviewReportSchema.safeParse(report);
    expect(result.success).toBe(false);
  });

  it("validates all issue types", () => {
    const issueTypes = [
      "UNGROUNDED_METRIC", "UNGROUNDED_TOOL", "UNGROUNDED_CLAIM",
      "OWNERSHIP_INFLATION", "CORRUPTED_WORD", "TYPO",
      "INCONSISTENT_TENSE", "GENERIC_SUMMARY", "REPEATED_PHRASE",
      "VAGUE_CLAIM", "MANDATE_MISMATCH", "AESTHETIC_DENSITY",
      "COMPETENCY_BLOAT", "LENGTH_VIOLATION", "COVER_LETTER_DEFECT",
    ];

    for (const issueType of issueTypes) {
      const issue: RecruiterReviewIssue = {
        type: issueType as any,
        evidence: "test evidence",
        location: "resume.summary",
        fix: "test fix",
      };
      const result = RecruiterReviewIssueSchema.safeParse(issue);
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown issue type", () => {
    const issue = {
      type: "UNKNOWN_TYPE",
      evidence: "test",
      location: "resume",
      fix: "test",
    };
    const result = RecruiterReviewIssueSchema.safeParse(issue);
    expect(result.success).toBe(false);
  });

  it("validates score schema independently", () => {
    const scores = {
      truthfulness: 95,
      ownership_inflation: 100,
      mandate_alignment: 90,
      differentiation: 85,
      readability: 92,
      aesthetics: 88,
    };
    const result = RecruiterReviewScoresSchema.safeParse(scores);
    expect(result.success).toBe(true);
  });
});

// ── buildRepairContext Tests ─────────────────────────────────────

describe("buildRepairContext", () => {
  it("includes all critical and major issues in repair instructions", () => {
    const report = makeFailingReviewReport();
    const { repairInstructions, fixCount } = buildRepairContext(report);

    expect(fixCount).toBe(2); // 1 critical + 1 major
    expect(repairInstructions).toContain("[CRITICAL]");
    expect(repairInstructions).toContain("[MAJOR]");
    expect(repairInstructions).toContain("$50M revenue increase");
    expect(repairInstructions).toContain("Influencedd");
  });

  it("returns 0 fixes for a passing report", () => {
    const report = makePassingReviewReport();
    const { fixCount } = buildRepairContext(report);
    expect(fixCount).toBe(0);
  });

  it("includes scores in repair instructions", () => {
    const report = makeFailingReviewReport();
    const { repairInstructions } = buildRepairContext(report);

    expect(repairInstructions).toContain("Truthfulness: 60/100");
    expect(repairInstructions).toContain("Readability: 55/100");
  });

  it("does not include minor issues in repair", () => {
    const report: RecruiterReviewReport = {
      ...makeFailingReviewReport(),
      minor_issues: [
        { type: "VAGUE_CLAIM", evidence: "Improved processes", location: "resume.experience[1].bullets[0]", fix: "Add metric" },
      ],
    };
    const { repairInstructions, fixCount } = buildRepairContext(report);

    // Should only have 2 (critical + major), not 3 (minor excluded)
    expect(fixCount).toBe(2);
    expect(repairInstructions).not.toContain("Improved processes");
  });
});

// ── Reviewer LLM Tests (mocked) ─────────────────────────────────

describe("runRecruiterReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns PASS when LLM says clean resume is good", async () => {
    const passReport = makePassingReviewReport();
    mockResilientGenerateObject.mockResolvedValueOnce({ object: passReport, attempts: 1, total_duration_ms: 100, telemetry: [] });

    const result = await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: { page_estimate: { estimated_pages: 1.8, estimated_lines: 86 }, page_band: { actual: 1.8, min: 1.6, max: 2.0, in_band: true }, blocked: false },
      jdText: "VP of Data & Analytics at TestCorp...",
      plaintextResume: "ED MARTINEZ\nVP, Data & Analytics\n...",
      resume: makeTestResume(),
      coverLetter: makeTestCoverLetter(),
    });

    expect(result.report.status).toBe("PASS");
    expect(result.report.critical_issues).toHaveLength(0);
    expect(result.report.scores.truthfulness).toBeGreaterThanOrEqual(80);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(mockResilientGenerateObject).toHaveBeenCalledTimes(1);
  });

  it("flags new numbers not in ledger", async () => {
    const failReport: RecruiterReviewReport = {
      status: "FAIL",
      critical_issues: [
        { type: "UNGROUNDED_METRIC", evidence: "$50M", location: "resume.experience[0].bullets[2]", fix: "Remove $50M — not in Claims Ledger" },
      ],
      major_issues: [],
      minor_issues: [],
      scores: { truthfulness: 55, ownership_inflation: 100, mandate_alignment: 85, differentiation: 80, readability: 90, aesthetics: 85 },
      recommended_actions: ["Remove $50M claim"],
      safe_rewrite_allowed: true,
    };
    mockResilientGenerateObject.mockResolvedValueOnce({ object: failReport, attempts: 1, total_duration_ms: 100, telemetry: [] });

    const result = await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: {},
      jdText: "VP of Data & Analytics...",
      plaintextResume: "Led team that generated $50M in revenue...",
      resume: makeTestResume(),
      coverLetter: makeTestCoverLetter(),
    });

    expect(result.report.status).toBe("FAIL");
    const metricIssues = result.report.critical_issues.filter(i => i.type === "UNGROUNDED_METRIC");
    expect(metricIssues.length).toBeGreaterThan(0);
    expect(metricIssues[0].evidence).toContain("$50M");
  });

  it("flags 'board increased AI investment by 50%' if absent from ledger", async () => {
    const failReport: RecruiterReviewReport = {
      status: "FAIL",
      critical_issues: [
        { type: "OWNERSHIP_INFLATION", evidence: "board increased AI investment by 50%", location: "resume.experience[0].bullets[1]", fix: "Remove board investment claim — not supported by inventory" },
      ],
      major_issues: [],
      minor_issues: [],
      scores: { truthfulness: 50, ownership_inflation: 40, mandate_alignment: 80, differentiation: 75, readability: 90, aesthetics: 85 },
      recommended_actions: ["Remove board investment claim"],
      safe_rewrite_allowed: true,
    };
    mockResilientGenerateObject.mockResolvedValueOnce({ object: failReport, attempts: 1, total_duration_ms: 100, telemetry: [] });

    const result = await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: {},
      jdText: "VP of Data & Analytics...",
      plaintextResume: "Catalyzed board decision that increased AI investment by 50%...",
      resume: makeTestResume(),
      coverLetter: makeTestCoverLetter(),
    });

    expect(result.report.status).toBe("FAIL");
    const inflationIssues = result.report.critical_issues.filter(i => i.type === "OWNERSHIP_INFLATION");
    expect(inflationIssues.length).toBeGreaterThan(0);
    expect(inflationIssues[0].evidence).toContain("board");
  });

  it("flags corrupted words ('Influencedd')", async () => {
    const failReport: RecruiterReviewReport = {
      status: "FAIL",
      critical_issues: [
        { type: "CORRUPTED_WORD", evidence: "Influencedd", location: "resume.experience[0].bullets[0]", fix: "Correct to 'Influenced'" },
      ],
      major_issues: [],
      minor_issues: [],
      scores: { truthfulness: 95, ownership_inflation: 100, mandate_alignment: 90, differentiation: 85, readability: 50, aesthetics: 80 },
      recommended_actions: ["Fix corrupted word"],
      safe_rewrite_allowed: true,
    };
    mockResilientGenerateObject.mockResolvedValueOnce({ object: failReport, attempts: 1, total_duration_ms: 100, telemetry: [] });

    const result = await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: {},
      jdText: "VP of Data & Analytics...",
      plaintextResume: "Influencedd team to adopt modern analytics...",
      resume: makeTestResume(),
      coverLetter: makeTestCoverLetter(),
    });

    expect(result.report.status).toBe("FAIL");
    const corruptedIssues = result.report.critical_issues.filter(i => i.type === "CORRUPTED_WORD");
    expect(corruptedIssues.length).toBeGreaterThan(0);
    expect(corruptedIssues[0].evidence).toBe("Influencedd");
  });

  it("flags generic summary template", async () => {
    const failReport: RecruiterReviewReport = {
      status: "FAIL",
      critical_issues: [],
      major_issues: [
        { type: "GENERIC_SUMMARY", evidence: "Executive with track record of delivering results", location: "resume.professional_summary", fix: "Replace with mandate-specific thesis anchored to BI platform modernization" },
      ],
      minor_issues: [],
      scores: { truthfulness: 95, ownership_inflation: 100, mandate_alignment: 55, differentiation: 50, readability: 90, aesthetics: 80 },
      recommended_actions: ["Rewrite summary opener with mandate-specific thesis"],
      safe_rewrite_allowed: true,
    };
    mockResilientGenerateObject.mockResolvedValueOnce({ object: failReport, attempts: 1, total_duration_ms: 100, telemetry: [] });

    const result = await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: {},
      jdText: "VP of Data & Analytics...",
      plaintextResume: "Executive with track record of delivering results...",
      resume: {
        ...makeTestResume(),
        professional_summary: "Executive with track record of delivering results in data analytics and business intelligence.",
      },
      coverLetter: makeTestCoverLetter(),
    });

    expect(result.report.status).toBe("FAIL");
    const summaryIssues = result.report.major_issues.filter(i => i.type === "GENERIC_SUMMARY");
    expect(summaryIssues.length).toBeGreaterThan(0);
  });

  it("delegates retry handling to resilientGenerateObject", async () => {
    // Retry logic is now inside resilientGenerateObject.
    // The reviewer makes a single call — resilientGenerateObject handles retries internally.
    mockResilientGenerateObject.mockResolvedValueOnce({
      object: makePassingReviewReport(),
      attempts: 2, // resilientGenerateObject retried internally
      total_duration_ms: 3500,
      telemetry: [],
    });

    const result = await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: {},
      jdText: "VP of Data & Analytics...",
      plaintextResume: "...",
      resume: makeTestResume(),
      coverLetter: makeTestCoverLetter(),
    });

    expect(result.report.status).toBe("PASS");
    // Only one call to resilientGenerateObject — it handles retries internally
    expect(mockResilientGenerateObject).toHaveBeenCalledTimes(1);
  });

  it("throws LLMError when resilientGenerateObject exhausts retries", async () => {
    // Import the mock LLMError from our mock setup
    const { LLMError } = await import("../src/resume-engine/llm-retry");

    mockResilientGenerateObject.mockRejectedValueOnce(
      new LLMError(
        "[Stage 8: recruiter-review] Rate limit reached after 6 attempts",
        "rate_limit",
        "req-test",
        6,
        [],
      ),
    );

    await expect(
      runRecruiterReview({
        claimsLedger: makeTestLedger(),
        mandateProfile: makeTestMandate(),
        truthAuditReport: makeTestTruthAuditReport(),
        layoutReport: {},
        jdText: "...",
        plaintextResume: "...",
        resume: makeTestResume(),
        coverLetter: makeTestCoverLetter(),
      }),
    ).rejects.toThrow("Rate limit reached");
  });

  it("passes correct temperature, label, and lane to resilientGenerateObject", async () => {
    mockResilientGenerateObject.mockResolvedValueOnce({ object: makePassingReviewReport(), attempts: 1, total_duration_ms: 100, telemetry: [] });

    await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: {},
      jdText: "...",
      plaintextResume: "...",
      resume: makeTestResume(),
      coverLetter: makeTestCoverLetter(),
    });

    const callArgs = mockResilientGenerateObject.mock.calls[0][0];
    expect(callArgs.temperature).toBe(0.2);
    expect(callArgs.schema).toBeDefined();
    expect(callArgs.label).toBe("Stage 8: recruiter-review");
    expect(callArgs.lane).toBe("medium");
    expect(callArgs.system).toContain("SKEPTICAL");
    expect(callArgs.prompt).toContain("CLAIMS LEDGER");
    expect(callArgs.prompt).toContain("MANDATE PROFILE");
  });

  it("includes prior summaries in prompt when provided", async () => {
    mockResilientGenerateObject.mockResolvedValueOnce({ object: makePassingReviewReport(), attempts: 1, total_duration_ms: 100, telemetry: [] });

    await runRecruiterReview({
      claimsLedger: makeTestLedger(),
      mandateProfile: makeTestMandate(),
      truthAuditReport: makeTestTruthAuditReport(),
      layoutReport: {},
      jdText: "...",
      plaintextResume: "...",
      resume: makeTestResume(),
      coverLetter: makeTestCoverLetter(),
      priorSummaries: ["Previous summary text for differentiation check"],
    });

    const callArgs = mockResilientGenerateObject.mock.calls[0][0];
    expect(callArgs.prompt).toContain("PRIOR RESUME SUMMARIES");
    expect(callArgs.prompt).toContain("Previous summary text");
  });
});

// ── Integration: PipelineResult shape ──────────────────────────────

describe("PipelineResult integration", () => {
  it("recruiter_review field is optional in PipelineResult type", () => {
    // Type-level test: verify the PipelineResult interface accepts recruiter_review
    const result: import("../src/resume-engine/types").PipelineResult = {
      success: true,
      job_id: 1,
      pass: true,
      attempts_used: 1,
      max_attempts: 3,
      resume: {},
      cover_letter: {},
      clarification_questions: [],
      ownership_warnings: [],
      final_report: {},
      recruiter_review: makePassingReviewReport(),
      attempt_history: [],
      human_review_required: false,
      human_review_notes: [],
      stage_results: {},
    };

    expect(result.recruiter_review).toBeDefined();
    expect(result.recruiter_review!.status).toBe("PASS");
  });

  it("PipelineResult works without recruiter_review", () => {
    const result: import("../src/resume-engine/types").PipelineResult = {
      success: true,
      job_id: 1,
      pass: true,
      attempts_used: 1,
      max_attempts: 3,
      resume: {},
      cover_letter: {},
      clarification_questions: [],
      ownership_warnings: [],
      final_report: {},
      attempt_history: [],
      human_review_required: false,
      human_review_notes: [],
      stage_results: {},
    };

    expect(result.recruiter_review).toBeUndefined();
  });
});
