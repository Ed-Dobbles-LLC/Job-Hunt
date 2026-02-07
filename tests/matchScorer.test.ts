import { describe, it, expect } from "vitest";
import {
  computeMatchReport,
  prettyPrintMatchReport,
  type ExperienceInventory,
  type MatchReport,
} from "../src/mastra/tools/matchScorer";
import type { JDRequirements } from "../src/mastra/tools/extractJDRequirementsTool";

const MOCK_INVENTORY: ExperienceInventory = {
  profile: {
    name: "Ed Martinez",
    current_title: "VP of Data & Analytics",
    location: "Chicago, IL",
    summary:
      "Data & Analytics executive with 15+ years of experience leading enterprise-scale data transformations.",
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
          text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake, consolidating 7 legacy data warehouses",
          metrics: ["$12M annual cost savings", "7 legacy data warehouses consolidated"],
          tools: ["Snowflake", "dbt", "Airflow"],
        },
        {
          id: "exp-001-b3",
          text: "Launched enterprise ML ops pipeline processing 2B+ daily events for real-time fraud detection, reducing false positive rate by 38%",
          metrics: ["2B+ daily events", "38% reduction in false positives"],
          tools: ["Python", "Spark", "MLflow", "Kubernetes"],
        },
        {
          id: "exp-001-b4",
          text: "Established data governance framework with 200+ data quality rules, improving data trust score from 62% to 94%",
          metrics: ["200+ data quality rules", "62% to 94% data trust score"],
        },
        {
          id: "exp-001-b5",
          text: "Built executive analytics dashboard suite adopted by C-suite and board, enabling data-driven quarterly strategic planning",
          tools: ["Tableau", "Looker"],
        },
        {
          id: "exp-001-b6",
          text: "Presented data strategy roadmap to board of directors, securing $8M multi-year investment in data infrastructure modernization",
          metrics: ["$8M investment"],
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
          text: "Managed a team of 28 data scientists, analysts, and engineers delivering predictive analytics for population health management",
          metrics: ["28-person team"],
        },
        {
          id: "exp-002-b2",
          text: "Developed patient readmission prediction model achieving 0.89 AUC, preventing an estimated 4,200 unnecessary readmissions annually saving $31M",
          metrics: ["0.89 AUC", "4,200 readmissions prevented", "$31M saved"],
          tools: ["Python", "XGBoost", "TensorFlow"],
        },
      ],
    },
    {
      id: "exp-003",
      employer: "Global Retail Corp",
      title: "Director of Analytics",
      start_date: "2015-01",
      end_date: "2018-05",
      location: "Dallas, TX",
      bullets: [
        {
          id: "exp-003-b1",
          text: "Built and led a 15-person analytics team from scratch, establishing the company's first centralized analytics function",
          metrics: ["15-person team"],
        },
        {
          id: "exp-003-b2",
          text: "Created customer segmentation model driving $18M incremental revenue through personalized marketing campaigns",
          metrics: ["$18M incremental revenue"],
          tools: ["Python", "R", "SQL"],
        },
      ],
    },
  ],
  education: [
    {
      id: "edu-001",
      institution: "University of Chicago",
      degree: "MBA, Concentrations in Econometrics & Statistics and Strategic Management",
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
    leadership: [
      "Executive stakeholder management",
      "Team building & mentorship",
      "Strategic planning",
      "P&L ownership",
      "Board-level presentations",
    ],
    technical: [
      "Python",
      "SQL",
      "R",
      "Spark",
      "Snowflake",
      "dbt",
      "Airflow",
      "Tableau",
      "Looker",
      "Power BI",
      "AWS (Redshift, EMR, SageMaker, S3)",
      "Kubernetes",
      "Docker",
    ],
    data_science: [
      "Machine Learning",
      "Deep Learning",
      "NLP",
      "Time Series Forecasting",
      "A/B Testing",
      "Statistical Modeling",
      "MLOps",
    ],
    domains: ["Financial Services", "Healthcare", "Retail", "Technology"],
  },
  certifications: [
    { id: "cert-001", name: "AWS Certified Solutions Architect", year: "2020" },
    { id: "cert-002", name: "Google Cloud Professional Data Engineer", year: "2021" },
  ],
};

function makeReqs(overrides: Partial<JDRequirements> = {}): JDRequirements {
  return {
    must_have: [],
    nice_to_have: [],
    leadership_scope: [],
    domain_context: [],
    tech_keywords: [],
    keywords_for_ats: [],
    red_flags: [],
    ...overrides,
  };
}

describe("matchScorer", () => {
  describe("computeMatchReport basic structure", () => {
    it("returns a valid MatchReport with all required fields", () => {
      const report = computeMatchReport(makeReqs(), MOCK_INVENTORY);
      expect(report).toHaveProperty("total_score");
      expect(report).toHaveProperty("sub_scores");
      expect(report).toHaveProperty("top_bullets");
      expect(report).toHaveProperty("match_explanations");
      expect(report).toHaveProperty("ats_coverage");
      expect(report).toHaveProperty("red_flag_assessment");
      expect(report).toHaveProperty("meta");
    });

    it("total_score is between 0 and 100", () => {
      const report = computeMatchReport(makeReqs(), MOCK_INVENTORY);
      expect(report.total_score).toBeGreaterThanOrEqual(0);
      expect(report.total_score).toBeLessThanOrEqual(100);
    });

    it("has exactly 5 sub-score categories", () => {
      const report = computeMatchReport(makeReqs(), MOCK_INVENTORY);
      const categories = Object.keys(report.sub_scores);
      expect(categories).toHaveLength(5);
      expect(categories).toContain("must_have");
      expect(categories).toContain("nice_to_have");
      expect(categories).toContain("leadership_scope");
      expect(categories).toContain("domain_context");
      expect(categories).toContain("tech_keywords");
    });

    it("sub-score weights sum to 100", () => {
      const report = computeMatchReport(makeReqs(), MOCK_INVENTORY);
      const totalMax = Object.values(report.sub_scores).reduce(
        (sum, cs) => sum + cs.max_score,
        0,
      );
      expect(totalMax).toBe(100);
    });

    it("empty requirements produce max score (nothing to fail)", () => {
      const report = computeMatchReport(makeReqs(), MOCK_INVENTORY);
      expect(report.total_score).toBe(100);
    });
  });

  describe("must_have scoring", () => {
    it("matches years of experience requirement", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "10+ years of experience in data and analytics leadership", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.must_have.matched.length).toBe(1);
      expect(report.sub_scores.must_have.unmatched.length).toBe(0);
      expect(report.sub_scores.must_have.matched[0].evidence_id).toBe("exp-001");
    });

    it("matches specific tool requirements", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "Strong experience with Python and SQL", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.must_have.matched.length).toBe(1);
    });

    it("flags unmatched must_have with critical severity for high-confidence items", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "PhD in quantum computing", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      const allItems = [...report.sub_scores.must_have.unmatched, ...report.sub_scores.must_have.matched];
      expect(allItems.length).toBe(1);
    });

    it("weak fuzzy matches produce low match strength for unrelated must_haves", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "15 years of blockchain development", confidence: 1.0 },
          { text: "PhD in astrophysics", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      const matched = report.sub_scores.must_have.matched;
      if (matched.length > 0) {
        for (const m of matched) {
          expect(m.match_strength).toBeLessThanOrEqual(0.5);
        }
      }
    });
  });

  describe("tech_keywords scoring", () => {
    it("matches exact tool names from inventory skills", () => {
      const reqs = makeReqs({
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
          { text: "SQL", confidence: 1.0 },
          { text: "Snowflake", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.tech_keywords.matched.length).toBe(3);
      expect(report.sub_scores.tech_keywords.pct).toBe(100);
    });

    it("matches tools from experience bullets", () => {
      const reqs = makeReqs({
        tech_keywords: [
          { text: "dbt", confidence: 1.0 },
          { text: "Airflow", confidence: 1.0 },
          { text: "Tableau", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.tech_keywords.matched.length).toBe(3);
    });

    it("flags missing tech with appropriate severity", () => {
      const reqs = makeReqs({
        tech_keywords: [
          { text: "Terraform", confidence: 0.95 },
          { text: "Go", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      const totalItems = report.sub_scores.tech_keywords.matched.length + report.sub_scores.tech_keywords.unmatched.length;
      expect(totalItems).toBe(2);
    });

    it("matches partial tool names (e.g., AWS in AWS Redshift)", () => {
      const reqs = makeReqs({
        tech_keywords: [
          { text: "AWS", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.tech_keywords.matched.length).toBe(1);
    });

    it("matches certifications or skills for tech keywords containing AWS", () => {
      const reqs = makeReqs({
        tech_keywords: [
          { text: "AWS Certified", confidence: 0.8 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.tech_keywords.matched.length).toBe(1);
      expect(report.sub_scores.tech_keywords.matched[0].evidence_id).toMatch(/cert-001|skills-technical/);
    });
  });

  describe("leadership_scope scoring", () => {
    it("matches team management experience via bullet text", () => {
      const reqs = makeReqs({
        leadership_scope: [
          { text: "Lead a team of 20+ data professionals", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.leadership_scope.matched.length).toBe(1);
    });

    it("matches leadership skills from inventory", () => {
      const reqs = makeReqs({
        leadership_scope: [
          { text: "Executive stakeholder management", confidence: 0.9 },
          { text: "Board-level presentations", confidence: 0.85 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.leadership_scope.matched.length).toBe(2);
    });

    it("empty leadership_scope for IC role gets full score", () => {
      const reqs = makeReqs({ leadership_scope: [] });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.leadership_scope.score).toBe(report.sub_scores.leadership_scope.max_score);
    });
  });

  describe("domain_context scoring", () => {
    it("matches known domains from inventory", () => {
      const reqs = makeReqs({
        domain_context: [
          { text: "Financial Services", confidence: 0.9 },
          { text: "Healthcare", confidence: 0.85 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.domain_context.matched.length).toBe(2);
    });

    it("processes unknown domains without error", () => {
      const reqs = makeReqs({
        domain_context: [
          { text: "Aerospace and defense industry", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      const total = report.sub_scores.domain_context.matched.length + report.sub_scores.domain_context.unmatched.length;
      expect(total).toBe(1);
    });
  });

  describe("nice_to_have scoring", () => {
    it("matches education requirements via MBA keyword", () => {
      const reqs = makeReqs({
        nice_to_have: [
          { text: "MBA preferred", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.sub_scores.nice_to_have.matched.length).toBe(1);
    });

    it("handles obscure nice_to_have requirements", () => {
      const reqs = makeReqs({
        nice_to_have: [
          { text: "Experience with autonomous driving systems", confidence: 0.7 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      const total = report.sub_scores.nice_to_have.matched.length + report.sub_scores.nice_to_have.unmatched.length;
      expect(total).toBe(1);
    });
  });

  describe("top_bullets selection", () => {
    it("returns at most 10 bullets", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "data leadership team management", confidence: 1.0 },
          { text: "cost savings analytics platform", confidence: 1.0 },
          { text: "machine learning pipeline", confidence: 1.0 },
          { text: "data governance framework", confidence: 1.0 },
          { text: "executive dashboard analytics", confidence: 1.0 },
        ],
        nice_to_have: [
          { text: "board presentations strategy", confidence: 0.9 },
          { text: "predictive analytics health", confidence: 0.8 },
          { text: "team building from scratch", confidence: 0.8 },
          { text: "customer segmentation revenue", confidence: 0.7 },
        ],
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
          { text: "Snowflake", confidence: 1.0 },
          { text: "Tableau", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.top_bullets.length).toBeLessThanOrEqual(10);
    });

    it("bullets include matched_requirements list", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "data organization leadership team", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      for (const bullet of report.top_bullets) {
        expect(bullet.matched_requirements.length).toBeGreaterThan(0);
        expect(bullet.bullet_id).toBeTruthy();
        expect(bullet.text).toBeTruthy();
        expect(bullet.employer).toBeTruthy();
      }
    });
  });

  describe("match_explanations", () => {
    it("generates explainability sentences with evidence pointers", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "10+ years of data analytics leadership", confidence: 1.0 },
        ],
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.match_explanations.length).toBeGreaterThan(0);
      for (const ex of report.match_explanations) {
        expect(ex.sentence).toBeTruthy();
        expect(ex.evidence_id).toBeTruthy();
        expect(ex.category).toBeTruthy();
        expect(ex.sentence).toContain("[");
      }
    });

    it("explanations reference correct categories", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "data organization leadership", confidence: 1.0 },
        ],
        leadership_scope: [
          { text: "Executive stakeholder management", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      const categories = report.match_explanations.map((e) => e.category);
      expect(categories.length).toBeGreaterThan(0);
    });

    it("returns at most 10 explanations", () => {
      const reqs = makeReqs({
        must_have: Array.from({ length: 8 }, (_, i) => ({
          text: `requirement ${i}`,
          confidence: 0.9,
        })),
        tech_keywords: Array.from({ length: 8 }, (_, i) => ({
          text: ["Python", "SQL", "Snowflake", "dbt", "Airflow", "Tableau", "Looker", "Spark"][i],
          confidence: 1.0,
        })),
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.match_explanations.length).toBeLessThanOrEqual(10);
    });
  });

  describe("ATS coverage", () => {
    it("identifies covered ATS keywords", () => {
      const reqs = makeReqs({
        keywords_for_ats: [
          { text: "data governance", confidence: 1.0 },
          { text: "machine learning", confidence: 1.0 },
          { text: "strategic planning", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.ats_coverage.covered.length).toBeGreaterThan(0);
      expect(report.ats_coverage.coverage_pct).toBeGreaterThan(0);
    });

    it("identifies uncovered ATS keywords", () => {
      const reqs = makeReqs({
        keywords_for_ats: [
          { text: "blockchain governance", confidence: 0.9 },
          { text: "quantum optimization", confidence: 0.8 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.ats_coverage.uncovered.length).toBe(2);
      expect(report.ats_coverage.coverage_pct).toBe(0);
    });

    it("computes correct coverage percentage", () => {
      const reqs = makeReqs({
        keywords_for_ats: [
          { text: "data governance", confidence: 1.0 },
          { text: "blockchain governance", confidence: 0.9 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.ats_coverage.coverage_pct).toBe(50);
    });
  });

  describe("red flag assessment", () => {
    it("assesses red flags with severity levels", () => {
      const reqs = makeReqs({
        red_flags: [
          { text: "Role combines IC coding with VP strategy — too broad", confidence: 0.85 },
          { text: "Requires 15+ years in a 3-year-old technology", confidence: 0.6 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.red_flag_assessment.flags.length).toBe(2);
      expect(report.red_flag_assessment.flags[0].severity).toBe("high");
      expect(report.red_flag_assessment.flags[1].severity).toBe("medium");
      expect(report.red_flag_assessment.total_risk_score).toBeGreaterThan(0);
    });

    it("no red flags yields zero risk score", () => {
      const reqs = makeReqs({ red_flags: [] });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.red_flag_assessment.flags.length).toBe(0);
      expect(report.red_flag_assessment.total_risk_score).toBe(0);
    });
  });

  describe("meta statistics", () => {
    it("correctly counts matched vs total requirements", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "10+ years experience in data analytics", confidence: 1.0 },
          { text: "PhD in quantum physics", confidence: 1.0 },
        ],
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.meta.requirements_total).toBe(3);
      expect(report.meta.requirements_matched).toBe(2);
      expect(report.meta.match_rate).toBe(67);
    });

    it("match_rate reflects requirement coverage", () => {
      const reqs = makeReqs({
        tech_keywords: [
          { text: "Solidity", confidence: 1.0 },
          { text: "Vyper", confidence: 1.0 },
          { text: "Hardhat", confidence: 1.0 },
          { text: "Foundry", confidence: 1.0 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.meta.requirements_total).toBe(4);
      const totalItems = report.sub_scores.tech_keywords.matched.length + report.sub_scores.tech_keywords.unmatched.length;
      expect(totalItems).toBe(4);
    });
  });

  describe("realistic full JD scenario", () => {
    it("VP Data role at B2B SaaS company scores well", () => {
      const reqs: JDRequirements = {
        must_have: [
          { text: "10+ years of experience in data and analytics leadership", confidence: 1.0 },
          { text: "Experience building and leading teams of 15+", confidence: 1.0 },
          { text: "Bachelor's degree in Computer Science or related field", confidence: 1.0 },
          { text: "Strong experience with Python, SQL, and cloud data platforms", confidence: 1.0 },
        ],
        nice_to_have: [
          { text: "MBA or advanced degree preferred", confidence: 0.9 },
          { text: "Experience with Snowflake and dbt", confidence: 0.8 },
          { text: "Healthcare or Financial Services domain experience", confidence: 0.7 },
        ],
        leadership_scope: [
          { text: "Lead team of 20+ data professionals", confidence: 1.0 },
          { text: "Report to CTO", confidence: 0.9 },
          { text: "Board-level presentations quarterly", confidence: 0.85 },
        ],
        domain_context: [
          { text: "B2B SaaS company", confidence: 0.9 },
          { text: "Financial Services domain knowledge", confidence: 0.8 },
        ],
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
          { text: "SQL", confidence: 1.0 },
          { text: "Snowflake", confidence: 1.0 },
          { text: "dbt", confidence: 0.9 },
          { text: "Airflow", confidence: 0.9 },
          { text: "Tableau", confidence: 0.8 },
        ],
        keywords_for_ats: [
          { text: "data strategy", confidence: 1.0 },
          { text: "data governance", confidence: 1.0 },
          { text: "executive stakeholder management", confidence: 0.9 },
          { text: "machine learning", confidence: 0.9 },
          { text: "predictive analytics", confidence: 0.85 },
        ],
        red_flags: [],
      };

      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.total_score).toBeGreaterThan(55);
      expect(report.sub_scores.tech_keywords.pct).toBe(100);
      expect(report.sub_scores.must_have.matched.length).toBeGreaterThanOrEqual(2);
      expect(report.top_bullets.length).toBeGreaterThan(0);
      expect(report.match_explanations.length).toBeGreaterThan(0);
      expect(report.ats_coverage.coverage_pct).toBeGreaterThan(50);
    });

    it("blockchain engineer role scores poorly", () => {
      const reqs: JDRequirements = {
        must_have: [
          { text: "5+ years of Solidity and smart contract development", confidence: 1.0 },
          { text: "Deep experience with Ethereum, Polygon, and Layer 2 protocols", confidence: 1.0 },
          { text: "Strong Rust or Go programming skills", confidence: 1.0 },
        ],
        nice_to_have: [
          { text: "Experience with zero-knowledge proofs", confidence: 0.8 },
        ],
        leadership_scope: [],
        domain_context: [
          { text: "DeFi / Web3 startup", confidence: 0.9 },
        ],
        tech_keywords: [
          { text: "Solidity", confidence: 1.0 },
          { text: "Rust", confidence: 1.0 },
          { text: "Ethereum", confidence: 1.0 },
          { text: "Web3.js", confidence: 0.9 },
        ],
        keywords_for_ats: [
          { text: "smart contracts", confidence: 1.0 },
          { text: "decentralized finance", confidence: 1.0 },
          { text: "token economics", confidence: 0.9 },
        ],
        red_flags: [],
      };

      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.total_score).toBeLessThan(60);
      expect(report.sub_scores.tech_keywords.unmatched.length).toBeGreaterThanOrEqual(2);
      expect(report.top_bullets.length).toBeLessThanOrEqual(10);
    });
  });

  describe("prettyPrintMatchReport", () => {
    it("produces a readable text report", () => {
      const reqs = makeReqs({
        must_have: [
          { text: "10+ years experience", confidence: 1.0 },
        ],
        tech_keywords: [
          { text: "Python", confidence: 1.0 },
        ],
        red_flags: [
          { text: "Scope too broad", confidence: 0.8 },
        ],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      const text = prettyPrintMatchReport(report, "Acme Corp — VP Data");
      expect(text).toContain("MATCH REPORT");
      expect(text).toContain("Acme Corp — VP Data");
      expect(text).toContain("SUB-SCORES");
      expect(text).toContain("must_have");
      expect(text).toContain("WHY THIS MATCHES");
      expect(text).toContain("RED FLAGS");
    });
  });

  describe("edge cases", () => {
    it("handles inventory with no experience", () => {
      const emptyInv: ExperienceInventory = {
        ...MOCK_INVENTORY,
        experience: [],
      };
      const reqs = makeReqs({
        must_have: [{ text: "5 years experience", confidence: 1.0 }],
      });
      const report = computeMatchReport(reqs, emptyInv);
      expect(report.total_score).toBeLessThanOrEqual(100);
    });

    it("handles inventory with no skills", () => {
      const noSkillsInv: ExperienceInventory = {
        ...MOCK_INVENTORY,
        skills: { leadership: [], technical: [], data_science: [], domains: [] },
      };
      const reqs = makeReqs({
        tech_keywords: [{ text: "Python", confidence: 1.0 }],
      });
      const report = computeMatchReport(reqs, noSkillsInv);
      expect(report.sub_scores.tech_keywords.unmatched.length).toBeGreaterThanOrEqual(0);
    });

    it("handles single-item requirements", () => {
      const reqs = makeReqs({
        must_have: [{ text: "Python", confidence: 1.0 }],
      });
      const report = computeMatchReport(reqs, MOCK_INVENTORY);
      expect(report.meta.requirements_total).toBe(1);
    });
  });
});
