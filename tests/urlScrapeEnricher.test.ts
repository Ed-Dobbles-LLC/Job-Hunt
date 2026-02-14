import { describe, it, expect } from "vitest";

// Test the htmlToText and extractJdSection logic by importing the module
// Since the functions are not exported, we test the enrichJobsByUrl public interface
// by verifying the module can be imported and the types are correct

describe("URL Scrape Enricher", () => {
  it("exports enrichJobsByUrl function", async () => {
    const mod = await import("../src/mastra/tools/urlScrapeEnricher");
    expect(typeof mod.enrichJobsByUrl).toBe("function");
  });

  it("exports enrichAllByUrl function", async () => {
    const mod = await import("../src/mastra/tools/urlScrapeEnricher");
    expect(typeof mod.enrichAllByUrl).toBe("function");
  });

  it("enrichJobsByUrl handles jobs with no posting URL", async () => {
    const { enrichJobsByUrl } = await import("../src/mastra/tools/urlScrapeEnricher");
    const result = await enrichJobsByUrl([
      { job_id: 1, company: "TestCo", title: "Engineer", posting_url: null },
      { job_id: 2, company: "TestCo2", title: "Manager", posting_url: "" },
    ]);

    expect(result.enrichedCount).toBe(0);
    expect(result.failedCount).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[1].status).toBe("failed");
  });

  it("enrichJobsByUrl handles unreachable URLs gracefully", async () => {
    const { enrichJobsByUrl } = await import("../src/mastra/tools/urlScrapeEnricher");
    const result = await enrichJobsByUrl([
      {
        job_id: 99,
        company: "Nonexistent",
        title: "Role",
        posting_url: "http://this-domain-does-not-exist-12345.example.com/job/123",
      },
    ]);

    expect(result.enrichedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results[0].status).toBe("failed");
  });

  it("returns correct result shape", async () => {
    const { enrichJobsByUrl } = await import("../src/mastra/tools/urlScrapeEnricher");
    const result = await enrichJobsByUrl([]);
    expect(result).toEqual({
      results: [],
      enrichedCount: 0,
      failedCount: 0,
    });
  });
});
