import { describe, it, expect, beforeEach } from "vitest";
import {
  buildEntityAllowlist,
  buildEntityDenylist,
  scanForPlaceholders,
  checkTextAgainstDenylist,
  checkTextAgainstAllowlist,
  buildAllowlistReport,
  type EntityAllowlist,
  type EntityDenylist,
  type AllowlistEntry,
  type MetricEntry,
} from "../src/mastra/tools/entityAllowlist";
import {
  layer4bDenylistCheck,
} from "../src/mastra/tools/verifyTruthTool";

const SAMPLE_INVENTORY = {
  profile: {
    name: "Ed Martinez",
    current_title: "VP of Data & Analytics",
    email: "ed.martinez@example.com",
    phone: "(555) 123-4567",
    location: "Chicago, IL",
    linkedin: "linkedin.com/in/edmartinez",
    summary: "Data & Analytics executive with 15+ years of experience.",
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
          text: "Led a 45-person data organization spanning analytics engineering",
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
    {
      id: "exp-002",
      employer: "HealthTech Solutions Inc.",
      title: "Senior Director, Data Science & Analytics",
      start_date: "2018-06",
      end_date: "2021-02",
      location: "Chicago, IL",
      bullets: [
        {
          id: "exp-002-b1",
          text: "Managed a team of 28 data scientists",
          metrics: ["28-person team"],
        },
        {
          id: "exp-002-b2",
          text: "Developed patient readmission prediction model achieving 0.89 AUC",
          metrics: ["0.89 AUC", "$31M saved"],
          tools: ["Python", "XGBoost", "TensorFlow"],
        },
      ],
    },
  ],
  education: [
    {
      id: "edu-001",
      institution: "University of Chicago",
      degree: "MBA, Concentrations in Econometrics & Statistics",
      year: "2010",
    },
    {
      id: "edu-002",
      institution: "University of Illinois at Urbana-Champaign",
      degree: "BS in Computer Science, Minor in Mathematics",
      year: "2006",
    },
  ],
  skills: {
    leadership: ["Executive stakeholder management", "Team building & mentorship"],
    technical: ["Python", "SQL", "Spark", "Tableau"],
    data_science: ["Machine Learning", "Deep Learning"],
  },
  certifications: [
    { id: "cert-001", name: "AWS Certified Solutions Architect", year: "2020" },
    { id: "cert-002", name: "Google Cloud Professional Data Engineer", year: "2021" },
  ],
};

describe("EntityAllowlist — buildEntityAllowlist", () => {
  let allowlist: EntityAllowlist;

  it("builds allowlist from inventory", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    expect(allowlist).toBeDefined();
    expect(allowlist.companies.length).toBeGreaterThan(0);
    expect(allowlist.titles.length).toBeGreaterThan(0);
    expect(allowlist.dates.length).toBeGreaterThan(0);
    expect(allowlist.tools.length).toBeGreaterThan(0);
    expect(allowlist.metrics.length).toBeGreaterThan(0);
  });

  it("extracts companies from experience + education", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const companyNames = allowlist.companies.map(c => c.value);
    expect(companyNames).toContain("Acme Financial Group");
    expect(companyNames).toContain("HealthTech Solutions Inc.");
    expect(companyNames).toContain("University of Chicago");
    expect(companyNames).toContain("University of Illinois at Urbana-Champaign");
  });

  it("extracts titles from experience + profile", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const titleValues = allowlist.titles.map(t => t.value);
    expect(titleValues).toContain("VP of Data & Analytics");
    expect(titleValues).toContain("Senior Director, Data Science & Analytics");
  });

  it("extracts dates from experience, education, and certifications", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const dateValues = allowlist.dates.map(d => d.value);
    expect(dateValues).toContain("2021-03");
    expect(dateValues).toContain("present");
    expect(dateValues).toContain("2018-06");
    expect(dateValues).toContain("2010");
    expect(dateValues).toContain("2006");
    expect(dateValues).toContain("2020");
  });

  it("extracts locations from experience + profile", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const locValues = allowlist.locations.map(l => l.value);
    expect(locValues).toContain("Chicago, IL");
    expect(locValues).toContain("Chicago, IL (Hybrid)");
  });

  it("extracts degrees from education", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const degreeValues = allowlist.degrees.map(d => d.value);
    expect(degreeValues).toContain("MBA, Concentrations in Econometrics & Statistics");
    expect(degreeValues).toContain("BS in Computer Science, Minor in Mathematics");
  });

  it("extracts certifications", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const certValues = allowlist.certifications.map(c => c.value);
    expect(certValues).toContain("AWS Certified Solutions Architect");
    expect(certValues).toContain("Google Cloud Professional Data Engineer");
  });

  it("extracts tools from bullet tools + skills (deduplicated)", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const toolValues = allowlist.tools.map(t => t.value);
    expect(toolValues).toContain("Snowflake");
    expect(toolValues).toContain("dbt");
    expect(toolValues).toContain("Python");
    expect(toolValues).toContain("XGBoost");
    expect(toolValues).toContain("Tableau");
    expect(toolValues).toContain("Machine Learning");
    const pythonCount = toolValues.filter(t => t === "Python").length;
    expect(pythonCount).toBe(1);
  });

  it("extracts metrics with parsed number and unit", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const metricValues = allowlist.metrics.map(m => m.value);
    expect(metricValues).toContain("45-person team");
    expect(metricValues).toContain("$12M annual cost savings");
    expect(metricValues).toContain("0.89 AUC");
    expect(metricValues).toContain("$31M saved");

    const dollarMetric = allowlist.metrics.find(m => m.value === "$12M annual cost savings");
    expect(dollarMetric).toBeDefined();
    expect(dollarMetric!.number).toBeDefined();
  });

  it("extracts skills separately", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const skillValues = allowlist.skills.map(s => s.value);
    expect(skillValues).toContain("Executive stakeholder management");
    expect(skillValues).toContain("Team building & mentorship");
    expect(skillValues).toContain("Deep Learning");
  });

  it("includes sourceId and sourcePath for traceability", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    const acme = allowlist.companies.find(c => c.value === "Acme Financial Group");
    expect(acme).toBeDefined();
    expect(acme!.sourceId).toBe("exp-001");
    expect(acme!.sourcePath).toBe("experience[0].employer");
  });

  it("normalizes all entries to lowercase", () => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
    for (const company of allowlist.companies) {
      expect(company.normalized).toBe(company.value.toLowerCase().trim().replace(/\s+/g, " "));
    }
  });
});

describe("EntityDenylist — buildEntityDenylist", () => {
  let denylist: EntityDenylist;

  it("builds denylist with default entries", () => {
    denylist = buildEntityDenylist();
    expect(denylist.entries.length).toBeGreaterThan(10);
  });

  it("includes placeholder domain patterns", () => {
    denylist = buildEntityDenylist();
    const domains = denylist.entries.filter(e => e.category === "placeholder_domain");
    expect(domains.length).toBeGreaterThanOrEqual(3);
    expect(domains.some(d => d.pattern.includes("example"))).toBe(true);
  });

  it("includes placeholder phone patterns", () => {
    denylist = buildEntityDenylist();
    const phones = denylist.entries.filter(e => e.category === "placeholder_phone");
    expect(phones.length).toBeGreaterThanOrEqual(1);
  });

  it("includes placeholder name patterns", () => {
    denylist = buildEntityDenylist();
    const names = denylist.entries.filter(e => e.category === "placeholder_name");
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it("includes code artifact patterns", () => {
    denylist = buildEntityDenylist();
    const artifacts = denylist.entries.filter(e => e.category === "code_artifact");
    expect(artifacts.length).toBeGreaterThanOrEqual(4);
  });

  it("includes template variable patterns", () => {
    denylist = buildEntityDenylist();
    const templates = denylist.entries.filter(e => e.category === "template_variable");
    expect(templates.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts custom entries", () => {
    denylist = buildEntityDenylist([{
      pattern: "WidgetCo",
      regex: /\bWidgetCo\b/gi,
      reason: "Custom placeholder",
      category: "placeholder_company",
    }]);
    const hasCustom = denylist.entries.some(e => e.pattern === "WidgetCo");
    expect(hasCustom).toBe(true);
    expect(denylist.entries.length).toBeGreaterThan(10);
  });
});

describe("EntityDenylist — checkTextAgainstDenylist", () => {
  let denylist: EntityDenylist;

  beforeEach(() => {
    denylist = buildEntityDenylist();
  });

  it("detects example.com in text", () => {
    const result = checkTextAgainstDenylist("Contact me at ed@example.com for details", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("example.com"))).toBe(true);
  });

  it("detects 555 phone numbers", () => {
    const result = checkTextAgainstDenylist("Call me at (555) 123-4567", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("555"))).toBe(true);
  });

  it("detects [object Object]", () => {
    const result = checkTextAgainstDenylist("Experience: [object Object]", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("[object Object]"))).toBe(true);
  });

  it("detects undefined keyword", () => {
    const result = checkTextAgainstDenylist("Skills: undefined", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("undefined"))).toBe(true);
  });

  it("detects NaN", () => {
    const result = checkTextAgainstDenylist("Achieved NaN% improvement", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("NaN"))).toBe(true);
  });

  it("detects unresolved template variables {{ }}", () => {
    const result = checkTextAgainstDenylist("Dear {{hiring_manager}}, I am writing...", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("template variable"))).toBe(true);
  });

  it("detects unresolved template variables ${ }", () => {
    const result = checkTextAgainstDenylist("I worked at ${company_name} for 5 years", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("template variable"))).toBe(true);
  });

  it("detects lorem ipsum", () => {
    const result = checkTextAgainstDenylist("Lorem ipsum dolor sit amet", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("Lorem Ipsum"))).toBe(true);
  });

  it("detects TODO markers", () => {
    const result = checkTextAgainstDenylist("TODO fill in metrics here", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("TODO"))).toBe(true);
  });

  it("detects TBD placeholders", () => {
    const result = checkTextAgainstDenylist("Salary: TBD", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("TBD"))).toBe(true);
  });

  it("detects John Doe placeholder", () => {
    const result = checkTextAgainstDenylist("Dear John Doe, I am applying for...", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("John Doe"))).toBe(true);
  });

  it("detects Acme placeholder", () => {
    const result = checkTextAgainstDenylist("I worked at Acme for 5 years", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("Acme"))).toBe(true);
  });

  it("detects xxx placeholder", () => {
    const result = checkTextAgainstDenylist("Phone: xxx-xxx-xxxx", denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.some(v => v.reason.includes("xxx"))).toBe(true);
  });

  it("passes clean text with no violations", () => {
    const cleanText = "Led a team of 45 analysts at Global Payments, driving $12M in annual savings through data platform modernization.";
    const result = checkTextAgainstDenylist(cleanText, denylist);
    expect(result.matched).toBe(false);
    expect(result.violations.length).toBe(0);
  });

  it("detects multiple violations in one text", () => {
    const dirtyText = "Contact John Doe at example.com or (555) 123-4567. TODO add more details. undefined";
    const result = checkTextAgainstDenylist(dirtyText, denylist);
    expect(result.matched).toBe(true);
    expect(result.violations.length).toBeGreaterThanOrEqual(4);
  });
});

describe("EntityAllowlist — scanForPlaceholders", () => {
  it("detects placeholders in sample inventory", () => {
    const detected = scanForPlaceholders(SAMPLE_INVENTORY);
    expect(detected.length).toBeGreaterThan(0);
    const fields = detected.map(d => d.field);
    expect(fields.some(f => f.includes("email"))).toBe(true);
    expect(fields.some(f => f.includes("phone"))).toBe(true);
    expect(detected.some(d => d.reason.includes("example.com"))).toBe(true);
    expect(detected.some(d => d.reason.includes("555"))).toBe(true);
  });

  it("detects Acme in employer field", () => {
    const detected = scanForPlaceholders(SAMPLE_INVENTORY);
    const acmeHit = detected.find(d => d.field.includes("employer") && d.reason.includes("Acme"));
    expect(acmeHit).toBeDefined();
  });

  it("returns empty for clean inventory", () => {
    const cleanInventory = {
      profile: {
        name: "Real Person",
        email: "real@gmail.com",
        phone: "(312) 867-5309",
        location: "Chicago, IL",
      },
      experience: [
        {
          id: "exp-001",
          employer: "Global Payments",
          title: "VP Analytics",
          start_date: "2021-01",
          end_date: "present",
          location: "Chicago, IL",
          bullets: [{ id: "exp-001-b1", text: "Led analytics team of 30 people" }],
        },
      ],
      education: [
        { id: "edu-001", institution: "Northwestern University", degree: "MBA" },
      ],
    };
    const detected = scanForPlaceholders(cleanInventory);
    expect(detected.length).toBe(0);
  });
});

describe("EntityAllowlist — checkTextAgainstAllowlist", () => {
  let allowlist: EntityAllowlist;

  beforeEach(() => {
    allowlist = buildEntityAllowlist(SAMPLE_INVENTORY);
  });

  it("finds allowlisted companies in text", () => {
    const result = checkTextAgainstAllowlist(
      "During my time at Acme Financial Group, I led data transformation initiatives.",
      allowlist,
    );
    expect(result.companies).toContain("Acme Financial Group");
  });

  it("finds allowlisted tools in text", () => {
    const result = checkTextAgainstAllowlist(
      "Built data pipelines using Snowflake, dbt, and Airflow with Python orchestration.",
      allowlist,
    );
    expect(result.tools).toContain("Snowflake");
    expect(result.tools).toContain("Python");
  });

  it("flags unlisted years", () => {
    const result = checkTextAgainstAllowlist(
      "In 1999 I started my career in data analytics.",
      allowlist,
    );
    expect(result.unlisted).toContain("year: 1999");
  });

  it("accepts allowlisted years", () => {
    const result = checkTextAgainstAllowlist(
      "Earned MBA from University of Chicago in 2010.",
      allowlist,
    );
    expect(result.dates).toContain("2010");
    expect(result.unlisted.filter(u => u.includes("2010")).length).toBe(0);
  });

  it("skips current year from unlisted check", () => {
    const currentYear = new Date().getFullYear().toString();
    const result = checkTextAgainstAllowlist(
      `As of ${currentYear}, I continue to lead data strategy.`,
      allowlist,
    );
    expect(result.unlisted.filter(u => u.includes(currentYear)).length).toBe(0);
  });
});

describe("EntityAllowlist — buildAllowlistReport", () => {
  it("produces complete report with stats", () => {
    const report = buildAllowlistReport(SAMPLE_INVENTORY);
    expect(report.stats.companies).toBeGreaterThan(0);
    expect(report.stats.titles).toBeGreaterThan(0);
    expect(report.stats.dates).toBeGreaterThan(0);
    expect(report.stats.tools).toBeGreaterThan(0);
    expect(report.stats.metrics).toBeGreaterThan(0);
    expect(report.stats.denylistRules).toBeGreaterThan(10);
  });

  it("detects placeholders in sample inventory", () => {
    const report = buildAllowlistReport(SAMPLE_INVENTORY);
    expect(report.detectedPlaceholders.length).toBeGreaterThan(0);
  });

  it("allowlist and denylist are both populated", () => {
    const report = buildAllowlistReport(SAMPLE_INVENTORY);
    expect(report.allowlist.companies.length).toBeGreaterThan(0);
    expect(report.denylist.entries.length).toBeGreaterThan(0);
  });
});

describe("Layer 4b — denylist integration in verifier", () => {
  it("passes clean resume/cover letter text", () => {
    const result = layer4bDenylistCheck(
      "Led a team of 45 analysts delivering predictive analytics for financial services.",
      "I am excited to apply for the VP of Data Analytics role at Global Payments.",
    );
    expect(result.passed).toBe(true);
    expect(result.failures.length).toBe(0);
    expect(result.name).toBe("denylist_check");
  });

  it("fails text containing example.com", () => {
    const result = layer4bDenylistCheck(
      "Contact: ed@example.com",
      "I look forward to hearing from you.",
    );
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes("example.com"))).toBe(true);
  });

  it("fails text containing [object Object]", () => {
    const result = layer4bDenylistCheck(
      "Experience: [object Object]",
      "My background includes data science leadership.",
    );
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes("[object Object]"))).toBe(true);
  });

  it("fails text containing unresolved templates", () => {
    const result = layer4bDenylistCheck(
      "Led analytics at {{company_name}}",
      "Dear {{hiring_manager}}, I am writing to express my interest.",
    );
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(2);
  });

  it("fails text containing Acme placeholder", () => {
    const result = layer4bDenylistCheck(
      "At Acme, I managed a team of 45 analysts.",
      "I am interested in joining your organization.",
    );
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes("Acme"))).toBe(true);
  });

  it("fails text containing 555 phone number", () => {
    const result = layer4bDenylistCheck(
      "Phone: (555) 123-4567",
      "Available for interviews at your convenience.",
    );
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes("555"))).toBe(true);
  });

  it("detects multiple violations and reports all", () => {
    const result = layer4bDenylistCheck(
      "John Doe at example.com, TODO fix this",
      "Skills: undefined. Lorem ipsum dolor sit amet.",
    );
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(4);
  });
});

describe("EntityAllowlist — edge cases", () => {
  it("handles empty inventory gracefully", () => {
    const allowlist = buildEntityAllowlist({});
    expect(allowlist.companies.length).toBe(0);
    expect(allowlist.titles.length).toBe(0);
    expect(allowlist.tools.length).toBe(0);
    expect(allowlist.metrics.length).toBe(0);
  });

  it("handles inventory with no bullets", () => {
    const inv = {
      experience: [{
        id: "exp-001",
        employer: "Test Corp",
        title: "Analyst",
        start_date: "2020-01",
        end_date: "present",
        bullets: [],
      }],
    };
    const allowlist = buildEntityAllowlist(inv);
    expect(allowlist.companies.length).toBe(1);
    expect(allowlist.metrics.length).toBe(0);
  });

  it("handles string-only certifications", () => {
    const inv = {
      certifications: ["PMP", "Scrum Master"],
    };
    const allowlist = buildEntityAllowlist(inv);
    expect(allowlist.certifications.length).toBe(2);
    expect(allowlist.certifications[0].value).toBe("PMP");
  });

  it("denylist does not false-positive on legitimate analyst text", () => {
    const denylist = buildEntityDenylist();
    const cleanText = "As a Senior Director at HealthTech Solutions, I managed a team of 28 data scientists delivering predictive analytics models achieving 0.89 AUC for population health management, saving $31M annually.";
    const result = checkTextAgainstDenylist(cleanText, denylist);
    expect(result.matched).toBe(false);
  });

  it("denylist does not flag null within words like 'annually'", () => {
    const denylist = buildEntityDenylist();
    const result = checkTextAgainstDenylist("Saving $31M annually through optimization", denylist);
    const nullViolations = result.violations.filter(v => v.reason.includes("null"));
    expect(nullViolations.length).toBe(0);
  });
});
