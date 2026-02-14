import { describe, it, expect } from "vitest";
import {
  TailoredResumeSchema,
  EvidencePointerSchema,
  GapNoteSchema,
  ResumeBulletSchema,
  buildResumeSystemPrompt,
  buildResumeUserPrompt,
} from "../src/mastra/tools/tailoredResumePrompt";
import {
  TailoredCoverLetterSchema,
  ValueClaimSchema,
  buildCoverLetterSystemPrompt,
  buildCoverLetterUserPrompt,
} from "../src/mastra/tools/tailoredCoverLetterPrompt";

const MOCK_INVENTORY = {
  profile: {
    name: "Ed Martinez",
    current_title: "VP of Data & Analytics",
    location: "Chicago, IL",
    summary: "Data exec with 15+ years leading enterprise data transformations.",
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
  ],
  education: [
    { id: "edu-001", institution: "University of Chicago", degree: "MBA", year: "2010" },
  ],
  skills: {
    leadership: ["Executive stakeholder management"],
    technical: ["Python", "SQL", "Snowflake"],
    data_science: ["Machine Learning"],
    domains: ["Financial Services"],
  },
  certifications: [{ id: "cert-001", name: "AWS Certified Solutions Architect", year: "2020" }],
};

const MOCK_ALLOWLIST = {
  companies: [{ value: "Acme Financial Group", normalized: "acme financial group" }],
  titles: [{ value: "VP of Data & Analytics", normalized: "vp of data & analytics" }],
  dates: [{ value: "2021-03", normalized: "2021-03" }],
  locations: [{ value: "Chicago, IL (Hybrid)", normalized: "chicago, il (hybrid)" }],
  degrees: [{ value: "MBA", normalized: "mba" }],
  certifications: [{ value: "AWS Certified Solutions Architect", normalized: "aws certified solutions architect" }],
  tools: [{ value: "Python", normalized: "python" }, { value: "Snowflake", normalized: "snowflake" }],
  metrics: [{ value: "$12M annual cost savings", normalized: "$12m annual cost savings", number: "12", unit: "$M", raw: "$12M annual cost savings" }],
  skills: [{ value: "Machine Learning", normalized: "machine learning" }],
};

const MOCK_REQUIREMENTS = {
  must_have: [
    { text: "10+ years of data analytics leadership", confidence: 1.0 },
    { text: "Experience with Snowflake and dbt", confidence: 0.9 },
  ],
  nice_to_have: [
    { text: "MBA preferred", confidence: 0.8 },
  ],
  leadership_scope: [
    { text: "Lead team of 20+", confidence: 0.9 },
  ],
  domain_context: [
    { text: "Financial Services", confidence: 0.9 },
  ],
  tech_keywords: [
    { text: "Python", confidence: 1.0 },
    { text: "Snowflake", confidence: 1.0 },
  ],
  keywords_for_ats: [
    { text: "data governance", confidence: 1.0 },
    { text: "machine learning", confidence: 0.9 },
  ],
  red_flags: [],
};

describe("TailoredResume Schema", () => {
  describe("EvidencePointerSchema", () => {
    it("validates a correct evidence pointer", () => {
      const pointer = {
        claim_text: "Led a 45-person data organization",
        source_hash: "exp-001-b1",
        evidence_quote: "Led a 45-person data organization spanning analytics engineering",
        confidence: 0.95,
      };
      const result = EvidencePointerSchema.safeParse(pointer);
      expect(result.success).toBe(true);
    });

    it("rejects missing source_hash", () => {
      const pointer = {
        claim_text: "Led a team",
        evidence_quote: "Led a 45-person data organization",
        confidence: 0.9,
      };
      const result = EvidencePointerSchema.safeParse(pointer);
      expect(result.success).toBe(false);
    });

    it("rejects confidence > 1.0", () => {
      const pointer = {
        claim_text: "Led a team",
        source_hash: "exp-001-b1",
        evidence_quote: "Led a 45-person data organization",
        confidence: 1.5,
      };
      const result = EvidencePointerSchema.safeParse(pointer);
      expect(result.success).toBe(false);
    });

    it("rejects confidence < 0", () => {
      const pointer = {
        claim_text: "Led a team",
        source_hash: "exp-001-b1",
        evidence_quote: "Led a 45-person data organization",
        confidence: -0.1,
      };
      const result = EvidencePointerSchema.safeParse(pointer);
      expect(result.success).toBe(false);
    });
  });

  describe("GapNoteSchema", () => {
    it("validates a gap note with closest_match", () => {
      const gap = {
        requirement_text: "5 years blockchain development",
        reason: "No matching experience in inventory",
        closest_match: "exp-001-b3",
      };
      const result = GapNoteSchema.safeParse(gap);
      expect(result.success).toBe(true);
    });

    it("validates a gap note without closest_match", () => {
      const gap = {
        requirement_text: "PhD in quantum computing",
        reason: "No matching education in inventory",
      };
      const result = GapNoteSchema.safeParse(gap);
      expect(result.success).toBe(true);
    });

    it("rejects gap note without reason", () => {
      const gap = {
        requirement_text: "Some requirement",
      };
      const result = GapNoteSchema.safeParse(gap);
      expect(result.success).toBe(false);
    });
  });

  describe("ResumeBulletSchema", () => {
    it("validates a bullet with source_hash and evidence_quote", () => {
      const bullet = {
        text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        source_hash: "exp-001-b2",
        evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        claim_ids: ["claim-exp001-b2-metric-12M", "claim-exp001-b2-tool-snowflake"],
      };
      const result = ResumeBulletSchema.safeParse(bullet);
      expect(result.success).toBe(true);
    });

    it("rejects bullet without source_hash", () => {
      const bullet = {
        text: "Some achievement",
        evidence_quote: "Some quote",
      };
      const result = ResumeBulletSchema.safeParse(bullet);
      expect(result.success).toBe(false);
    });
  });

  describe("TailoredResumeSchema", () => {
    it("validates a complete tailored resume", () => {
      const resume = {
        target_role: "VP of Data",
        target_company: "TechCorp",
        professional_summary: "Data executive with 15+ years of experience. Led enterprise transformations. Proven track record in financial services.",
        experience: [
          {
            employer: "Acme Financial Group",
            title: "VP of Data & Analytics",
            start_date: "2021-03",
            end_date: "present",
            location: "Chicago, IL (Hybrid)",
            bullets: [
              {
                text: "Led a 45-person data organization spanning analytics engineering",
                source_hash: "exp-001-b1",
                evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
                claim_ids: ["claim-exp001-b1-team-45"],
              },
            ],
          },
        ],
        skills: {
          technical: ["Python", "Snowflake"],
          leadership: ["Executive stakeholder management"],
        },
        education: [
          { institution: "University of Chicago", degree: "MBA", year: "2010" },
        ],
        certifications: [{ name: "AWS Certified Solutions Architect", year: "2020" }],
        evidence_pointers: [
          {
            claim_text: "Led a 45-person data organization spanning analytics engineering",
            source_hash: "exp-001-b1",
            evidence_quote: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
            confidence: 0.95,
          },
        ],
        gap_notes: [],
        ats_keywords_used: ["data governance", "machine learning"],
      };
      const result = TailoredResumeSchema.safeParse(resume);
      expect(result.success).toBe(true);
    });

    it("rejects resume with no experience entries", () => {
      const resume = {
        target_role: "VP",
        target_company: "Corp",
        professional_summary: "Summary text here.",
        experience: [],
        skills: { technical: [], leadership: [] },
        education: [],
        evidence_pointers: [],
        gap_notes: [],
        ats_keywords_used: [],
      };
      const result = TailoredResumeSchema.safeParse(resume);
      expect(result.success).toBe(false);
    });

    it("rejects experience entry with more than 8 bullets", () => {
      const bullets = Array.from({ length: 9 }, (_, i) => ({
        text: `Bullet ${i}`,
        source_hash: `exp-001-b${i}`,
        evidence_quote: `Quote ${i}`,
      }));
      const resume = {
        target_role: "VP",
        target_company: "Corp",
        professional_summary: "Summary.",
        experience: [
          {
            employer: "Company",
            title: "Title",
            start_date: "2020-01",
            end_date: "present",
            location: "City",
            bullets,
          },
        ],
        skills: { technical: [], leadership: [] },
        education: [],
        evidence_pointers: [],
        gap_notes: [],
        ats_keywords_used: [],
      };
      const result = TailoredResumeSchema.safeParse(resume);
      expect(result.success).toBe(false);
    });

    it("rejects experience entry with no bullets", () => {
      const resume = {
        target_role: "VP",
        target_company: "Corp",
        professional_summary: "Summary.",
        experience: [
          {
            employer: "Company",
            title: "Title",
            start_date: "2020-01",
            end_date: "present",
            location: "City",
            bullets: [],
          },
        ],
        skills: { technical: [], leadership: [] },
        education: [],
        evidence_pointers: [],
        gap_notes: [],
        ats_keywords_used: [],
      };
      const result = TailoredResumeSchema.safeParse(resume);
      expect(result.success).toBe(false);
    });
  });
});

describe("TailoredCoverLetter Schema", () => {
  describe("ValueClaimSchema", () => {
    it("validates a value claim with metric", () => {
      const claim = {
        claim_sentence: "At Acme Financial Group, I drove $12M in annual cost savings by architecting a unified Snowflake platform.",
        source_hash: "exp-001-b2",
        evidence_quote: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
        metric_used: "$12M",
      };
      const result = ValueClaimSchema.safeParse(claim);
      expect(result.success).toBe(true);
    });

    it("validates a value claim without metric", () => {
      const claim = {
        claim_sentence: "I led a data organization spanning engineering and science.",
        source_hash: "exp-001-b1",
        evidence_quote: "Led a 45-person data organization spanning analytics engineering",
      };
      const result = ValueClaimSchema.safeParse(claim);
      expect(result.success).toBe(true);
    });

    it("rejects claim without source_hash", () => {
      const claim = {
        claim_sentence: "I did great things.",
        evidence_quote: "Some quote",
      };
      const result = ValueClaimSchema.safeParse(claim);
      expect(result.success).toBe(false);
    });
  });

  describe("TailoredCoverLetterSchema", () => {
    it("validates a complete cover letter", () => {
      const letter = {
        target_role: "VP of Data",
        target_company: "TechCorp",
        salutation: "Dear Hiring Manager,",
        opening_paragraph: "I am writing to express my interest in the VP of Data position at TechCorp. My background in leading enterprise data transformations aligns closely with your requirements.",
        body_paragraphs: [
          "In my current role at Acme Financial Group, I drove $12M in annual cost savings by architecting a unified data platform on Snowflake. This experience directly applies to your need for data infrastructure leadership.",
        ],
        closing_paragraph: "I welcome the opportunity to discuss how my experience can contribute to TechCorp's data strategy. Thank you for your consideration.",
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
        company_research_todo: ["Research TechCorp's current data infrastructure", "Identify recent product launches"],
        word_count: 280,
      };
      const result = TailoredCoverLetterSchema.safeParse(letter);
      expect(result.success).toBe(true);
    });

    it("rejects cover letter with more than 3 value claims", () => {
      const claims = Array.from({ length: 4 }, (_, i) => ({
        claim_sentence: `Claim ${i}`,
        source_hash: `exp-001-b${i}`,
        evidence_quote: `Quote ${i}`,
      }));
      const letter = {
        target_role: "VP",
        target_company: "Corp",
        salutation: "Dear Hiring Manager,",
        opening_paragraph: "Opening.",
        body_paragraphs: ["Body text."],
        closing_paragraph: "Closing.",
        sign_off: "Sincerely, Ed",
        value_claims: claims,
        evidence_pointers: [],
        gap_notes: [],
        company_research_todo: [],
        word_count: 100,
      };
      const result = TailoredCoverLetterSchema.safeParse(letter);
      expect(result.success).toBe(false);
    });

    it("rejects cover letter with no value claims", () => {
      const letter = {
        target_role: "VP",
        target_company: "Corp",
        salutation: "Dear Hiring Manager,",
        opening_paragraph: "Opening.",
        body_paragraphs: ["Body text."],
        closing_paragraph: "Closing.",
        sign_off: "Sincerely, Ed",
        value_claims: [],
        evidence_pointers: [],
        gap_notes: [],
        company_research_todo: [],
        word_count: 100,
      };
      const result = TailoredCoverLetterSchema.safeParse(letter);
      expect(result.success).toBe(false);
    });

    it("rejects cover letter with more than 3 body paragraphs", () => {
      const letter = {
        target_role: "VP",
        target_company: "Corp",
        salutation: "Dear Hiring Manager,",
        opening_paragraph: "Opening.",
        body_paragraphs: ["P1", "P2", "P3", "P4"],
        closing_paragraph: "Closing.",
        sign_off: "Sincerely, Ed",
        value_claims: [{ claim_sentence: "C", source_hash: "x", evidence_quote: "Q" }],
        evidence_pointers: [],
        gap_notes: [],
        company_research_todo: [],
        word_count: 100,
      };
      const result = TailoredCoverLetterSchema.safeParse(letter);
      expect(result.success).toBe(false);
    });
  });
});

describe("Resume Prompt Builders", () => {
  describe("buildResumeSystemPrompt", () => {
    it("contains all required rules", () => {
      const prompt = buildResumeSystemPrompt();
      expect(prompt).toContain("ENTITY ALLOWLIST");
      expect(prompt).toContain("EVIDENCE ON EVERY BULLET");
      expect(prompt).toContain("REJECT, DON'T FABRICATE");
      expect(prompt).toContain("NUMBERS ARE SACRED");
      expect(prompt).toContain("ATS-FRIENDLY");
      expect(prompt).toContain("gap_note");
      expect(prompt).toContain("source_hash");
      expect(prompt).toContain("evidence_quote");
    });

    it("forbids tables and columns", () => {
      const prompt = buildResumeSystemPrompt();
      expect(prompt).toContain("No tables");
      expect(prompt).toContain("no columns");
    });

    it("requires JSON-only output", () => {
      const prompt = buildResumeSystemPrompt();
      expect(prompt).toContain("ONLY the JSON object");
      expect(prompt).toContain("No markdown fences");
    });
  });

  describe("buildResumeUserPrompt", () => {
    it("includes all required sections", () => {
      const prompt = buildResumeUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
      );
      expect(prompt).toContain("TARGET ROLE");
      expect(prompt).toContain("VP of Data");
      expect(prompt).toContain("TechCorp");
      expect(prompt).toContain("JOB REQUIREMENTS");
      expect(prompt).toContain("EXPERIENCE INVENTORY");
      expect(prompt).toContain("ENTITY ALLOWLIST");
      expect(prompt).toContain("gap_note");
    });

    it("embeds the full inventory JSON", () => {
      const prompt = buildResumeUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
      );
      expect(prompt).toContain("Acme Financial Group");
      expect(prompt).toContain("exp-001-b1");
      expect(prompt).toContain("$12M annual cost savings");
    });

    it("embeds the allowlist", () => {
      const prompt = buildResumeUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
      );
      expect(prompt).toContain("acme financial group");
      expect(prompt).toContain("python");
      expect(prompt).toContain("snowflake");
    });

    it("embeds the requirements", () => {
      const prompt = buildResumeUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
      );
      expect(prompt).toContain("10+ years of data analytics leadership");
      expect(prompt).toContain("data governance");
    });
  });
});

describe("Cover Letter Prompt Builders", () => {
  describe("buildCoverLetterSystemPrompt", () => {
    it("contains all required rules", () => {
      const prompt = buildCoverLetterSystemPrompt();
      expect(prompt).toContain("ENTITY ALLOWLIST");
      expect(prompt).toContain("1-3 VALUE CLAIMS");
      expect(prompt).toContain("NEVER INVENT METRICS");
      expect(prompt).toContain("REJECT, DON'T FABRICATE");
      expect(prompt).toContain("COMPANY RESEARCH TODO");
      expect(prompt).toContain("250-350");
      expect(prompt).toContain("EXECUTIVE TONE");
      expect(prompt).toContain("source_hash");
      expect(prompt).toContain("evidence_quote");
    });

    it("specifies word count constraint", () => {
      const prompt = buildCoverLetterSystemPrompt();
      expect(prompt).toContain("WORD COUNT: 250-350");
      expect(prompt).toContain("word_count");
    });

    it("forbids clichés", () => {
      const prompt = buildCoverLetterSystemPrompt();
      expect(prompt).toContain("passionate");
      expect(prompt).toContain("synergy");
    });

    it("requires JSON-only output", () => {
      const prompt = buildCoverLetterSystemPrompt();
      expect(prompt).toContain("ONLY the JSON object");
    });
  });

  describe("buildCoverLetterUserPrompt", () => {
    it("includes all required sections", () => {
      const prompt = buildCoverLetterUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
      );
      expect(prompt).toContain("TARGET ROLE");
      expect(prompt).toContain("VP of Data");
      expect(prompt).toContain("TechCorp");
      expect(prompt).toContain("JOB REQUIREMENTS");
      expect(prompt).toContain("EXPERIENCE INVENTORY");
      expect(prompt).toContain("ENTITY ALLOWLIST");
    });

    it("includes company_research_todo instruction when no context", () => {
      const prompt = buildCoverLetterUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
      );
      expect(prompt).toContain("company_research_todo");
      expect(prompt).toContain("No company-specific information available");
    });

    it("includes company context when provided", () => {
      const prompt = buildCoverLetterUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
        "TechCorp is a B2B SaaS company focused on financial data analytics. Recently raised Series C funding.",
      );
      expect(prompt).toContain("TechCorp is a B2B SaaS company");
      expect(prompt).toContain("Series C funding");
      expect(prompt).not.toContain("No company-specific information available");
    });

    it("instructs to populate company_research_todo when context missing", () => {
      const prompt = buildCoverLetterUserPrompt(
        MOCK_INVENTORY,
        MOCK_ALLOWLIST,
        MOCK_REQUIREMENTS,
        "VP of Data",
        "TechCorp",
      );
      expect(prompt).toContain("company_research_todo");
    });
  });
});

describe("Schema constraint enforcement", () => {
  it("TailoredResume allows max 7 experience entries", () => {
    // Schema allows max 7 experience entries
    const experiences = Array.from({ length: 8 }, (_, i) => ({
      employer: `Company ${i}`,
      title: `Title ${i}`,
      start_date: "2020-01",
      end_date: "present",
      location: "City",
      bullets: [{ text: `Bullet`, source_hash: `exp-00${i}-b1`, evidence_quote: `Quote` }],
    }));
    const resume = {
      target_role: "VP",
      target_company: "Corp",
      professional_summary: "Summary.",
      experience: experiences,
      skills: { technical: [], leadership: [] },
      education: [],
      evidence_pointers: [],
      gap_notes: [],
      ats_keywords_used: [],
    };
    const result = TailoredResumeSchema.safeParse(resume);
    expect(result.success).toBe(false);
  });

  it("TailoredCoverLetter requires at least 1 body paragraph", () => {
    const letter = {
      target_role: "VP",
      target_company: "Corp",
      salutation: "Dear Hiring Manager,",
      opening_paragraph: "Opening.",
      body_paragraphs: [],
      closing_paragraph: "Closing.",
      sign_off: "Sincerely, Ed",
      value_claims: [{ claim_sentence: "C", source_hash: "x", evidence_quote: "Q" }],
      evidence_pointers: [],
      gap_notes: [],
      company_research_todo: [],
      word_count: 100,
    };
    const result = TailoredCoverLetterSchema.safeParse(letter);
    expect(result.success).toBe(false);
  });
});
