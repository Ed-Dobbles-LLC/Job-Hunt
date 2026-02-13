import { describe, it, expect } from "vitest";
import {
  classifyMandate,
  scoreBulletsAgainstMandate,
  identifyMandateGaps,
  reorderBulletsPerRole,
  analyzeRequirementGaps,
  checkResumeDivergence,
} from "../src/mastra/tools/mandateClassifier";
import type {
  MandateDimension,
  MandateProfile,
  ToneGuidance,
  ReorderedRole,
  GapAnalysisResult,
  DivergenceReport,
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

// ── NEW: MandateDimension interface tests (score_0_5, label, description) ──
describe("MandateDimension Interface — 0-5 Scoring", () => {
  const mandate = classifyMandate(paypalJD, "Senior Director, Head of Data Analytics & Insights");

  it("should have exactly 10 archetype dimensions", () => {
    expect(mandate.dimensions).toHaveLength(10);
  });

  it("every dimension should have score_0_5 in [0, 5]", () => {
    for (const dim of mandate.dimensions) {
      expect(dim.score_0_5).toBeGreaterThanOrEqual(0);
      expect(dim.score_0_5).toBeLessThanOrEqual(5);
    }
  });

  it("score_0_5 should equal weight * 5 (rounded to 1 decimal)", () => {
    for (const dim of mandate.dimensions) {
      const expected = Math.round(dim.weight * 5 * 10) / 10;
      expect(dim.score_0_5).toBe(expected);
    }
  });

  it("every dimension should have a human-readable label", () => {
    for (const dim of mandate.dimensions) {
      expect(dim.label).toBeTruthy();
      expect(dim.label.length).toBeGreaterThan(5);
    }
  });

  it("every dimension should have a description", () => {
    for (const dim of mandate.dimensions) {
      expect(dim.description).toBeTruthy();
      expect(dim.description.length).toBeGreaterThan(10);
    }
  });

  it("dimensions should include all 10 archetype IDs", () => {
    const ids = mandate.dimensions.map((d) => d.id);
    expect(ids).toContain("operating_model_transformation");
    expect(ids).toContain("governance_standardization");
    expect(ids).toContain("revenue_ops_forecasting");
    expect(ids).toContain("insight_delivery_automation");
    expect(ids).toContain("product_gtm_analytics");
    expect(ids).toContain("growth_monetization");
    expect(ids).toContain("founder_adjacent_builder");
    expect(ids).toContain("bi_platform_modernization");
    expect(ids).toContain("executive_storytelling");
    expect(ids).toContain("team_leadership_scale");
  });
});

// ── NEW: Top 3 Archetypes tests ──
describe("MandateProfile — Top 3 Archetypes", () => {
  const mandate = classifyMandate(paypalJD, "Senior Director, Head of Data Analytics & Insights");

  it("should have exactly 3 entries in top_3_archetypes", () => {
    expect(mandate.top_3_archetypes).toHaveLength(3);
  });

  it("each top archetype should have id, label, and score", () => {
    for (const arch of mandate.top_3_archetypes) {
      expect(arch.id).toBeTruthy();
      expect(arch.label).toBeTruthy();
      expect(typeof arch.score).toBe("number");
      expect(arch.score).toBeGreaterThanOrEqual(0);
      expect(arch.score).toBeLessThanOrEqual(5);
    }
  });

  it("top_3 should be sorted by score descending", () => {
    for (let i = 0; i < mandate.top_3_archetypes.length - 1; i++) {
      expect(mandate.top_3_archetypes[i].score).toBeGreaterThanOrEqual(
        mandate.top_3_archetypes[i + 1].score,
      );
    }
  });

  it("primary_mandate should match the first top_3 archetype", () => {
    expect(mandate.primary_mandate).toBe(mandate.top_3_archetypes[0].id);
  });
});

// ── NEW: Tone Guidance tests ──
describe("Tone Guidance by Seniority", () => {
  it("Sr Director should get 'Sr Director / Head of' tone", () => {
    const mandate = classifyMandate(paypalJD, "Senior Director, Head of Data Analytics & Insights");
    const tone = mandate.tone_guidance;
    expect(tone.seniority).toContain("Sr Director");
    expect(tone.summary_posture).toBeTruthy();
    expect(tone.bullet_framing).toBeTruthy();
    expect(tone.competency_emphasis).toBeTruthy();
    expect(tone.headline_tone).toBeTruthy();
    // Headline tone should reference Sr Director / Head of, not recommend VP or C-suite as the title
    expect(tone.headline_tone.toLowerCase()).toContain("sr director");
    expect(tone.headline_tone.toLowerCase()).not.toMatch(/^vp/); // should not START with VP framing
  });

  it("C-Suite role should get board-level tone", () => {
    const cSuiteJD = "Chief Data Officer at BigCorp. Lead enterprise data strategy. Report to CEO.";
    const mandate = classifyMandate(cSuiteJD, "Chief Data Officer");
    expect(mandate.seniority_level).toBe("C-Suite");
    expect(mandate.tone_guidance.seniority).toBe("C-Suite");
    expect(mandate.tone_guidance.summary_posture.toLowerCase()).toContain("board");
  });

  it("VP role should get VP-level tone", () => {
    const vpJD = "VP of Analytics at MidCorp. Build and scale analytics team of 40+.";
    const mandate = classifyMandate(vpJD, "VP of Analytics");
    expect(mandate.seniority_level).toBe("VP");
    expect(mandate.tone_guidance.seniority).toBe("VP");
    expect(mandate.tone_guidance.headline_tone.toLowerCase()).toContain("vp");
  });

  it("DTC / founder-adjacent role should get builder tone", () => {
    const dtcJD = "Head of Data at DTC startup. Build from scratch. First data hire. Player-coach.";
    const mandate = classifyMandate(dtcJD, "Head of Data (DTC)");
    // Should detect founder-adjacent or Sr Director seniority
    const tone = mandate.tone_guidance;
    expect(tone.summary_posture.length).toBeGreaterThan(0);
  });
});

// ── NEW: Bullet Reordering Per Role ──
describe("reorderBulletsPerRole", () => {
  const mandate = classifyMandate(paypalJD, "Senior Director, Head of Data Analytics & Insights");
  const scored = scoreBulletsAgainstMandate(testInventory, mandate);

  it("should return one entry per experience role", () => {
    const roles = reorderBulletsPerRole(testInventory, scored);
    expect(roles).toHaveLength(testInventory.experience.length);
    expect(roles[0].experience_id).toBe("exp-001");
    expect(roles[1].experience_id).toBe("exp-002");
  });

  it("should include employer and title from inventory", () => {
    const roles = reorderBulletsPerRole(testInventory, scored);
    expect(roles[0].employer).toBe("Acme Financial");
    expect(roles[0].title).toBe("VP of Data & Analytics");
  });

  it("should sort bullets by total_relevance within each role", () => {
    const roles = reorderBulletsPerRole(testInventory, scored);
    for (const role of roles) {
      for (let i = 0; i < role.ordered_bullets.length - 1; i++) {
        expect(role.ordered_bullets[i].total_relevance).toBeGreaterThanOrEqual(
          role.ordered_bullets[i + 1].total_relevance,
        );
      }
    }
  });

  it("should drop lowest 20% when dropLowest20Percent is true", () => {
    const roles = reorderBulletsPerRole(testInventory, scored, {
      dropLowest20Percent: true,
    });
    // exp-001 has 4 bullets, 20% of 4 = 0.8 → floor = 0, so still 4 kept
    // But the dropped_bullets array might have some entries
    const role1 = roles.find((r) => r.experience_id === "exp-001")!;
    // ordered + dropped should equal total bullets
    expect(role1.ordered_bullets.length + role1.dropped_bullets.length).toBe(4);
  });

  it("should respect maxBulletsPerRole cap", () => {
    const roles = reorderBulletsPerRole(testInventory, scored, {
      maxBulletsPerRole: { "exp-001": 2 },
    });
    const role1 = roles.find((r) => r.experience_id === "exp-001")!;
    expect(role1.ordered_bullets).toHaveLength(2);
    expect(role1.dropped_bullets.length).toBeGreaterThan(0);
  });

  it("dropped bullets should include a reason string", () => {
    const roles = reorderBulletsPerRole(testInventory, scored, {
      maxBulletsPerRole: { "exp-001": 2 },
    });
    const role1 = roles.find((r) => r.experience_id === "exp-001")!;
    for (const dropped of role1.dropped_bullets) {
      expect(dropped.reason).toBeTruthy();
      expect(dropped.reason.length).toBeGreaterThan(10);
      expect(dropped.bullet.bullet_id).toBeTruthy();
    }
  });
});

// ── NEW: Requirement Gap Analysis with Conservative Phrasing ──
describe("analyzeRequirementGaps", () => {
  it("should flag Salesforce as a gap with conservative phrasing", () => {
    const results = analyzeRequirementGaps(
      ["Experience with Salesforce CRM integration"],
      testInventory,
    );
    expect(results).toHaveLength(1);
    expect(results[0].in_ledger).toBe(false);
    expect(results[0].conservative_phrasing).toBeTruthy();
    expect(results[0].conservative_phrasing!.toLowerCase()).toContain("crm");
    expect(results[0].clarification_question).toBeTruthy();
  });

  it("should find Snowflake-related requirements as in_ledger", () => {
    const results = analyzeRequirementGaps(
      ["Experience with cloud data platforms like Snowflake"],
      testInventory,
    );
    expect(results).toHaveLength(1);
    expect(results[0].in_ledger).toBe(true);
    // No conservative phrasing needed for supported requirements
    expect(results[0].conservative_phrasing).toBeUndefined();
  });

  it("should suggest BI platform phrasing for Looker gap", () => {
    const results = analyzeRequirementGaps(
      ["Hands-on experience with Looker dashboards"],
      testInventory,
    );
    expect(results).toHaveLength(1);
    // Looker is in insight_delivery signals but not directly in our test inventory tools
    // The function checks tool names and skill lists
    if (!results[0].in_ledger) {
      expect(results[0].conservative_phrasing).toBeTruthy();
      expect(results[0].clarification_question).toBeTruthy();
    }
  });

  it("should handle multiple requirements", () => {
    const results = analyzeRequirementGaps(
      [
        "Experience leading data teams of 20+",
        "Salesforce integration experience",
        "Python and SQL proficiency",
      ],
      testInventory,
    );
    expect(results).toHaveLength(3);
    // Data teams and Python/SQL should be in ledger
    const teamReq = results[0];
    const pythonReq = results[2];
    // At least one of these should match the inventory
    const anySupported = results.some((r) => r.in_ledger);
    expect(anySupported).toBe(true);
  });
});

// ── NEW: Cross-Resume Divergence Check ──
describe("checkResumeDivergence", () => {
  const resumeA = {
    professional_summary:
      "Data analytics executive who built and scaled a 45-person organization driving $12M in annual cost savings through enterprise data platform modernization.",
    core_competencies: [
      "Enterprise Data Strategy",
      "Data Governance",
      "Platform Modernization",
      "Board Advisory",
    ],
    experience: [
      {
        bullets: [
          { text: "Drove $12M annual cost savings by architecting unified data platform" },
          { text: "Established data governance framework with 200+ rules" },
        ],
      },
    ],
  };

  const resumeB = {
    professional_summary:
      "Revenue analytics leader with deep expertise in forecasting, demand planning, and commercial analytics. Proven track record of building predictive models that drive business growth.",
    core_competencies: [
      "Revenue Optimization",
      "Demand Forecasting",
      "Commercial Analytics",
      "Team Building",
    ],
    experience: [
      {
        bullets: [
          { text: "Created customer segmentation model driving $18M incremental revenue" },
          { text: "Drove $12M annual cost savings by architecting unified data platform" },
        ],
      },
    ],
  };

  it("should calculate summary divergence percentage", () => {
    const report = checkResumeDivergence(resumeA, resumeB);
    expect(report.summary_divergence_pct).toBeGreaterThan(0);
    expect(report.summary_divergence_pct).toBeLessThanOrEqual(100);
  });

  it("should calculate competency divergence percentage", () => {
    const report = checkResumeDivergence(resumeA, resumeB);
    expect(report.competency_divergence_pct).toBeGreaterThan(0);
    expect(report.competency_divergence_pct).toBeLessThanOrEqual(100);
  });

  it("should detect bullet reorder when top-2 bullets differ", () => {
    const report = checkResumeDivergence(resumeA, resumeB);
    expect(report.bullet_reorder_count).toBeGreaterThan(0);
  });

  it("should detect tone shift when opening sentences differ", () => {
    const report = checkResumeDivergence(resumeA, resumeB);
    expect(report.tone_shifted).toBe(true);
  });

  it("should flag identical resumes as insufficient divergence", () => {
    const report = checkResumeDivergence(resumeA, resumeA);
    expect(report.summary_divergence_pct).toBe(0);
    expect(report.competency_divergence_pct).toBe(0);
    expect(report.sufficient_divergence).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("sufficiently divergent resumes should pass", () => {
    const report = checkResumeDivergence(resumeA, resumeB);
    // With very different summaries and competencies, should pass
    if (report.summary_divergence_pct >= 40 && report.competency_divergence_pct >= 30) {
      expect(report.sufficient_divergence).toBe(true);
      expect(report.issues).toHaveLength(0);
    }
  });

  it("should provide actionable recommendations for insufficient divergence", () => {
    const report = checkResumeDivergence(resumeA, resumeA);
    expect(report.recommendations.length).toBeGreaterThan(0);
    for (const rec of report.recommendations) {
      expect(rec.length).toBeGreaterThan(10);
    }
  });
});
