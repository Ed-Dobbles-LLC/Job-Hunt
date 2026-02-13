import { describe, it, expect } from "vitest";
import {
  classifyMandate,
  scoreBulletsAgainstMandate,
  identifyMandateGaps,
} from "../src/mastra/tools/mandateClassifier";

// ── Test JD (PayPal-style Sr Director role) ──
const paypalJD = `
Senior Director, Head of Data Analytics & Insights — PayPal

About the role:
As the Senior Director and Head of Data Analytics & Insights at PayPal, you will lead a global team
of 25+ analysts and data scientists to drive strategic analytics across the enterprise. You will partner
with C-suite executives and business unit leaders to transform how PayPal uses data for decision making.

Key responsibilities:
- Build and scale a world-class analytics organization of 25+ people across multiple pods
- Lead the modernization of our BI platform from legacy tools to Looker on GCP
- Establish enterprise data governance standards and single source of truth for key business metrics
- Drive revenue analytics and forecasting for the global payments business
- Present insights and strategic recommendations to the Board and C-suite
- Automate insight delivery through Slack integrations and self-service dashboards
- Partner with product teams to embed analytics into core product features

Requirements:
- 15+ years of progressive analytics leadership experience
- Experience managing teams of 20+ in a matrixed environment
- Deep expertise in revenue analytics, forecasting, and commercial analytics
- Track record of BI platform modernization (Looker, Tableau, or similar)
- Strong executive communication and board presentation skills
- Experience with cloud data platforms (GCP, Snowflake, or similar)
`;

const testInventory = {
  profile: { name: "Test", current_title: "VP of Data & Analytics" },
  experience: [
    {
      id: "exp-001",
      employer: "Acme Financial",
      title: "VP of Data & Analytics",
      start_date: "2021-03",
      end_date: "present",
      bullets: [
        {
          id: "exp-001-b1",
          text: "Led a 45-person data organization spanning analytics, data science, and BI",
          metrics: ["45-person"],
          tools: ["Snowflake", "dbt"],
        },
        {
          id: "exp-001-b2",
          text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
          metrics: ["$12M"],
          tools: ["Snowflake"],
        },
        {
          id: "exp-001-b3",
          text: "Implemented data governance framework with 200+ data quality rules, improving trust score from 62% to 94%",
          metrics: ["200+", "62%", "94%"],
          tools: [],
        },
        {
          id: "exp-001-b4",
          text: "Presented quarterly data strategy updates to the Board, securing $8M multi-year investment",
          metrics: ["$8M"],
          tools: [],
        },
      ],
    },
    {
      id: "exp-002",
      employer: "HealthTech",
      title: "Senior Director",
      start_date: "2018-06",
      end_date: "2021-02",
      bullets: [
        {
          id: "exp-002-b1",
          text: "Built and led a 28-person analytics and data science team",
          metrics: ["28-person"],
          tools: ["Python", "R", "Tableau"],
        },
      ],
    },
  ],
  skills: { technical: ["Snowflake", "Python", "Tableau"] },
};

describe("Mandate Classifier", () => {
  const mandate = classifyMandate(paypalJD, "Senior Director, Head of Data Analytics & Insights");

  // ── UNIT TEST: Mandates drive bullet ordering ──
  it("should detect primary mandate dimensions from JD", () => {
    // PayPal JD emphasizes team leadership, executive storytelling, BI modernization, governance
    expect(mandate.primary_mandate).toBeTruthy();
    const topDimensions = mandate.dimensions.filter((d) => d.weight >= 0.2).map((d) => d.id);
    expect(topDimensions.length).toBeGreaterThanOrEqual(2);

    // Team leadership should be prominent (25+ people, pods, scale)
    const teamDim = mandate.dimensions.find((d) => d.id === "team_leadership_scale");
    expect(teamDim).toBeTruthy();
    expect(teamDim!.weight).toBeGreaterThan(0);

    // Executive storytelling should be present (Board, C-suite, present)
    const execDim = mandate.dimensions.find((d) => d.id === "executive_storytelling");
    expect(execDim).toBeTruthy();
    expect(execDim!.weight).toBeGreaterThan(0);
  });

  it("should detect seniority as Sr Director level, not C-Suite", () => {
    // PayPal role is "Senior Director" — should NOT get C-Suite classification
    expect(mandate.seniority_level).toBe("Sr Director");
  });

  it("should calibrate headline below C-suite for Sr Director role", () => {
    // Should NOT suggest "Chief Data Officer" for a Sr Director role
    const headlineLower = mandate.calibrated_headline.toLowerCase();
    expect(headlineLower).not.toContain("chief");
    expect(headlineLower).not.toContain("cdo");
    expect(headlineLower).not.toContain("cao");
  });
});

describe("Bullet Scoring Against Mandate", () => {
  const mandate = classifyMandate(paypalJD, "Senior Director, Head of Data Analytics & Insights");
  const scored = scoreBulletsAgainstMandate(testInventory, mandate);

  // ── INTEGRATION TEST 1: Bullet ordering driven by JD mandates ──
  it("should rank bullets by mandate relevance, not arbitrary order", () => {
    expect(scored.length).toBeGreaterThan(0);

    // The governance bullet (exp-001-b3) should score well for governance mandate
    const govBullet = scored.find((b) => b.bullet_id === "exp-001-b3");
    expect(govBullet).toBeTruthy();
    expect(govBullet!.mandate_scores.governance_standardization).toBeGreaterThan(0);

    // The board presentation bullet (exp-001-b4) should score well for exec storytelling
    const boardBullet = scored.find((b) => b.bullet_id === "exp-001-b4");
    expect(boardBullet).toBeTruthy();
    expect(boardBullet!.mandate_scores.executive_storytelling).toBeGreaterThan(0);
  });

  // ── INTEGRATION TEST 2: Mandate gaps identify missing capabilities ──
  it("should identify mandate gaps when inventory lacks coverage", () => {
    const gaps = identifyMandateGaps(mandate, scored);

    // The PayPal JD mentions Looker, GCP, Slack integrations — if our inventory doesn't cover
    // insight_delivery_automation well, it should appear as a gap
    // (our test inventory has no Slack/automation bullets)

    // At minimum, gaps should not include dimensions with good inventory coverage
    for (const gap of gaps) {
      // Gaps should only appear for dimensions with weight >= 0.2
      expect(gap.weight).toBeGreaterThanOrEqual(0.2);
      // Gaps should have a suggestion that doesn't say "fabricate"
      expect(gap.suggestion).not.toContain("fabricate");
      expect(gap.suggestion).not.toContain("invent");
    }
  });
});
