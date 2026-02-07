import { describe, it, expect } from "vitest";
import {
  buildEvidenceSummary,
  extractAllBulletIds,
  validateMessages,
  extractRequirementTexts,
  hookMatchesRequirements,
  type LinkedInMessages,
} from "../src/mastra/tools/linkedInMessageTool";
import type { ExperienceInventory } from "../src/mastra/tools/matchScorer";

const mockInventory: ExperienceInventory = {
  profile: {
    name: "Jane Doe",
    current_title: "Senior Data Engineer",
    location: "Chicago, IL",
    summary: "Experienced data leader with 10+ years in analytics and engineering.",
  },
  experience: [
    {
      id: "exp-001",
      employer: "Acme Financial Group",
      title: "Director of Data Engineering",
      start_date: "2020-01",
      end_date: "present",
      location: "Chicago, IL",
      bullets: [
        {
          id: "exp-001-b1",
          text: "Led a team of 12 data engineers building real-time pipelines processing 2B events/day",
          metrics: ["12 engineers", "2B events/day"],
          tools: ["Kafka", "Spark", "Airflow"],
        },
        {
          id: "exp-001-b2",
          text: "Reduced data processing costs by 40% through migration to cloud-native architecture",
          metrics: ["40% cost reduction"],
          tools: ["AWS", "Snowflake", "dbt"],
        },
        {
          id: "exp-001-b3",
          text: "Designed ML feature store serving 50+ models in production",
          metrics: ["50+ models"],
          tools: ["Feature Store", "Python", "TensorFlow"],
        },
      ],
    },
    {
      id: "exp-002",
      employer: "Beta Analytics Inc",
      title: "Senior Data Analyst",
      start_date: "2016-06",
      end_date: "2019-12",
      location: "New York, NY",
      bullets: [
        {
          id: "exp-002-b1",
          text: "Built executive dashboards used by C-suite to drive $50M in strategic decisions",
          metrics: ["$50M decisions"],
          tools: ["Tableau", "SQL", "Python"],
        },
        {
          id: "exp-002-b2",
          text: "Implemented automated anomaly detection reducing incident response time by 60%",
          metrics: ["60% reduction"],
          tools: ["Python", "scikit-learn"],
        },
      ],
    },
  ],
  education: [
    {
      id: "edu-001",
      institution: "MIT",
      degree: "MS Computer Science",
      year: "2016",
    },
  ],
  skills: {
    technical: ["Python", "SQL", "Kafka", "Spark", "AWS", "Snowflake"],
    leadership: ["Team Building", "Roadmap Planning", "Stakeholder Management"],
    data_science: ["Machine Learning", "Feature Engineering"],
    domains: ["Financial Services", "Healthcare"],
  },
  certifications: [
    {
      id: "cert-001",
      name: "AWS Solutions Architect Professional",
      year: "2022",
    },
  ],
};

describe("buildEvidenceSummary", () => {
  it("includes candidate profile info", () => {
    const summary = buildEvidenceSummary(mockInventory);
    expect(summary).toContain("Jane Doe");
    expect(summary).toContain("Senior Data Engineer");
  });

  it("includes experience entries with bullet IDs", () => {
    const summary = buildEvidenceSummary(mockInventory);
    expect(summary).toContain("[exp-001-b1]");
    expect(summary).toContain("[exp-001-b2]");
    expect(summary).toContain("[exp-002-b1]");
    expect(summary).toContain("Acme Financial Group");
    expect(summary).toContain("Beta Analytics Inc");
  });

  it("includes metrics and tools tags", () => {
    const summary = buildEvidenceSummary(mockInventory);
    expect(summary).toContain("[metrics: 12 engineers, 2B events/day]");
    expect(summary).toContain("[tools: Kafka, Spark, Airflow]");
  });

  it("includes skills sections", () => {
    const summary = buildEvidenceSummary(mockInventory);
    expect(summary).toContain("Technical: Python, SQL, Kafka");
    expect(summary).toContain("Leadership: Team Building");
    expect(summary).toContain("Data Science: Machine Learning");
    expect(summary).toContain("Domains: Financial Services");
  });

  it("includes education with IDs", () => {
    const summary = buildEvidenceSummary(mockInventory);
    expect(summary).toContain("[edu-001]");
    expect(summary).toContain("MS Computer Science");
    expect(summary).toContain("MIT");
  });

  it("includes certifications with IDs", () => {
    const summary = buildEvidenceSummary(mockInventory);
    expect(summary).toContain("[cert-001]");
    expect(summary).toContain("AWS Solutions Architect Professional");
  });
});

describe("extractAllBulletIds", () => {
  it("extracts all experience bullet IDs", () => {
    const ids = extractAllBulletIds(mockInventory);
    expect(ids.has("exp-001-b1")).toBe(true);
    expect(ids.has("exp-001-b2")).toBe(true);
    expect(ids.has("exp-001-b3")).toBe(true);
    expect(ids.has("exp-002-b1")).toBe(true);
    expect(ids.has("exp-002-b2")).toBe(true);
  });

  it("extracts education IDs", () => {
    const ids = extractAllBulletIds(mockInventory);
    expect(ids.has("edu-001")).toBe(true);
  });

  it("extracts certification IDs", () => {
    const ids = extractAllBulletIds(mockInventory);
    expect(ids.has("cert-001")).toBe(true);
  });

  it("returns correct total count", () => {
    const ids = extractAllBulletIds(mockInventory);
    expect(ids.size).toBe(7);
  });

  it("handles empty arrays gracefully", () => {
    const emptyInventory: ExperienceInventory = {
      profile: { name: "", current_title: "", location: "", summary: "" },
      experience: [],
      education: [],
      skills: { technical: [], leadership: [], data_science: [], domains: [] },
      certifications: [],
    };
    const ids = extractAllBulletIds(emptyInventory);
    expect(ids.size).toBe(0);
  });
});

describe("validateMessages", () => {
  const validIds = extractAllBulletIds(mockInventory);

  function makeValidMessages(overrides?: Partial<any>): LinkedInMessages {
    return {
      warm_message: {
        text: "Hi — I noticed your team is scaling data infrastructure. I led a 12-engineer team building real-time pipelines at Acme Financial. Would love to chat about the role!",
        char_count: 164,
        hook_used: "data infrastructure scaling",
        evidence_pointers: [
          {
            source_hash: "exp-001-b1",
            evidence_quote:
              "Led a team of 12 data engineers building real-time pipelines processing 2B events/day",
            confidence: 0.95,
          },
        ],
      },
      cold_message: {
        text: "Hi — your team's cloud migration initiative caught my eye. At Acme Financial, I reduced data processing costs by 40% through a similar cloud-native shift. Happy to share insights over a brief call.",
        char_count: 197,
        hook_used: "cloud migration",
        evidence_pointers: [
          {
            source_hash: "exp-001-b2",
            evidence_quote:
              "Reduced data processing costs by 40% through migration to cloud-native architecture",
            confidence: 0.9,
          },
        ],
      },
      job_context: {
        job_id: 1,
        company: "TechCo",
        title: "VP Data Engineering",
      },
      validation: {
        warm_under_limit: true,
        cold_under_limit: true,
        all_pointers_valid: true,
        hooks_from_jd: true,
      },
      ...overrides,
    };
  }

  it("passes valid messages", () => {
    const result = validateMessages(makeValidMessages(), validIds);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags warm message over 450 chars", () => {
    const msgs = makeValidMessages({
      warm_message: {
        text: "x".repeat(451),
        char_count: 451,
        hook_used: "test",
        evidence_pointers: [
          { source_hash: "exp-001-b1", evidence_quote: "test", confidence: 0.9 },
        ],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Warm message exceeds 450"))).toBe(true);
  });

  it("flags cold message over 450 chars", () => {
    const msgs = makeValidMessages({
      cold_message: {
        text: "x".repeat(460),
        char_count: 460,
        hook_used: "test",
        evidence_pointers: [
          { source_hash: "exp-001-b2", evidence_quote: "test", confidence: 0.9 },
        ],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Cold message exceeds 450"))).toBe(true);
  });

  it("flags invalid source_hash in warm message", () => {
    const msgs = makeValidMessages({
      warm_message: {
        text: "Short message",
        char_count: 13,
        hook_used: "test",
        evidence_pointers: [
          {
            source_hash: "exp-999-b1",
            evidence_quote: "test",
            confidence: 0.9,
          },
        ],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.includes('invalid source_hash "exp-999-b1"')),
    ).toBe(true);
  });

  it("flags invalid source_hash in cold message", () => {
    const msgs = makeValidMessages({
      cold_message: {
        text: "Short message",
        char_count: 13,
        hook_used: "test",
        evidence_pointers: [
          {
            source_hash: "fake-id",
            evidence_quote: "test",
            confidence: 0.9,
          },
        ],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.includes('invalid source_hash "fake-id"')),
    ).toBe(true);
  });

  it("flags low confidence pointers", () => {
    const msgs = makeValidMessages({
      warm_message: {
        text: "Short message",
        char_count: 13,
        hook_used: "test",
        evidence_pointers: [
          {
            source_hash: "exp-001-b1",
            evidence_quote: "test",
            confidence: 0.5,
          },
        ],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("low confidence"))).toBe(true);
  });

  it("flags empty evidence pointers", () => {
    const msgs = makeValidMessages({
      warm_message: {
        text: "Short message",
        char_count: 13,
        hook_used: "test",
        evidence_pointers: [],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.includes("Warm message has no evidence")),
    ).toBe(true);
  });

  it("flags both messages if both have no evidence", () => {
    const msgs = makeValidMessages({
      warm_message: {
        text: "Hello",
        char_count: 5,
        hook_used: "test",
        evidence_pointers: [],
      },
      cold_message: {
        text: "Hello",
        char_count: 5,
        hook_used: "test",
        evidence_pointers: [],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts education and certification IDs as valid", () => {
    const msgs = makeValidMessages({
      warm_message: {
        text: "Short message with education reference",
        char_count: 38,
        hook_used: "education background",
        evidence_pointers: [
          {
            source_hash: "edu-001",
            evidence_quote: "MS Computer Science, MIT",
            confidence: 0.9,
          },
        ],
      },
      cold_message: {
        text: "Short message with certification reference",
        char_count: 42,
        hook_used: "cloud certification",
        evidence_pointers: [
          {
            source_hash: "cert-001",
            evidence_quote: "AWS Solutions Architect Professional",
            confidence: 0.85,
          },
        ],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("accumulates multiple issues", () => {
    const msgs = makeValidMessages({
      warm_message: {
        text: "x".repeat(500),
        char_count: 500,
        hook_used: "test",
        evidence_pointers: [
          { source_hash: "invalid-id", evidence_quote: "test", confidence: 0.3 },
        ],
      },
      cold_message: {
        text: "x".repeat(500),
        char_count: 500,
        hook_used: "test",
        evidence_pointers: [],
      },
    });
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe("edge cases", () => {
  it("extractAllBulletIds handles missing education/certs", () => {
    const inv: ExperienceInventory = {
      profile: { name: "A", current_title: "B", location: "C", summary: "D" },
      experience: [
        {
          id: "exp-001",
          employer: "Test",
          title: "Dev",
          start_date: "2020",
          end_date: "2021",
          location: "Remote",
          bullets: [{ id: "exp-001-b1", text: "Did stuff" }],
        },
      ],
      education: [],
      skills: { technical: [], leadership: [], data_science: [], domains: [] },
      certifications: [],
    };
    const ids = extractAllBulletIds(inv);
    expect(ids.size).toBe(1);
    expect(ids.has("exp-001-b1")).toBe(true);
  });

  it("buildEvidenceSummary handles empty skills", () => {
    const inv: ExperienceInventory = {
      profile: { name: "A", current_title: "B", location: "C", summary: "D" },
      experience: [],
      education: [],
      skills: { technical: [], leadership: [], data_science: [], domains: [] },
      certifications: [],
    };
    const summary = buildEvidenceSummary(inv);
    expect(summary).toContain("CANDIDATE PROFILE");
    expect(summary).not.toContain("Technical:");
  });

  it("buildEvidenceSummary handles bullets without metrics/tools", () => {
    const inv: ExperienceInventory = {
      profile: { name: "A", current_title: "B", location: "C", summary: "D" },
      experience: [
        {
          id: "exp-001",
          employer: "Test Corp",
          title: "Engineer",
          start_date: "2020",
          end_date: "2021",
          location: "Remote",
          bullets: [{ id: "exp-001-b1", text: "Wrote code" }],
        },
      ],
      education: [],
      skills: { technical: [], leadership: [], data_science: [], domains: [] },
      certifications: [],
    };
    const summary = buildEvidenceSummary(inv);
    expect(summary).toContain("[exp-001-b1] Wrote code");
    expect(summary).not.toContain("[metrics:");
    expect(summary).not.toContain("[tools:");
  });

  it("validateMessages accepts exactly 450 chars", () => {
    const ids = extractAllBulletIds(mockInventory);
    const msgs: LinkedInMessages = {
      warm_message: {
        text: "x".repeat(450),
        char_count: 450,
        hook_used: "data infrastructure",
        evidence_pointers: [
          { source_hash: "exp-001-b1", evidence_quote: "test", confidence: 0.9 },
        ],
      },
      cold_message: {
        text: "y".repeat(450),
        char_count: 450,
        hook_used: "cloud migration",
        evidence_pointers: [
          { source_hash: "exp-001-b2", evidence_quote: "test", confidence: 0.8 },
        ],
      },
      job_context: { job_id: 1, company: "Test", title: "Dev" },
      validation: {
        warm_under_limit: true,
        cold_under_limit: true,
        all_pointers_valid: true,
        hooks_from_jd: true,
      },
    };
    const result = validateMessages(msgs, ids);
    expect(result.valid).toBe(true);
  });
});

const mockRequirements = {
  must_have: [
    { text: "10+ years of data engineering experience", confidence: 1.0 },
    { text: "Experience with cloud migration projects", confidence: 0.9 },
  ],
  nice_to_have: [
    { text: "Familiarity with real-time streaming architectures", confidence: 0.8 },
  ],
  tech_keywords: [
    { text: "Kafka", confidence: 1.0 },
    { text: "Snowflake", confidence: 1.0 },
    { text: "Airflow", confidence: 0.9 },
  ],
  leadership_scope: [
    { text: "Manage a team of 8-15 engineers", confidence: 0.9 },
  ],
  domain_context: [
    { text: "Financial services industry", confidence: 1.0 },
  ],
};

describe("extractRequirementTexts", () => {
  it("extracts all requirement texts", () => {
    const texts = extractRequirementTexts(mockRequirements);
    expect(texts.has("10+ years of data engineering experience")).toBe(true);
    expect(texts.has("kafka")).toBe(true);
    expect(texts.has("snowflake")).toBe(true);
    expect(texts.has("financial services industry")).toBe(true);
  });

  it("lowercases all texts", () => {
    const texts = extractRequirementTexts(mockRequirements);
    for (const t of texts) {
      expect(t).toBe(t.toLowerCase());
    }
  });

  it("handles string items", () => {
    const reqs = { must_have: ["Python", "SQL"] };
    const texts = extractRequirementTexts(reqs);
    expect(texts.has("python")).toBe(true);
    expect(texts.has("sql")).toBe(true);
  });

  it("handles empty requirements", () => {
    const texts = extractRequirementTexts({});
    expect(texts.size).toBe(0);
  });

  it("ignores unknown keys", () => {
    const reqs = { random_key: [{ text: "test", confidence: 1 }] };
    const texts = extractRequirementTexts(reqs);
    expect(texts.size).toBe(0);
  });
});

describe("hookMatchesRequirements", () => {
  const reqTexts = extractRequirementTexts(mockRequirements);

  it("matches exact requirement text", () => {
    expect(hookMatchesRequirements("Kafka", reqTexts)).toBe(true);
  });

  it("matches partial requirement text", () => {
    expect(hookMatchesRequirements("cloud migration", reqTexts)).toBe(true);
  });

  it("matches when hook is substring of requirement", () => {
    expect(hookMatchesRequirements("data engineering", reqTexts)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hookMatchesRequirements("KAFKA", reqTexts)).toBe(true);
    expect(hookMatchesRequirements("snowflake", reqTexts)).toBe(true);
  });

  it("rejects unrelated hooks", () => {
    expect(hookMatchesRequirements("blockchain development", reqTexts)).toBe(false);
  });

  it("rejects empty hooks", () => {
    expect(hookMatchesRequirements("", reqTexts)).toBe(false);
  });

  it("matches word overlap (50%+ threshold)", () => {
    expect(hookMatchesRequirements("data engineering experience", reqTexts)).toBe(true);
  });
});

describe("validateMessages with requirements", () => {
  const validIds = extractAllBulletIds(mockInventory);

  function makeValidMsgsWithHooks(
    warmHook: string,
    coldHook: string,
  ): LinkedInMessages {
    return {
      warm_message: {
        text: "Short warm message about the role",
        char_count: 33,
        hook_used: warmHook,
        evidence_pointers: [
          { source_hash: "exp-001-b1", evidence_quote: "test", confidence: 0.9 },
        ],
      },
      cold_message: {
        text: "Short cold message about the role",
        char_count: 33,

        hook_used: coldHook,
        evidence_pointers: [
          { source_hash: "exp-001-b2", evidence_quote: "test", confidence: 0.9 },
        ],
      },
      job_context: { job_id: 1, company: "Test", title: "Dev" },
      validation: {
        warm_under_limit: true,
        cold_under_limit: true,
        all_pointers_valid: true,
        hooks_from_jd: true,
      },
    };
  }

  it("passes when hooks are different and from JD", () => {
    const msgs = makeValidMsgsWithHooks("Kafka", "cloud migration");
    const result = validateMessages(msgs, validIds, mockRequirements);
    expect(result.valid).toBe(true);
  });

  it("flags same hooks for warm and cold", () => {
    const msgs = makeValidMsgsWithHooks("Kafka", "Kafka");
    const result = validateMessages(msgs, validIds, mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("same hook"))).toBe(true);
  });

  it("flags hook not matching any requirement", () => {
    const msgs = makeValidMsgsWithHooks("blockchain", "quantum computing");
    const result = validateMessages(msgs, validIds, mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("does not match any JD requirement"))).toBe(true);
  });

  it("flags only the non-matching hook", () => {
    const msgs = makeValidMsgsWithHooks("Kafka", "quantum computing");
    const result = validateMessages(msgs, validIds, mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Cold message hook"))).toBe(true);
    expect(result.issues.some((i) => i.includes("Warm message hook"))).toBe(false);
  });

  it("skips hook validation when no requirements provided", () => {
    const msgs = makeValidMsgsWithHooks("anything", "something else");
    const result = validateMessages(msgs, validIds);
    expect(result.valid).toBe(true);
  });

  it("flags char_count mismatch", () => {
    const msgs = makeValidMsgsWithHooks("Kafka", "Snowflake");
    msgs.warm_message.char_count = 999;
    const result = validateMessages(msgs, validIds, mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("char_count mismatch"))).toBe(true);
  });
});
