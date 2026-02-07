import { describe, it, expect } from "vitest";
import {
  renderDigestEmail,
  escapeHtml,
  scoreColor,
  scoreBgColor,
  type DigestData,
  type DigestJob,
  type DigestStats,
} from "../src/mastra/tools/digestEmailTemplate";

function makeSampleStats(overrides: Partial<DigestStats> = {}): DigestStats {
  return {
    jobsFetched: 25,
    jobsScored: 20,
    jobsShortlisted: 5,
    packetsGenerated: 5,
    truthPassCount: 4,
    truthFailCount: 1,
    ...overrides,
  };
}

function makeSampleJob(overrides: Partial<DigestJob> = {}): DigestJob {
  return {
    rank: 1,
    company: "Acme Corp",
    title: "VP of Data & Analytics",
    score: 85,
    truthPass: true,
    postingUrl: "https://example.com/job/123",
    location: "Chicago, IL",
    salaryRange: "$180K–$220K",
    roleShape: "builder",
    topSkills: ["Python", "Snowflake", "dbt"],
    gapNotes: [],
    ...overrides,
  };
}

function makeSampleDigest(overrides: Partial<DigestData> = {}): DigestData {
  return {
    date: "2026-02-07",
    stats: makeSampleStats(),
    jobs: [
      makeSampleJob({ rank: 1, score: 92, company: "TechCo" }),
      makeSampleJob({ rank: 2, score: 75, company: "DataInc", truthPass: false }),
      makeSampleJob({ rank: 3, score: 55, company: "StartupXYZ" }),
    ],
    runTimestamp: "2026-02-07T12:30:00.000Z",
    modelUsed: "gpt-4o",
    promptVersion: "v2",
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
    );
  });

  it("escapes quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("handles null/undefined gracefully", () => {
    expect(escapeHtml(null as any)).toBe("");
    expect(escapeHtml(undefined as any)).toBe("");
  });
});

describe("scoreColor", () => {
  it("returns green for score >= 80", () => {
    expect(scoreColor(80)).toBe("#16a34a");
    expect(scoreColor(95)).toBe("#16a34a");
    expect(scoreColor(100)).toBe("#16a34a");
  });

  it("returns yellow for score >= 60 and < 80", () => {
    expect(scoreColor(60)).toBe("#ca8a04");
    expect(scoreColor(70)).toBe("#ca8a04");
    expect(scoreColor(79)).toBe("#ca8a04");
  });

  it("returns red for score < 60", () => {
    expect(scoreColor(59)).toBe("#dc2626");
    expect(scoreColor(0)).toBe("#dc2626");
    expect(scoreColor(30)).toBe("#dc2626");
  });
});

describe("scoreBgColor", () => {
  it("returns green bg for score >= 80", () => {
    expect(scoreBgColor(85)).toBe("#dcfce7");
  });

  it("returns yellow bg for score >= 60 and < 80", () => {
    expect(scoreBgColor(65)).toBe("#fef9c3");
  });

  it("returns red bg for score < 60", () => {
    expect(scoreBgColor(45)).toBe("#fef2f2");
  });
});

describe("renderDigestEmail", () => {
  it("produces valid HTML with DOCTYPE", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("contains today's date header", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("2026-02-07");
    expect(html).toContain("Daily Job Match Digest");
  });

  it("contains summary stats", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("25");
    expect(html).toContain("20");
    expect(html).toContain("Fetched");
    expect(html).toContain("Scored");
    expect(html).toContain("Shortlisted");
    expect(html).toContain("Packets");
    expect(html).toContain("Pass");
    expect(html).toContain("Fail");
  });

  it("contains ranked job table with headers", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("Company");
    expect(html).toContain("Role");
    expect(html).toContain("Score");
    expect(html).toContain("Truth");
  });

  it("contains company and role names in table", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("TechCo");
    expect(html).toContain("DataInc");
    expect(html).toContain("StartupXYZ");
    expect(html).toContain("VP of Data");
  });

  it("contains scores with proper color coding", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("#16a34a");
    expect(html).toContain("#ca8a04");
    expect(html).toContain("#dc2626");
  });

  it("contains truth pass/fail icons", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("&#9989;");
    expect(html).toContain("&#10060;");
  });

  it("contains job detail cards", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("Job Details");
    expect(html).toContain("Python");
    expect(html).toContain("Snowflake");
    expect(html).toContain("Chicago, IL");
    expect(html).toContain("$180K");
    expect(html).toContain("builder");
  });

  it("renders job posting links", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain('href="https://example.com/job/123"');
  });

  it("contains footer with run metadata", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("2026-02-07T12:30:00.000Z");
    expect(html).toContain("gpt-4o");
    expect(html).toContain("v2");
  });

  it("shows gap notes when present", () => {
    const digest = makeSampleDigest({
      jobs: [
        makeSampleJob({
          rank: 1,
          gapNotes: ["Missing Kubernetes experience", "No healthcare domain"],
        }),
      ],
    });
    const html = renderDigestEmail(digest);
    expect(html).toContain("GAPS");
    expect(html).toContain("Missing Kubernetes experience");
    expect(html).toContain("No healthcare domain");
  });

  it("handles special characters in company/role names", () => {
    const digest = makeSampleDigest({
      jobs: [
        makeSampleJob({
          rank: 1,
          company: "O'Reilly & Associates <Inc>",
          title: 'VP "Data" & Analytics',
        }),
      ],
    });
    const html = renderDigestEmail(digest);
    expect(html).toContain("O&#039;Reilly &amp; Associates &lt;Inc&gt;");
    expect(html).toContain("VP &quot;Data&quot; &amp; Analytics");
    expect(html).not.toContain("<Inc>");
  });

  it("is mobile-responsive with viewport meta", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).toContain("viewport");
    expect(html).toContain("width=device-width");
  });

  it("uses inline CSS only (no external stylesheets)", () => {
    const html = renderDigestEmail(makeSampleDigest());
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain("<style>");
  });
});

describe("renderDigestEmail – empty state", () => {
  it("shows no-matches message when no jobs", () => {
    const digest = makeSampleDigest({
      jobs: [],
      stats: makeSampleStats({
        jobsFetched: 10,
        jobsScored: 10,
        jobsShortlisted: 0,
        packetsGenerated: 0,
        truthPassCount: 0,
        truthFailCount: 0,
      }),
    });
    const html = renderDigestEmail(digest);
    expect(html).toContain("No matches today");
    expect(html).toContain("No job postings met the shortlist criteria");
    expect(html).not.toContain("Shortlisted Jobs");
    expect(html).not.toContain("Job Details");
  });

  it("still shows stats in empty state", () => {
    const digest = makeSampleDigest({
      jobs: [],
      stats: makeSampleStats({
        jobsFetched: 8,
        jobsScored: 5,
        jobsShortlisted: 0,
      }),
    });
    const html = renderDigestEmail(digest);
    expect(html).toContain("8");
    expect(html).toContain("5");
    expect(html).toContain("Fetched");
    expect(html).toContain("Scored");
  });
});

describe("renderDigestEmail – stats calculation accuracy", () => {
  it("renders exact stat values", () => {
    const stats = makeSampleStats({
      jobsFetched: 142,
      jobsScored: 98,
      jobsShortlisted: 12,
      packetsGenerated: 10,
      truthPassCount: 7,
      truthFailCount: 3,
    });
    const digest = makeSampleDigest({ stats });
    const html = renderDigestEmail(digest);

    expect(html).toContain(">142<");
    expect(html).toContain(">98<");
    expect(html).toContain(">12<");
    expect(html).toContain(">10<");
    expect(html).toContain(">7<");
    expect(html).toContain(">3<");
  });

  it("renders zero stats correctly", () => {
    const stats = makeSampleStats({
      jobsFetched: 0,
      jobsScored: 0,
      jobsShortlisted: 0,
      packetsGenerated: 0,
      truthPassCount: 0,
      truthFailCount: 0,
    });
    const digest = makeSampleDigest({ stats, jobs: [] });
    const html = renderDigestEmail(digest);

    const zeroMatches = html.match(/>0</g);
    expect(zeroMatches).not.toBeNull();
    expect(zeroMatches!.length).toBeGreaterThanOrEqual(6);
  });
});

describe("renderDigestEmail – job without optional fields", () => {
  it("handles missing URL, salary, roleShape, skills", () => {
    const digest = makeSampleDigest({
      jobs: [
        makeSampleJob({
          rank: 1,
          postingUrl: null,
          salaryRange: null,
          roleShape: null,
          topSkills: [],
          gapNotes: [],
        }),
      ],
    });
    const html = renderDigestEmail(digest);
    expect(html).toContain("Acme Corp");
    expect(html).toContain("No skill data");
    expect(html).not.toContain("GAPS");
  });
});
