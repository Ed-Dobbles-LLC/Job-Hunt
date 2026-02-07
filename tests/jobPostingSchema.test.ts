import { describe, it, expect } from "vitest";
import {
  normalizeText,
  computeHash,
  computeSimhash,
  hammingDistance,
  isNearDuplicate,
  classifyLevel,
  extractKeywords,
  isNewSinceYesterday,
  getNewSinceYesterdayQuery,
  buildJobPosting,
  JobPostingSchema,
  SAMPLE_JOB_POSTING,
  type JobPosting,
} from "../src/mastra/tools/jobPostingSchema";

describe("JobPostingSchema — Zod validation", () => {
  it("validates the sample job posting", () => {
    const result = JobPostingSchema.safeParse(SAMPLE_JOB_POSTING);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = JobPostingSchema.safeParse({ company: "Test" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid level values", () => {
    const levels = ["IC", "Manager", "Director", "Senior Director", "VP", "SVP", "C-Suite", "Unknown"];
    for (const level of levels) {
      const posting = { ...SAMPLE_JOB_POSTING, level };
      const result = JobPostingSchema.safeParse(posting);
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid level", () => {
    const posting = { ...SAMPLE_JOB_POSTING, level: "Intern" };
    const result = JobPostingSchema.safeParse(posting);
    expect(result.success).toBe(false);
  });

  it("accepts all valid status values", () => {
    const statuses = ["new", "scored", "applied", "dismissed", "expired"];
    for (const status of statuses) {
      const posting = { ...SAMPLE_JOB_POSTING, status };
      const result = JobPostingSchema.safeParse(posting);
      expect(result.success).toBe(true);
    }
  });
});

describe("normalizeText", () => {
  it("lowercases and trims text", () => {
    expect(normalizeText("  Hello World  ")).toBe("hello world");
  });

  it("replaces special chars with spaces", () => {
    expect(normalizeText("VP of Data & Analytics")).toBe("vp of data analytics");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeText("too   many    spaces")).toBe("too many spaces");
  });

  it("handles empty string", () => {
    expect(normalizeText("")).toBe("");
  });
});

describe("computeHash", () => {
  it("returns consistent SHA-256 hex for same input", () => {
    const h1 = computeHash("test input");
    const h2 = computeHash("test input");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  it("returns different hash for different input", () => {
    const h1 = computeHash("input a");
    const h2 = computeHash("input b");
    expect(h1).not.toBe(h2);
  });

  it("normalizes before hashing (case-insensitive)", () => {
    const h1 = computeHash("Hello World");
    const h2 = computeHash("hello world");
    expect(h1).toBe(h2);
  });

  it("normalizes before hashing (special chars)", () => {
    const h1 = computeHash("VP of Data & Analytics");
    const h2 = computeHash("vp of data   analytics");
    expect(h1).toBe(h2);
  });
});

describe("computeSimhash", () => {
  it("returns 16-char hex string", () => {
    const hash = computeSimhash("This is a test job description for a VP of Data Analytics role");
    expect(hash.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it("returns same hash for same input", () => {
    const text = "VP of Data Analytics leadership role managing team of analysts";
    expect(computeSimhash(text)).toBe(computeSimhash(text));
  });

  it("returns zero hash for empty input", () => {
    expect(computeSimhash("")).toBe("0000000000000000");
  });

  it("returns zero hash for stop-words-only input", () => {
    expect(computeSimhash("the and or but")).toBe("0000000000000000");
  });

  it("produces similar hashes for similar text", () => {
    const text1 = "VP of Data Analytics leading a team of 30 data scientists and analysts driving enterprise data strategy at a Fortune 500 company";
    const text2 = "VP of Data Analytics leading a team of 25 data scientists and analysts driving enterprise data strategy at a Fortune 100 company";
    const h1 = computeSimhash(text1);
    const h2 = computeSimhash(text2);
    const dist = hammingDistance(h1, h2);
    expect(dist).toBeLessThan(15);
  });

  it("produces different hashes for very different text", () => {
    const text1 = "VP of Data Analytics leading enterprise data strategy and team management";
    const text2 = "Junior software developer needed for mobile app development using React Native and Swift iOS programming";
    const h1 = computeSimhash(text1);
    const h2 = computeSimhash(text2);
    const dist = hammingDistance(h1, h2);
    expect(dist).toBeGreaterThan(10);
  });
});

describe("hammingDistance", () => {
  it("returns 0 for identical hashes", () => {
    expect(hammingDistance("abcdef1234567890", "abcdef1234567890")).toBe(0);
  });

  it("computes correct distance", () => {
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
  });

  it("returns 64 for maximally different hashes", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });
});

describe("isNearDuplicate", () => {
  it("returns true for identical hashes", () => {
    expect(isNearDuplicate("abcdef1234567890", "abcdef1234567890")).toBe(true);
  });

  it("returns true for distance within threshold", () => {
    expect(isNearDuplicate("0000000000000000", "0000000000000001", 10)).toBe(true);
  });

  it("returns false for distance above threshold", () => {
    expect(isNearDuplicate("0000000000000000", "ffffffffffffffff", 10)).toBe(false);
  });

  it("respects custom threshold", () => {
    const dist = hammingDistance("0000000000000000", "00000000000000ff");
    expect(isNearDuplicate("0000000000000000", "00000000000000ff", dist)).toBe(true);
    expect(isNearDuplicate("0000000000000000", "00000000000000ff", dist - 1)).toBe(false);
  });
});

describe("classifyLevel", () => {
  it("classifies C-Suite titles", () => {
    expect(classifyLevel("Chief Data Officer")).toBe("C-Suite");
    expect(classifyLevel("CDO")).toBe("C-Suite");
    expect(classifyLevel("Chief Data & AI Officer (CDAO)")).toBe("C-Suite");
    expect(classifyLevel("CTO")).toBe("C-Suite");
  });

  it("classifies SVP titles", () => {
    expect(classifyLevel("SVP, Data & AI")).toBe("SVP");
    expect(classifyLevel("Senior Vice President of Analytics")).toBe("SVP");
    expect(classifyLevel("Executive Vice President")).toBe("SVP");
  });

  it("classifies VP titles", () => {
    expect(classifyLevel("VP of Data & Analytics")).toBe("VP");
    expect(classifyLevel("Vice President, Analytics")).toBe("VP");
    expect(classifyLevel("VP Analytics")).toBe("VP");
  });

  it("classifies Senior Director titles", () => {
    expect(classifyLevel("Senior Director of Data Science")).toBe("Senior Director");
    expect(classifyLevel("Sr. Director, Analytics")).toBe("Senior Director");
  });

  it("classifies Director titles", () => {
    expect(classifyLevel("Director of Analytics")).toBe("Director");
    expect(classifyLevel("Head of Data Science")).toBe("Director");
  });

  it("classifies Manager titles", () => {
    expect(classifyLevel("Analytics Manager")).toBe("Manager");
    expect(classifyLevel("Data Science Lead")).toBe("Manager");
  });

  it("classifies IC titles", () => {
    expect(classifyLevel("Senior Data Scientist")).toBe("IC");
    expect(classifyLevel("Staff Engineer")).toBe("IC");
    expect(classifyLevel("Data Analyst")).toBe("IC");
  });

  it("returns Unknown for ambiguous titles", () => {
    expect(classifyLevel("Do Everything Person")).toBe("Unknown");
  });
});

describe("extractKeywords", () => {
  it("extracts technical keywords from JD text", () => {
    const text = "We are looking for a VP of Data Analytics experienced in Python, SQL, Snowflake, and machine learning to lead our data strategy.";
    const keywords = extractKeywords(text);
    expect(keywords).toContain("python");
    expect(keywords).toContain("sql");
    expect(keywords).toContain("snowflake");
    expect(keywords).toContain("machine learning");
    expect(keywords).toContain("data strategy");
  });

  it("extracts domain keywords", () => {
    const text = "Experience in financial services, healthcare, and retail industries preferred.";
    const keywords = extractKeywords(text);
    expect(keywords).toContain("financial services");
    expect(keywords).toContain("healthcare");
    expect(keywords).toContain("retail");
  });

  it("respects maxKeywords limit", () => {
    const text = "Python SQL Spark Snowflake dbt Airflow Tableau Looker AWS GCP Azure Kubernetes Docker TensorFlow machine learning deep learning data strategy data governance";
    const keywords = extractKeywords(text, 5);
    expect(keywords.length).toBeLessThanOrEqual(5);
  });

  it("returns empty array for empty text", () => {
    expect(extractKeywords("")).toEqual([]);
  });

  it("deduplicates keywords", () => {
    const text = "Python Python Python SQL SQL analytics analytics data strategy data strategy";
    const keywords = extractKeywords(text);
    const pythonCount = keywords.filter(k => k === "python").length;
    expect(pythonCount).toBeLessThanOrEqual(1);
  });
});

describe("isNewSinceYesterday", () => {
  it("returns true for job ingested today", () => {
    expect(isNewSinceYesterday(new Date())).toBe(true);
  });

  it("returns true for job ingested yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    expect(isNewSinceYesterday(yesterday)).toBe(true);
  });

  it("returns false for job ingested 3 days ago", () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    expect(isNewSinceYesterday(threeDaysAgo)).toBe(false);
  });

  it("handles ISO string input", () => {
    const now = new Date().toISOString();
    expect(isNewSinceYesterday(now)).toBe(true);
  });

  it("returns false for very old dates", () => {
    expect(isNewSinceYesterday("2020-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("getNewSinceYesterdayQuery", () => {
  it("returns valid SQL", () => {
    const sql = getNewSinceYesterdayQuery();
    expect(sql).toContain("SELECT");
    expect(sql).toContain("FROM jobs");
    expect(sql).toContain("INTERVAL '1 day'");
    expect(sql).toContain("ORDER BY");
  });
});

describe("buildJobPosting", () => {
  it("builds a complete JobPosting from minimal input", () => {
    const posting = buildJobPosting({
      company: "Global Payments",
      title: "VP of Analytics",
      location: "Atlanta, GA",
    });
    expect(posting.company).toBe("Global Payments");
    expect(posting.title).toBe("VP of Analytics");
    expect(posting.level).toBe("VP");
    expect(posting.hash).toBeDefined();
    expect(posting.hash.length).toBe(64);
    expect(posting.status).toBe("new");
    expect(posting.keywords).toEqual([]);
  });

  it("extracts keywords from description", () => {
    const posting = buildJobPosting({
      company: "Test Corp",
      title: "Director of Data Science",
      location: "Chicago, IL",
      description: "We need a leader experienced in Python, SQL, machine learning, and data strategy to transform our analytics platform on Snowflake.",
    });
    expect(posting.level).toBe("Director");
    expect(posting.keywords.length).toBeGreaterThan(0);
    expect(posting.keywords).toContain("python");
    expect(posting.keywords).toContain("machine learning");
    expect(posting.simhash).toBeDefined();
    expect(posting.simhash).not.toBe("0000000000000000");
  });

  it("computes hash consistently", () => {
    const a = buildJobPosting({ company: "X", title: "Y", location: "Z", description: "Same text here" });
    const b = buildJobPosting({ company: "X", title: "Y", location: "Z", description: "Same text here" });
    expect(a.hash).toBe(b.hash);
    expect(a.simhash).toBe(b.simhash);
  });

  it("falls back to company|title|location hash when no description", () => {
    const a = buildJobPosting({ company: "Acme", title: "VP", location: "NY" });
    const b = buildJobPosting({ company: "Acme", title: "VP", location: "NY" });
    expect(a.hash).toBe(b.hash);
  });

  it("classifies level from title", () => {
    expect(buildJobPosting({ company: "X", title: "Chief Data Officer", location: "Y" }).level).toBe("C-Suite");
    expect(buildJobPosting({ company: "X", title: "SVP Data", location: "Y" }).level).toBe("SVP");
    expect(buildJobPosting({ company: "X", title: "Director Analytics", location: "Y" }).level).toBe("Director");
    expect(buildJobPosting({ company: "X", title: "Data Scientist", location: "Y" }).level).toBe("IC");
  });
});

describe("Near-duplicate detection — end-to-end", () => {
  const baseJD = "We are seeking a VP of Data & Analytics to lead our enterprise data strategy, manage a team of 40+ analysts and data scientists, and drive digital transformation across the organization. The ideal candidate has 15+ years of experience in data leadership, expertise in Python, SQL, Snowflake, and cloud platforms (AWS/GCP/Azure), and a track record of delivering measurable business impact through analytics and AI/ML initiatives. This is a hybrid role based in Chicago.";

  it("detects exact duplicates via hash", () => {
    const a = buildJobPosting({ company: "A", title: "VP", location: "Chicago", description: baseJD });
    const b = buildJobPosting({ company: "B", title: "VP", location: "Chicago", description: baseJD });
    expect(a.hash).toBe(b.hash);
  });

  it("detects near-duplicates via simhash (minor edits)", () => {
    const edited = baseJD.replace("40+", "35+").replace("15+", "12+").replace("Chicago", "Atlanta");
    const a = buildJobPosting({ company: "A", title: "VP", location: "Chicago", description: baseJD });
    const b = buildJobPosting({ company: "A", title: "VP", location: "Atlanta", description: edited });
    expect(a.hash).not.toBe(b.hash);
    expect(isNearDuplicate(a.simhash!, b.simhash!)).toBe(true);
  });

  it("does not flag very different JDs as near-duplicates", () => {
    const differentJD = "Junior frontend developer needed for React and TypeScript web application development. 2 years experience required. Must know HTML, CSS, JavaScript, Git, and agile methodology. Entry-level position in our San Francisco office.";
    const a = buildJobPosting({ company: "A", title: "VP", location: "Chicago", description: baseJD });
    const b = buildJobPosting({ company: "B", title: "Dev", location: "SF", description: differentJD });
    expect(isNearDuplicate(a.simhash!, b.simhash!)).toBe(false);
  });
});
