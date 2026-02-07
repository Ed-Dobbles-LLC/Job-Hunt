import { describe, it, expect } from "vitest";
import {
  DailyBriefSchema,
  buildStoragePath,
  discoverFilePaths,
  generateQuestionsForEd,
  type DailyBrief,
  type QuestionForEd,
} from "../src/mastra/tools/dailyBriefTool";
import {
  renderDailyBriefEmail,
  renderDigestEmail,
  type DigestData,
} from "../src/mastra/tools/digestEmailTemplate";
import * as fs from "fs";
import * as path from "path";

describe("DailyBrief Schema", () => {
  it("validates a well-formed DailyBrief", () => {
    const brief: DailyBrief = {
      date: "2025-02-07",
      generated_at: "2025-02-07T12:30:00.000Z",
      storage_root: "/home/runner/workspace/output/2025-02-07",
      summary: {
        jobs_fetched: 15,
        jobs_scored: 12,
        jobs_shortlisted: 5,
        packets_generated: 3,
        truth_pass_count: 2,
        truth_fail_count: 1,
        top_score: 87,
        avg_score: 72.4,
      },
      top_matches: [
        {
          rank: 1,
          job_id: 101,
          company: "Acme Corp",
          title: "Senior Engineer",
          location: "Chicago, IL",
          posting_url: "https://example.com/job/101",
          score: 87,
          role_shape: "IC-Senior",
          truth_pass: true,
          top_skills: ["TypeScript", "AWS", "PostgreSQL"],
          gap_notes: ["No Kubernetes experience listed"],
          file_paths: {
            resume_docx: "/output/2025-02-07/Acme_Corp/Senior_Engineer/Resume_Acme_Corp_Senior_Engineer.docx",
            resume_pdf: "/output/2025-02-07/Acme_Corp/Senior_Engineer/Resume_Acme_Corp_Senior_Engineer.pdf",
            cover_letter_docx: "/output/2025-02-07/Acme_Corp/Senior_Engineer/CoverLetter_Acme_Corp_Senior_Engineer.docx",
            evidence_map: "/output/2025-02-07/Acme_Corp/Senior_Engineer/EvidenceMap_Acme_Corp_Senior_Engineer.json",
          },
          outreach_targets: [
            {
              person_name: "Jane Smith",
              title: "VP Engineering",
              role_category: "department_head",
              confidence: 0.8,
              outreach_angle: "Department leader for engineering team",
              linkedin_search_query: "Jane Smith VP Engineering Acme Corp",
              message_warm: "Hi Jane, noticed we both attended...",
              message_cold: "Hi Jane, your engineering team's work on...",
            },
          ],
        },
      ],
      questions_for_ed: [
        {
          category: "gap_in_experience",
          question: "Should we address this gap?",
          context: "Gap identified: No Kubernetes experience",
          job_id: 101,
          company: "Acme Corp",
          priority: "medium",
        },
      ],
      model_used: "gpt-4o",
      prompt_version: "v2",
    };

    const result = DailyBriefSchema.safeParse(brief);
    expect(result.success).toBe(true);
  });

  it("rejects brief with missing required fields", () => {
    const result = DailyBriefSchema.safeParse({
      date: "2025-02-07",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty top_matches and questions", () => {
    const brief: DailyBrief = {
      date: "2025-02-07",
      generated_at: "2025-02-07T12:30:00.000Z",
      storage_root: "/output/2025-02-07",
      summary: {
        jobs_fetched: 0,
        jobs_scored: 0,
        jobs_shortlisted: 0,
        packets_generated: 0,
        truth_pass_count: 0,
        truth_fail_count: 0,
        top_score: 0,
        avg_score: 0,
      },
      top_matches: [],
      questions_for_ed: [],
      model_used: "gpt-4o",
      prompt_version: "v2",
    };

    const result = DailyBriefSchema.safeParse(brief);
    expect(result.success).toBe(true);
  });

  it("validates all question categories", () => {
    const categories = [
      "missing_company_info",
      "ambiguous_requirement",
      "salary_unknown",
      "contact_not_found",
      "gap_in_experience",
      "application_decision",
      "other",
    ];

    for (const cat of categories) {
      const q: QuestionForEd = {
        category: cat as any,
        question: "Test question?",
        context: "Test context",
        job_id: 1,
        company: "TestCo",
        priority: "medium",
      };
      const result = DailyBriefSchema.shape.questions_for_ed.element.safeParse(q);
      expect(result.success).toBe(true);
    }
  });

  it("validates all priority levels", () => {
    for (const prio of ["high", "medium", "low"]) {
      const q: QuestionForEd = {
        category: "other",
        question: "Test?",
        context: "ctx",
        job_id: 1,
        company: "TestCo",
        priority: prio as any,
      };
      const result = DailyBriefSchema.shape.questions_for_ed.element.safeParse(q);
      expect(result.success).toBe(true);
    }
  });
});

describe("buildStoragePath", () => {
  it("builds correct path with date/company/role", () => {
    const p = buildStoragePath("2025-02-07", "Acme Corp", "Senior Engineer");
    expect(p).toBe("output/2025-02-07/Acme_Corp/Senior_Engineer");
  });

  it("sanitizes special characters", () => {
    const p = buildStoragePath("2025-01-15", "Google (Alphabet)", "Staff SWE / Platform");
    expect(p).toBe("output/2025-01-15/Google_Alphabet/Staff_SWE_Platform");
  });

  it("handles single-word names", () => {
    const p = buildStoragePath("2025-03-01", "Meta", "Engineer");
    expect(p).toBe("output/2025-03-01/Meta/Engineer");
  });
});

describe("discoverFilePaths", () => {
  const testDate = "2099-01-01";
  const testCompany = "TestCo";
  const testTitle = "Dev";
  const testDir = path.join(
    process.cwd(),
    "output",
    testDate,
    "TestCo",
    "Dev",
  );

  it("returns empty when directory does not exist", () => {
    const result = discoverFilePaths("2099-12-31", "NonExist", "Nothing");
    expect(result).toEqual({});
  });

  it("discovers existing files", () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "Resume_TestCo_Dev.docx"), "test");
    fs.writeFileSync(path.join(testDir, "EvidenceMap_TestCo_Dev.json"), "{}");

    const result = discoverFilePaths(testDate, testCompany, testTitle);
    expect(result.resume_docx).toBeDefined();
    expect(result.evidence_map).toBeDefined();
    expect(result.resume_pdf).toBeUndefined();
    expect(result.cover_letter_docx).toBeUndefined();

    fs.rmSync(path.join(process.cwd(), "output", testDate), { recursive: true, force: true });
  });
});

describe("generateQuestionsForEd", () => {
  it("generates gap_in_experience questions from match report gaps", () => {
    const questions = generateQuestionsForEd(
      1,
      "Acme",
      "Engineer",
      { gap_notes: ["No Python experience", "Missing ML background"] },
      null,
      [{ person_name: "Jane", title: "VP" }],
      true,
    );

    const gapQuestions = questions.filter((q) => q.category === "gap_in_experience");
    expect(gapQuestions.length).toBe(2);
    expect(gapQuestions[0].priority).toBe("medium");
  });

  it("generates contact_not_found when no contacts exist", () => {
    const questions = generateQuestionsForEd(
      2,
      "SecretCo",
      "Dev",
      null,
      null,
      [],
      true,
    );

    const contactQ = questions.filter((q) => q.category === "contact_not_found");
    expect(contactQ.length).toBe(1);
    expect(contactQ[0].priority).toBe("high");
    expect(contactQ[0].company).toBe("SecretCo");
  });

  it("generates contact_not_found for NONE FOUND contacts", () => {
    const questions = generateQuestionsForEd(
      3,
      "Mystery",
      "Eng",
      null,
      null,
      [{ person_name: "NONE FOUND", title: "Hiring Manager" }],
      true,
    );

    const contactQ = questions.filter((q) => q.category === "contact_not_found");
    expect(contactQ.length).toBe(1);
  });

  it("generates salary_unknown when no salary in match report", () => {
    const questions = generateQuestionsForEd(
      4,
      "NoPay",
      "Role",
      {},
      null,
      [{ person_name: "Bob", title: "HR" }],
      true,
    );

    const salaryQ = questions.filter((q) => q.category === "salary_unknown");
    expect(salaryQ.length).toBe(1);
    expect(salaryQ[0].priority).toBe("low");
  });

  it("does NOT generate salary question when salary is present", () => {
    const questions = generateQuestionsForEd(
      5,
      "PayCo",
      "Role",
      { salary_range: "$150k-$200k" },
      null,
      [{ person_name: "Bob", title: "HR" }],
      true,
    );

    const salaryQ = questions.filter((q) => q.category === "salary_unknown");
    expect(salaryQ.length).toBe(0);
  });

  it("generates application_decision from red flags", () => {
    const questions = generateQuestionsForEd(
      6,
      "FlagCo",
      "Lead",
      null,
      { red_flags: [{ text: "Requires 10+ years Java", confidence: 0.9 }] },
      [{ person_name: "X", title: "Y" }],
      true,
    );

    const decisionQ = questions.filter((q) => q.category === "application_decision");
    expect(decisionQ.length).toBe(1);
    expect(decisionQ[0].priority).toBe("high");
  });

  it("ignores low-confidence red flags", () => {
    const questions = generateQuestionsForEd(
      7,
      "LowConf",
      "Role",
      null,
      { red_flags: [{ text: "Might need PhD", confidence: 0.3 }] },
      [{ person_name: "X", title: "Y" }],
      true,
    );

    const decisionQ = questions.filter((q) => q.category === "application_decision");
    expect(decisionQ.length).toBe(0);
  });

  it("generates truth failure question when truth_pass is false", () => {
    const questions = generateQuestionsForEd(
      8,
      "FailCo",
      "Role",
      { salary_range: "$100k" },
      null,
      [{ person_name: "Bob", title: "HR" }],
      false,
    );

    const otherQ = questions.filter((q) => q.category === "other");
    expect(otherQ.length).toBe(1);
    expect(otherQ[0].priority).toBe("high");
    expect(otherQ[0].question).toContain("truthfulness verification");
  });

  it("does NOT generate truth question when truth_pass is true", () => {
    const questions = generateQuestionsForEd(
      9,
      "PassCo",
      "Role",
      { salary_range: "$100k" },
      null,
      [{ person_name: "Bob", title: "HR" }],
      true,
    );

    const otherQ = questions.filter((q) => q.category === "other");
    expect(otherQ.length).toBe(0);
  });

  it("returns empty when no issues found", () => {
    const questions = generateQuestionsForEd(
      10,
      "PerfectCo",
      "Role",
      { salary_range: "$150k", gap_notes: [] },
      { red_flags: [] },
      [{ person_name: "Alice", title: "Manager" }],
      true,
    );

    expect(questions.length).toBe(0);
  });

  it("limits gap questions to 2 max", () => {
    const questions = generateQuestionsForEd(
      11,
      "GappyCo",
      "Role",
      {
        gap_notes: ["Gap 1", "Gap 2", "Gap 3", "Gap 4"],
        salary_range: "$100k",
      },
      null,
      [{ person_name: "X", title: "Y" }],
      true,
    );

    const gapQ = questions.filter((q) => q.category === "gap_in_experience");
    expect(gapQ.length).toBe(2);
  });
});

describe("renderDailyBriefEmail", () => {
  const sampleBrief: DailyBrief = {
    date: "2025-02-07",
    generated_at: "2025-02-07T12:30:00.000Z",
    storage_root: "/output/2025-02-07",
    summary: {
      jobs_fetched: 20,
      jobs_scored: 15,
      jobs_shortlisted: 5,
      packets_generated: 3,
      truth_pass_count: 2,
      truth_fail_count: 1,
      top_score: 92,
      avg_score: 75,
    },
    top_matches: [
      {
        rank: 1,
        job_id: 1,
        company: "TechCorp",
        title: "Staff Engineer",
        location: "Remote",
        posting_url: "https://example.com/1",
        score: 92,
        role_shape: "IC-Staff",
        truth_pass: true,
        top_skills: ["TypeScript", "React", "Node.js"],
        gap_notes: ["No Go experience"],
        file_paths: {
          resume_pdf: "/path/resume.pdf",
          cover_letter_pdf: "/path/cover.pdf",
          evidence_map: "/path/evidence.json",
          job_report: "/path/job.json",
        },
        outreach_targets: [
          {
            person_name: "Alice Johnson",
            title: "Engineering Director",
            role_category: "department_head",
            confidence: 0.85,
            outreach_angle: "Department leader",
            linkedin_search_query: "Alice Johnson TechCorp",
            message_warm: "Hi Alice, I noticed we share a background in distributed systems...",
            message_cold: "Hi Alice, TechCorp's cloud platform expansion caught my attention...",
          },
        ],
      },
      {
        rank: 2,
        job_id: 2,
        company: "StartupInc",
        title: "Lead Developer",
        score: 78,
        truth_pass: false,
        top_skills: ["Python", "Django"],
        gap_notes: [],
        file_paths: {},
        outreach_targets: [],
      },
    ],
    questions_for_ed: [
      {
        category: "gap_in_experience",
        question: "Should we address the Go gap?",
        context: "TechCorp requires Go but we have no Go experience listed.",
        job_id: 1,
        company: "TechCorp",
        priority: "medium",
      },
      {
        category: "contact_not_found",
        question: "No contacts found for StartupInc. Do you know anyone there?",
        context: "Role: Lead Developer. Web search found no contacts.",
        job_id: 2,
        company: "StartupInc",
        priority: "high",
      },
      {
        category: "other",
        question: "Truthfulness verification failed for StartupInc. Regenerate?",
        context: "Automated verification found issues.",
        job_id: 2,
        company: "StartupInc",
        priority: "high",
      },
    ],
    model_used: "gpt-4o",
    prompt_version: "v2",
  };

  it("renders valid HTML with all sections", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Daily Brief");
    expect(html).toContain("2025-02-07");
  });

  it("includes stats boxes", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("20");
    expect(html).toContain("15");
    expect(html).toContain("Fetched");
    expect(html).toContain("Scored");
    expect(html).toContain("Shortlisted");
    expect(html).toContain("Packets");
    expect(html).toContain("Pass");
    expect(html).toContain("Fail");
  });

  it("includes top/avg score", () => {
    const html = renderDailyBriefEmail(sampleBrief);
    expect(html).toContain("Top:");
    expect(html).toContain("92");
    expect(html).toContain("Avg:");
    expect(html).toContain("75");
  });

  it("renders ranked table with Files and Contacts columns", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("Files");
    expect(html).toContain("Contacts");
    expect(html).toContain("TechCorp");
    expect(html).toContain("Staff Engineer");
    expect(html).toContain("StartupInc");
  });

  it("renders file-count badges in table", () => {
    const html = renderDailyBriefEmail(sampleBrief);
    expect(html).toContain("4");
  });

  it("renders job detail cards with FILES READY section", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("FILES READY");
    expect(html).toContain("Resume PDF");
    expect(html).toContain("Cover Letter PDF");
    expect(html).toContain("Evidence Map");
  });

  it("renders outreach target cards with message preview", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("OUTREACH TARGETS");
    expect(html).toContain("Alice Johnson");
    expect(html).toContain("Engineering Director");
    expect(html).toContain("distributed systems");
  });

  it("renders Questions for Ed section", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("Questions for Ed");
    expect(html).toContain("3 items");
    expect(html).toContain("2 high priority");
    expect(html).toContain("Should we address the Go gap?");
    expect(html).toContain("Experience Gap");
    expect(html).toContain("No Contact Found");
  });

  it("sorts questions high priority first", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    const highIdx = html.indexOf("No contacts found for StartupInc");
    const mediumIdx = html.indexOf("Should we address the Go gap?");
    expect(highIdx).toBeLessThan(mediumIdx);
  });

  it("renders storage layout tree", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("Storage Layout");
    expect(html).toContain("TechCorp");
    expect(html).toContain("Staff Engineer");
    expect(html).toContain("resume.*");
    expect(html).toContain("coverletter.*");
  });

  it("renders gap notes in job cards", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("GAPS");
    expect(html).toContain("No Go experience");
  });

  it("renders skills pills", () => {
    const html = renderDailyBriefEmail(sampleBrief);

    expect(html).toContain("TypeScript");
    expect(html).toContain("React");
    expect(html).toContain("Node.js");
  });

  it("renders role shape badge", () => {
    const html = renderDailyBriefEmail(sampleBrief);
    expect(html).toContain("IC-Staff");
  });

  it("renders empty state when no matches", () => {
    const emptyBrief: DailyBrief = {
      ...sampleBrief,
      top_matches: [],
      questions_for_ed: [],
      summary: { ...sampleBrief.summary, jobs_shortlisted: 0 },
    };

    const html = renderDailyBriefEmail(emptyBrief);
    expect(html).toContain("No matches today");
  });

  it("header shows match and question counts", () => {
    const html = renderDailyBriefEmail(sampleBrief);
    expect(html).toContain("2 matches");
    expect(html).toContain("3 questions");
  });
});

describe("renderDigestEmail backward compatibility", () => {
  it("still renders legacy DigestData format", () => {
    const data: DigestData = {
      date: "2025-02-07",
      stats: {
        jobsFetched: 10,
        jobsScored: 8,
        jobsShortlisted: 3,
        packetsGenerated: 2,
        truthPassCount: 1,
        truthFailCount: 1,
      },
      jobs: [
        {
          rank: 1,
          company: "OldCo",
          title: "Dev",
          score: 80,
          truthPass: true,
          topSkills: ["JS"],
          gapNotes: [],
        },
      ],
      runTimestamp: "2025-02-07T12:00:00Z",
      modelUsed: "gpt-4o",
      promptVersion: "v2",
    };

    const html = renderDigestEmail(data);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("OldCo");
    expect(html).toContain("Daily Job Match Digest");
  });
});
