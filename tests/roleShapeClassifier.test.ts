import { describe, it, expect } from "vitest";
import {
  classifyRoleShape,
  type RoleShapeResult,
} from "../src/mastra/tools/roleShapeClassifier";

function makeJob(title: string, jd: string) {
  return { title, jd_raw_text: jd };
}

describe("RoleShape Classifier", () => {
  describe("Shape A: Strategy-Led AI/Data Leadership", () => {
    it("classifies strategy-led SVP as Shape A", () => {
      const job = makeJob(
        "SVP, Data & AI",
        `
        Define the enterprise AI strategy and data roadmap. Drive digital transformation
        and adoption across the portfolio. Present to executive stakeholders and the board.
        Own the operating model for AI initiatives. Deliver measurable ROI through
        strategic vision and cross-functional collaboration. Lead a team of 40+.
        Budget and P&L ownership. Change management and innovation agenda.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("A");
      expect(r.confidence).toBeGreaterThanOrEqual(0.6);
      expect(r.label).toBe("Strategy-Led AI/Data Leadership");
      expect(r.signals.strategy.length).toBeGreaterThanOrEqual(3);
      expect(r.signals.leadership.length).toBeGreaterThanOrEqual(2);
      expect(r.signals.engineering.length).toBeLessThanOrEqual(2);
    });

    it("classifies VP Data Strategy as Shape A", () => {
      const job = makeJob(
        "VP of Data Strategy",
        `
        Lead data strategy and business value creation. Own the analytics roadmap,
        transformation initiatives, and executive stakeholder management. Board-level
        presentations. Build and mentor a team. Budget oversight.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("A");
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe("Shape B: Hybrid Strategy + Engineering", () => {
    it("classifies hybrid VP as Shape B", () => {
      const job = makeJob(
        "VP of AI Platform & Strategy",
        `
        Own the AI strategy and roadmap while also overseeing platform engineering.
        Lead transformation initiatives and executive stakeholder engagement.
        Manage CI/CD pipelines, MLOps infrastructure, Kubernetes deployments,
        and model serving. Board presentations and ROI delivery.
        Build and scale the engineering organization. Budget and P&L ownership.
        Monitor SLAs and system scalability.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("B");
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      expect(r.label).toBe("Hybrid Strategy + Engineering");
      expect(r.signals.strategy.length).toBeGreaterThanOrEqual(3);
      expect(r.signals.engineering.length).toBeGreaterThanOrEqual(3);
    });

    it("classifies mixed Head of Data as Shape B", () => {
      const job = makeJob(
        "Head of Data & AI",
        `
        Drive AI strategy, roadmap, and digital transformation. Also architect and
        deploy ML pipelines, MLOps infrastructure, and monitoring systems.
        Cross-functional collaboration and adoption. Lead a team of 25+.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("B");
    });
  });

  describe("Shape C: Analytics/BI Leadership", () => {
    it("classifies BI Director as Shape C", () => {
      const job = makeJob(
        "Director of Business Intelligence",
        `
        Lead the BI team responsible for dashboards, reporting, and data visualization.
        Own KPIs, metrics, executive reporting, and self-service analytics.
        Manage Tableau and Power BI implementations. Data governance and data quality
        oversight. Build data catalog. Ad-hoc analysis for business stakeholders.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("C");
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      expect(r.label).toBe("Analytics/BI Leadership");
      expect(r.signals.analytics.length).toBeGreaterThanOrEqual(3);
    });

    it("classifies analytics director as Shape C", () => {
      const job = makeJob(
        "Director, Analytics",
        `
        Own reporting and dashboards for the executive team. Drive data quality
        initiatives and self-service analytics adoption. Manage a team of analysts.
        Looker and Tableau expertise required.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("C");
    });
  });

  describe("Shape D: Engineering/Platform/IC-Heavy", () => {
    it("classifies ML Platform VP as Shape D", () => {
      const job = makeJob(
        "VP of ML Platform",
        `
        Build and own the ML platform including CI/CD pipelines, MLOps, Kubernetes
        clusters, model serving, monitoring, infrastructure, and deployment automation.
        Architect distributed systems for scalability and low latency. Manage SLAs
        and DevOps practices. Design APIs and microservices.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("D");
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      expect(r.label).toBe("Engineering/Platform/IC-Heavy");
      expect(r.signals.engineering.length).toBeGreaterThanOrEqual(4);
    });

    it("classifies Staff ML Engineer as Shape D", () => {
      const job = makeJob(
        "Staff Engineer, ML Infrastructure",
        `
        Design and implement ML infrastructure including deployment pipelines,
        model serving, feature stores, and monitoring. Work with Kubernetes,
        distributed systems, and microservices architecture.
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("D");
    });
  });

  describe("Edge Cases", () => {
    it("empty JD defaults to C with low confidence", () => {
      const job = makeJob("Manager", "");
      const r = classifyRoleShape(job);
      expect(r.shape).toBe("C");
      expect(r.confidence).toBeLessThanOrEqual(0.4);
    });

    it("minimal signals classified with low confidence", () => {
      const job = makeJob(
        "VP of Something",
        "Great opportunity at a leading company.",
      );
      const r = classifyRoleShape(job);
      expect(r.confidence).toBeLessThanOrEqual(0.5);
    });
  });

  describe("Deterministic Ordering", () => {
    it("same input produces same output", () => {
      const job = makeJob(
        "SVP, Data & AI",
        `
        Strategy roadmap transformation adoption board executive stakeholders ROI
        CI/CD pipelines MLOps deployment monitoring Kubernetes infrastructure platform
        dashboards reporting KPIs metrics Tableau
        lead a team build a team manage direct reports budget P&L
      `,
      );
      const r1 = classifyRoleShape(job);
      const r2 = classifyRoleShape(job);
      expect(r1.shape).toBe(r2.shape);
      expect(r1.confidence).toBe(r2.confidence);
      expect(r1.signals.strategy).toEqual([...r1.signals.strategy].sort());
      expect(r1.signals.engineering).toEqual(
        [...r1.signals.engineering].sort(),
      );
      expect(r1.signals.analytics).toEqual([...r1.signals.analytics].sort());
      expect(r1.signals.leadership).toEqual([...r1.signals.leadership].sort());
    });
  });

  describe("Confidence Ranges", () => {
    it("strong A confidence >= 0.8", () => {
      const r = classifyRoleShape(
        makeJob(
          "SVP Data & AI",
          `
        AI strategy roadmap operating model transformation adoption portfolio
        executive stakeholders board ROI strategic vision cross-functional
        enterprise-wide center of excellence change management innovation agenda
        lead a team direct reports budget P&L executive c-suite hire mentor
      `,
        ),
      );
      expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("weak A confidence < 0.7 but still classified as A", () => {
      const r = classifyRoleShape(
        makeJob(
          "Director Analytics",
          "Data strategy and roadmap. Manage team.",
        ),
      );
      expect(r.confidence).toBeLessThanOrEqual(0.7);
      expect(r.shape).toBe("A");
    });
  });

  describe("Signals Capped at 5", () => {
    it("strategy signals capped at 5", () => {
      const job = makeJob(
        "SVP",
        `
        roadmap strategy business value operating model adoption portfolio
        executive stakeholders board roi strategic vision go-to-market
        innovation agenda center of excellence change management enterprise-wide
      `,
      );
      const r = classifyRoleShape(job);
      expect(r.signals.strategy.length).toBeLessThanOrEqual(5);
    });
  });
});
