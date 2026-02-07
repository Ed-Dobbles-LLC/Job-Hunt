import { describe, it, expect } from "vitest";
import {
  inferFunction,
  buildHiringChain,
  rankTargets,
  buildNoneFoundFallback,
  buildWebSearchQueries,
} from "../src/mastra/tools/contactDiscoveryTool";

describe("inferFunction", () => {
  it("maps data/analytics titles to Data & Analytics", () => {
    expect(inferFunction("VP of Data & Analytics")).toBe("Data & Analytics");
    expect(inferFunction("Director of Analytics")).toBe("Data & Analytics");
    expect(inferFunction("Head of Business Intelligence")).toBe("Data & Analytics");
    expect(inferFunction("Senior Data Engineer")).toBe("Data & Analytics");
  });

  it("maps engineering titles to Engineering", () => {
    expect(inferFunction("Staff Software Engineer")).toBe("Engineering");
    expect(inferFunction("Platform Engineer")).toBe("Engineering");
    expect(inferFunction("SRE Manager")).toBe("Engineering");
    expect(inferFunction("DevOps Lead")).toBe("Engineering");
    expect(inferFunction("Senior Developer")).toBe("Engineering");
  });

  it("maps product titles to Product", () => {
    expect(inferFunction("Senior Product Manager")).toBe("Product");
    expect(inferFunction("Director of Product")).toBe("Product");
  });

  it("maps design titles to Design", () => {
    expect(inferFunction("UX Designer")).toBe("Design");
    expect(inferFunction("Head of Design")).toBe("Design");
  });

  it("maps marketing titles to Marketing", () => {
    expect(inferFunction("VP of Marketing")).toBe("Marketing");
    expect(inferFunction("Growth Lead")).toBe("Marketing");
    expect(inferFunction("Content Manager")).toBe("Marketing");
  });

  it("maps sales titles to Sales", () => {
    expect(inferFunction("Account Executive")).toBe("Sales");
    expect(inferFunction("VP of Sales")).toBe("Sales");
    expect(inferFunction("Revenue Operations Manager")).toBe("Sales");
  });

  it("maps finance titles to Finance", () => {
    expect(inferFunction("CFO")).toBe("Finance");
    expect(inferFunction("FP&A Analyst")).toBe("Finance");
    expect(inferFunction("Director of Finance")).toBe("Finance");
  });

  it("maps people/HR titles to People / HR", () => {
    expect(inferFunction("Head of Talent Acquisition")).toBe("People / HR");
    expect(inferFunction("HR Business Partner")).toBe("People / HR");
    expect(inferFunction("Recruiting Manager")).toBe("People / HR");
  });

  it("maps operations titles to Operations", () => {
    expect(inferFunction("Chief of Staff")).toBe("Operations");
    expect(inferFunction("VP of Operations")).toBe("Operations");
    expect(inferFunction("Strategy Director")).toBe("Operations");
  });

  it("maps legal titles to Legal", () => {
    expect(inferFunction("General Counsel")).toBe("Legal");
    expect(inferFunction("Compliance Officer")).toBe("Legal");
  });

  it("maps security titles to Security", () => {
    expect(inferFunction("CISO")).toBe("Security");
    expect(inferFunction("InfoSec Engineer")).toBe("Security");
  });

  it("maps AI/ML titles to AI / ML", () => {
    expect(inferFunction("Machine Learning Engineer")).toBe("AI / ML");
    expect(inferFunction("Head of AI Research")).toBe("AI / ML");
  });

  it("defaults to General Management for unrecognized titles", () => {
    expect(inferFunction("Office Administrator")).toBe("General Management");
    expect(inferFunction("Janitor")).toBe("General Management");
  });
});

describe("buildHiringChain", () => {
  it("builds exec-level chain for VP titles", () => {
    const chain = buildHiringChain("VP of Data & Analytics", "Data & Analytics");
    expect(chain.length).toBeGreaterThanOrEqual(4);
    expect(chain[0]).toContain("C-suite");
    expect(chain.some((t) => t.includes("SVP"))).toBe(true);
    expect(chain.some((t) => t.includes("Talent") || t.includes("Recruiter"))).toBe(true);
    expect(chain[chain.length - 1]).toContain("HR Business Partner");
  });

  it("builds exec-level chain for Director titles", () => {
    const chain = buildHiringChain("Director of Engineering", "Engineering");
    expect(chain[0]).toContain("C-suite");
    expect(chain.some((t) => t.includes("Engineering"))).toBe(true);
  });

  it("builds exec-level chain for Head of titles", () => {
    const chain = buildHiringChain("Head of Product", "Product");
    expect(chain[0]).toContain("C-suite");
  });

  it("builds manager-level chain for Manager titles", () => {
    const chain = buildHiringChain("Engineering Manager", "Engineering");
    expect(chain[0]).toContain("VP");
    expect(chain.some((t) => t.includes("Director"))).toBe(true);
    expect(chain.some((t) => t.includes("Recruiter"))).toBe(true);
  });

  it("builds manager-level chain for Lead titles", () => {
    const chain = buildHiringChain("Team Lead, Data Platform", "Data & Analytics");
    expect(chain[0]).toContain("VP");
  });

  it("builds manager-level chain for Senior titles", () => {
    const chain = buildHiringChain("Senior Software Engineer", "Engineering");
    expect(chain[0]).toContain("VP");
    expect(chain.some((t) => t.includes("Engineering"))).toBe(true);
  });

  it("builds IC-level chain for standard titles", () => {
    const chain = buildHiringChain("Software Engineer", "Engineering");
    expect(chain[0]).toContain("Director");
    expect(chain.some((t) => t.includes("Manager"))).toBe(true);
    expect(chain.some((t) => t.includes("Recruiter"))).toBe(true);
  });

  it("always includes HR Business Partner at the end", () => {
    const chain1 = buildHiringChain("CEO", "Operations");
    const chain2 = buildHiringChain("Intern", "Engineering");
    expect(chain1[chain1.length - 1]).toBe("HR Business Partner");
    expect(chain2[chain2.length - 1]).toBe("HR Business Partner");
  });
});

describe("rankTargets", () => {
  const makeTarget = (
    role_category: string,
    confidence: number,
    person_name: string = "",
  ) => ({
    person_name,
    title: "Some Title",
    role_category: role_category as any,
    rationale: "Test rationale",
    source: "web_search",
    confidence,
    search_query: "test query",
    outreach_angle: "test angle",
  });

  it("sorts hiring_manager before recruiter", () => {
    const targets = [
      makeTarget("recruiter", 0.9, "Alice"),
      makeTarget("hiring_manager", 0.9, "Bob"),
    ];
    const ranked = rankTargets(targets);
    expect(ranked[0].role_category).toBe("hiring_manager");
    expect(ranked[1].role_category).toBe("recruiter");
  });

  it("sorts department_head before team_lead", () => {
    const targets = [
      makeTarget("team_lead", 1.0, "Charlie"),
      makeTarget("department_head", 1.0, "Dana"),
    ];
    const ranked = rankTargets(targets);
    expect(ranked[0].role_category).toBe("department_head");
  });

  it("sorts by confidence within same role category", () => {
    const targets = [
      makeTarget("recruiter", 0.5, "Low Confidence"),
      makeTarget("recruiter", 0.9, "High Confidence"),
    ];
    const ranked = rankTargets(targets);
    expect(ranked[0].person_name).toBe("High Confidence");
    expect(ranked[1].person_name).toBe("Low Confidence");
  });

  it("prefers named contacts over unnamed within same role and confidence", () => {
    const targets = [
      makeTarget("hiring_manager", 0.8, ""),
      makeTarget("hiring_manager", 0.8, "Named Person"),
    ];
    const ranked = rankTargets(targets);
    expect(ranked[0].person_name).toBe("Named Person");
  });

  it("produces correct full ordering for mixed targets", () => {
    const targets = [
      makeTarget("peer", 0.3, ""),
      makeTarget("hiring_manager", 1.0, "Best Contact"),
      makeTarget("recruiter", 0.7, "Recruiter"),
      makeTarget("department_head", 0.5, ""),
      makeTarget("executive_sponsor", 0.4, "Exec"),
    ];
    const ranked = rankTargets(targets);
    expect(ranked[0].role_category).toBe("hiring_manager");
    expect(ranked[1].role_category).toBe("department_head");
    expect(ranked[2].role_category).toBe("recruiter");
    expect(ranked[3].role_category).toBe("executive_sponsor");
    expect(ranked[4].role_category).toBe("peer");
  });

  it("does not mutate the original array", () => {
    const targets = [
      makeTarget("peer", 0.5, "A"),
      makeTarget("hiring_manager", 0.9, "B"),
    ];
    const original = [...targets];
    rankTargets(targets);
    expect(targets[0].role_category).toBe(original[0].role_category);
    expect(targets[1].role_category).toBe(original[1].role_category);
  });

  it("handles empty array", () => {
    expect(rankTargets([])).toHaveLength(0);
  });

  it("handles single target", () => {
    const ranked = rankTargets([makeTarget("recruiter", 0.8, "Solo")]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].person_name).toBe("Solo");
  });
});

describe("buildNoneFoundFallback", () => {
  it("returns recommended search queries with company and function", () => {
    const fallback = buildNoneFoundFallback(
      "Acme Corp",
      "VP of Data",
      "Data & Analytics",
      ["C-suite", "SVP of Data & Analytics"],
    );
    expect(fallback.recommended_search_queries.length).toBeGreaterThanOrEqual(3);
    expect(
      fallback.recommended_search_queries.some((q) => q.includes("Acme Corp")),
    ).toBe(true);
    expect(
      fallback.recommended_search_queries.some((q) => q.includes("Data & Analytics")),
    ).toBe(true);
  });

  it("includes LinkedIn site: search in queries", () => {
    const fallback = buildNoneFoundFallback(
      "TechCo",
      "Engineer",
      "Engineering",
      ["Director of Engineering"],
    );
    expect(
      fallback.recommended_search_queries.some((q) =>
        q.includes("site:linkedin.com"),
      ),
    ).toBe(true);
  });

  it("returns suggested titles from the hiring chain", () => {
    const chain = ["VP of Engineering", "Director of Engineering", "Recruiter"];
    const fallback = buildNoneFoundFallback("Startup Inc", "Engineer", "Engineering", chain);
    expect(fallback.suggested_titles).toEqual(chain);
  });

  it("returns alternative channels", () => {
    const fallback = buildNoneFoundFallback(
      "BigCo",
      "PM",
      "Product",
      ["VP Product"],
    );
    expect(fallback.alternative_channels.length).toBeGreaterThanOrEqual(3);
    expect(
      fallback.alternative_channels.some((c) => c.includes("BigCo")),
    ).toBe(true);
    expect(
      fallback.alternative_channels.some(
        (c) => c.includes("careers") || c.includes("LinkedIn"),
      ),
    ).toBe(true);
  });

  it("strips quotes from company name in search queries", () => {
    const fallback = buildNoneFoundFallback(
      "O'Brien's \"Company\"",
      "Manager",
      "Operations",
      ["VP Ops"],
    );
    const joined = fallback.recommended_search_queries.join(" ");
    expect(joined).not.toContain("O'Brien");
    expect(joined).toContain("OBriens Company");
  });

  it("includes function context in alternative channels", () => {
    const fallback = buildNoneFoundFallback(
      "HealthTech",
      "Data Scientist",
      "AI / ML",
      ["VP AI"],
    );
    expect(
      fallback.alternative_channels.some((c) => c.includes("AI / ML")),
    ).toBe(true);
  });
});

describe("ROLE_PRIORITY ordering", () => {
  it("hiring_manager has the highest priority (lowest number)", () => {
    const targets = [
      { person_name: "A", title: "T", role_category: "peer" as const, rationale: "r", source: "s", confidence: 1, search_query: "q", outreach_angle: "a" },
      { person_name: "B", title: "T", role_category: "hiring_manager" as const, rationale: "r", source: "s", confidence: 1, search_query: "q", outreach_angle: "a" },
      { person_name: "C", title: "T", role_category: "hr_contact" as const, rationale: "r", source: "s", confidence: 1, search_query: "q", outreach_angle: "a" },
      { person_name: "D", title: "T", role_category: "executive_sponsor" as const, rationale: "r", source: "s", confidence: 1, search_query: "q", outreach_angle: "a" },
      { person_name: "E", title: "T", role_category: "department_head" as const, rationale: "r", source: "s", confidence: 1, search_query: "q", outreach_angle: "a" },
      { person_name: "F", title: "T", role_category: "recruiter" as const, rationale: "r", source: "s", confidence: 1, search_query: "q", outreach_angle: "a" },
      { person_name: "G", title: "T", role_category: "team_lead" as const, rationale: "r", source: "s", confidence: 1, search_query: "q", outreach_angle: "a" },
    ];
    const ranked = rankTargets(targets);
    expect(ranked.map((t) => t.role_category)).toEqual([
      "hiring_manager",
      "department_head",
      "recruiter",
      "team_lead",
      "hr_contact",
      "executive_sponsor",
      "peer",
    ]);
  });
});

describe("buildWebSearchQueries", () => {
  it("generates at least 4 search queries", () => {
    const queries = buildWebSearchQueries(
      "Acme Corp",
      "Data & Analytics",
      ["C-suite / CEO at the company", "SVP of Data & Analytics"],
    );
    expect(queries.length).toBeGreaterThanOrEqual(4);
  });

  it("includes company name in all queries", () => {
    const queries = buildWebSearchQueries("TechCo", "Engineering", ["VP of Engineering"]);
    for (const q of queries) {
      expect(q).toContain("TechCo");
    }
  });

  it("includes target function in relevant queries", () => {
    const queries = buildWebSearchQueries("TechCo", "Data & Analytics", ["VP of Data"]);
    expect(queries.some((q) => q.includes("Data & Analytics"))).toBe(true);
  });

  it("includes hiring chain top title", () => {
    const queries = buildWebSearchQueries("Startup", "Product", ["VP of Product"]);
    expect(queries.some((q) => q.includes("VP of Product"))).toBe(true);
  });

  it("strips quotes from company name", () => {
    const queries = buildWebSearchQueries("O'Reilly's \"Media\"", "Engineering", ["CTO"]);
    for (const q of queries) {
      expect(q).not.toContain("'");
      expect(q).not.toContain('"Media"');
    }
  });

  it("includes leadership/team page search", () => {
    const queries = buildWebSearchQueries("BigCo", "Sales", ["VP Sales"]);
    expect(queries.some((q) => q.includes("leadership") || q.includes("team"))).toBe(true);
  });

  it("includes recruiter search", () => {
    const queries = buildWebSearchQueries("BigCo", "Engineering", ["VP Eng"]);
    expect(queries.some((q) => q.includes("recruiter") || q.includes("talent"))).toBe(true);
  });

  it("removes 'at the company' from hiring chain titles", () => {
    const queries = buildWebSearchQueries("BigCo", "Operations", [
      "C-suite / CEO at the company",
    ]);
    const titleQuery = queries.find((q) => q.includes("C-suite"));
    expect(titleQuery).toBeDefined();
    expect(titleQuery).not.toContain("at the company");
  });
});

describe("edge cases", () => {
  it("inferFunction is case-insensitive", () => {
    expect(inferFunction("VP OF DATA")).toBe("Data & Analytics");
    expect(inferFunction("MACHINE LEARNING ENGINEER")).toBe("AI / ML");
    expect(inferFunction("cfo")).toBe("Finance");
  });

  it("buildHiringChain uses target function in titles", () => {
    const chain = buildHiringChain("VP of Data", "Data & Analytics");
    expect(chain.some((t) => t.includes("Data & Analytics"))).toBe(true);
  });

  it("buildNoneFoundFallback returns at least 5 search queries", () => {
    const fallback = buildNoneFoundFallback("Co", "Role", "Dept", ["Title"]);
    expect(fallback.recommended_search_queries.length).toBeGreaterThanOrEqual(5);
  });

  it("buildNoneFoundFallback returns at least 5 alternative channels", () => {
    const fallback = buildNoneFoundFallback("Co", "Role", "Dept", ["Title"]);
    expect(fallback.alternative_channels.length).toBeGreaterThanOrEqual(5);
  });
});
