import { describe, it, expect } from "vitest";
import {
  ExperienceInventorySchema,
  GapSchema,
  ProfileSchema,
  BulletSchema,
  ExperienceEntrySchema,
  EducationEntrySchema,
  CertificationSchema,
  SkillsSchema,
  InterviewQuestionSchema,
  QAPairSchema,
  SessionStatus,
} from "../src/mastra/tools/profileSchemas";
import { parseResumeBuffer } from "../src/mastra/tools/resumeParserTool";

/* ═══════════════════════════════════════════════════════════════════
   1. Schema validation tests
   ═══════════════════════════════════════════════════════════════════ */

describe("profileSchemas", () => {
  const validInventory = {
    profile: {
      name: "Jane Doe",
      current_title: "Senior Engineer",
      email: "jane@example.com",
      phone: "(555) 999-8888",
      location: "Austin, TX",
      linkedin: "linkedin.com/in/janedoe",
      summary: "Full-stack engineer with 10 years of experience.",
    },
    experience: [
      {
        id: "exp-001",
        employer: "TechCorp",
        title: "Senior Engineer",
        start_date: "2020-01",
        end_date: "present",
        location: "Austin, TX",
        bullets: [
          {
            id: "exp-001-b1",
            text: "Led migration of monolith to microservices serving 2M daily users",
            metrics: ["2M daily users"],
            tools: ["Kubernetes", "Go"],
          },
        ],
      },
    ],
    education: [
      {
        id: "edu-001",
        institution: "MIT",
        degree: "BS Computer Science",
        year: "2014",
      },
    ],
    skills: {
      leadership: ["Team building"],
      technical: ["Go", "TypeScript", "Kubernetes"],
      data_science: ["Machine Learning basics"],
      domains: ["FinTech"],
    },
    certifications: [
      {
        id: "cert-001",
        name: "AWS Solutions Architect",
        year: "2022",
      },
    ],
  };

  it("validates a well-formed ExperienceInventory", () => {
    const result = ExperienceInventorySchema.safeParse(validInventory);
    expect(result.success).toBe(true);
  });

  it("rejects inventory missing profile.name", () => {
    const bad = {
      ...validInventory,
      profile: { ...validInventory.profile, name: undefined },
    };
    const result = ExperienceInventorySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects inventory with empty experience array (still valid structurally)", () => {
    const noExp = { ...validInventory, experience: [] };
    const result = ExperienceInventorySchema.safeParse(noExp);
    expect(result.success).toBe(true); // empty array is valid zod-wise
  });

  it("rejects bullet missing id", () => {
    const result = BulletSchema.safeParse({ text: "Did something" });
    expect(result.success).toBe(false);
  });

  it("validates bullet with optional fields", () => {
    const result = BulletSchema.safeParse({
      id: "exp-001-b1",
      text: "Did something",
    });
    expect(result.success).toBe(true);
  });

  it("validates bullet with metrics and tools", () => {
    const result = BulletSchema.safeParse({
      id: "exp-001-b1",
      text: "Increased revenue by 25%",
      metrics: ["25% revenue increase"],
      tools: ["Python", "SQL"],
    });
    expect(result.success).toBe(true);
  });

  it("validates a Gap object", () => {
    const result = GapSchema.safeParse({
      field: "experience[0].bullets[1].metrics",
      description: "Missing quantified metrics for this bullet",
      priority: "high",
    });
    expect(result.success).toBe(true);
  });

  it("rejects Gap with invalid priority", () => {
    const result = GapSchema.safeParse({
      field: "experience[0]",
      description: "Missing info",
      priority: "critical", // not in enum
    });
    expect(result.success).toBe(false);
  });

  it("validates InterviewQuestion", () => {
    const result = InterviewQuestionSchema.safeParse({
      id: "q-001",
      question: "What tools did you use at TechCorp?",
      targetField: "experience[0].bullets[0].tools",
      priority: "high",
    });
    expect(result.success).toBe(true);
  });

  it("validates QAPair", () => {
    const result = QAPairSchema.safeParse({
      questionId: "q-001",
      question: "What tools did you use?",
      answer: "Kubernetes, Go, and PostgreSQL",
    });
    expect(result.success).toBe(true);
  });

  it("validates SessionStatus values", () => {
    expect(SessionStatus.safeParse("parsing").success).toBe(true);
    expect(SessionStatus.safeParse("interviewing").success).toBe(true);
    expect(SessionStatus.safeParse("review").success).toBe(true);
    expect(SessionStatus.safeParse("finalized").success).toBe(true);
    expect(SessionStatus.safeParse("invalid").success).toBe(false);
  });

  it("validates Profile schema independently", () => {
    const result = ProfileSchema.safeParse(validInventory.profile);
    expect(result.success).toBe(true);
  });

  it("validates ExperienceEntry schema", () => {
    const result = ExperienceEntrySchema.safeParse(validInventory.experience[0]);
    expect(result.success).toBe(true);
  });

  it("validates EducationEntry schema", () => {
    const result = EducationEntrySchema.safeParse(validInventory.education[0]);
    expect(result.success).toBe(true);
  });

  it("validates Certification schema", () => {
    const result = CertificationSchema.safeParse(validInventory.certifications[0]);
    expect(result.success).toBe(true);
  });

  it("validates Skills schema", () => {
    const result = SkillsSchema.safeParse(validInventory.skills);
    expect(result.success).toBe(true);
  });

  it("fills missing categories with defaults", () => {
    const result = SkillsSchema.safeParse({
      leadership: ["Team building"],
      // missing technical, data_science, domains — filled by .default([])
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.technical).toEqual([]);
      expect(result.data.data_science).toEqual([]);
      expect(result.data.domains).toEqual([]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════
   2. Resume parser tests (text extraction)
   ═══════════════════════════════════════════════════════════════════ */

describe("resumeParserTool", () => {
  it("parses plain text resume", async () => {
    const text = `Jane Doe
Senior Software Engineer
jane@example.com | (555) 123-4567

EXPERIENCE
TechCorp - Senior Engineer (2020-present)
- Led migration of monolith to microservices serving 2M daily users
- Reduced API latency by 40% through caching layer implementation

EDUCATION
MIT - BS Computer Science (2014)`;

    const buffer = Buffer.from(text, "utf-8");
    const result = await parseResumeBuffer(buffer, "resume.txt");

    expect(result.format).toBe("txt");
    expect(result.rawText).toContain("Jane Doe");
    expect(result.rawText).toContain("TechCorp");
    expect(result.rawText).toContain("2M daily users");
  });

  it("detects format from file extension", async () => {
    const buffer = Buffer.from("test content", "utf-8");

    const txtResult = await parseResumeBuffer(buffer, "resume.txt");
    expect(txtResult.format).toBe("txt");

    const csvResult = await parseResumeBuffer(buffer, "data.csv");
    expect(csvResult.format).toBe("txt"); // fallback to txt
  });

  it("handles empty text file gracefully", async () => {
    const buffer = Buffer.from("", "utf-8");
    const result = await parseResumeBuffer(buffer, "empty.txt");
    expect(result.format).toBe("txt");
    expect(result.rawText).toBe("");
  });

  it("preserves line breaks in text files", async () => {
    const text = "Line 1\nLine 2\nLine 3";
    const buffer = Buffer.from(text, "utf-8");
    const result = await parseResumeBuffer(buffer, "resume.txt");
    expect(result.rawText).toContain("Line 1\nLine 2\nLine 3");
  });
});

/* ═══════════════════════════════════════════════════════════════════
   3. Integration-style schema round-trip test
   ═══════════════════════════════════════════════════════════════════ */

describe("schema round-trip", () => {
  it("parsed inventory matches re-serialized inventory", () => {
    const inventory = {
      profile: {
        name: "Test User",
        current_title: "Engineer",
        email: "test@test.com",
        phone: "555-0000",
        location: "Remote",
        linkedin: "linkedin.com/in/test",
        summary: "A test profile.",
      },
      experience: [
        {
          id: "exp-001",
          employer: "TestCo",
          title: "Engineer",
          start_date: "2022-01",
          end_date: "present",
          location: "Remote",
          bullets: [
            {
              id: "exp-001-b1",
              text: "Built things",
              metrics: ["10x improvement"],
              tools: ["TypeScript"],
            },
          ],
        },
      ],
      education: [
        {
          id: "edu-001",
          institution: "Test University",
          degree: "BS",
          year: "2020",
        },
      ],
      skills: {
        leadership: [],
        technical: ["TypeScript"],
        data_science: [],
        domains: [],
      },
      certifications: [],
    };

    const parsed = ExperienceInventorySchema.parse(inventory);
    const reserialized = JSON.parse(JSON.stringify(parsed));
    const reparsed = ExperienceInventorySchema.parse(reserialized);

    expect(reparsed.profile.name).toBe("Test User");
    expect(reparsed.experience[0].bullets[0].metrics).toEqual(["10x improvement"]);
  });
});
