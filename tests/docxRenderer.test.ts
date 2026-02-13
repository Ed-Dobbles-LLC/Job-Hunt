import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  renderResumeDocx,
  renderCoverLetterDocx,
  checkPagination,
} from "../src/mastra/tools/docxRenderer";
import type { TailoredResume } from "../src/mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../src/mastra/tools/tailoredCoverLetterPrompt";

const sampleProfile = {
  name: "Ed Martinez",
  email: "ed@example.com",
  phone: "312-555-0100",
  location: "Chicago, IL",
  linkedin: "linkedin.com/in/edmartinez",
};

async function extractDocxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file("word/document.xml")!.async("string");
  return docXml;
}

function makeSampleResume(): TailoredResume {
  return {
    target_role: "VP, Data & Analytics",
    target_company: "Ignite Reading",
    professional_summary:
      "Data executive with 15+ years leading enterprise data transformations across financial services, healthcare, and technology sectors.",
    experience: [
      {
        employer: "Acme Financial Group",
        title: "VP of Data & Analytics",
        start_date: "2021-03",
        end_date: "present",
        location: "Chicago, IL (Hybrid)",
        bullets: [
          {
            text: "Led a 45-person data organization spanning analytics engineering, data science, and business intelligence across 3 business units",
            source_hash: "exp-001-b1",
            evidence_quote: "Led a 45-person data organization",
          },
          {
            text: "Drove $12M annual cost savings by architecting a unified data platform on Snowflake",
            source_hash: "exp-001-b2",
            evidence_quote: "Drove $12M annual cost savings",
          },
        ],
      },
      {
        employer: "HealthTech Solutions",
        title: "Director of Analytics",
        start_date: "2018-06",
        end_date: "2021-02",
        location: "Chicago, IL",
        bullets: [
          {
            text: "Built analytics team from 5 to 22 analysts",
            source_hash: "exp-002-b1",
            evidence_quote: "Built analytics team from 5 to 22",
          },
        ],
      },
    ],
    skills: {
      technical: ["Python", "SQL", "Snowflake"],
      leadership: ["Executive stakeholder management"],
      data_science: ["Machine Learning"],
    },
    education: [
      {
        institution: "University of Chicago Booth School of Business",
        degree: "MBA",
        year: "2010",
      },
    ],
    certifications: [
      { name: "AWS Certified Solutions Architect", year: "2020" },
    ],
    evidence_pointers: [
      { claim_text: "Led a 45-person", source_hash: "exp-001-b1", evidence_quote: "Led a 45-person", confidence: 0.95 },
      { claim_text: "$12M annual cost", source_hash: "exp-001-b2", evidence_quote: "$12M annual cost", confidence: 0.95 },
      { claim_text: "Built analytics team", source_hash: "exp-002-b1", evidence_quote: "Built analytics team", confidence: 0.9 },
    ],
    gap_notes: [],
    ats_keywords_used: ["data governance", "machine learning"],
  };
}

function makeSampleCoverLetter(): TailoredCoverLetter {
  return {
    target_role: "VP, Data & Analytics",
    target_company: "Ignite Reading",
    salutation: "Dear Hiring Manager,",
    opening_paragraph: "I am writing to express my interest in the VP of Data position at Ignite Reading.",
    body_paragraphs: [
      "At Acme Financial Group, I led a 45-person data organization and drove $12M in annual cost savings.",
    ],
    closing_paragraph: "I welcome the opportunity to discuss how my experience can contribute.",
    sign_off: "Sincerely,\nEd Martinez",
    value_claims: [
      {
        claim_sentence: "I drove $12M in annual cost savings.",
        source_hash: "exp-001-b2",
        evidence_quote: "Drove $12M annual cost savings",
        metric_used: "$12M",
      },
    ],
    evidence_pointers: [
      { claim_text: "$12M in annual cost savings", source_hash: "exp-001-b2", evidence_quote: "Drove $12M", confidence: 0.95 },
    ],
    gap_notes: [],
    company_research_todo: ["Research Ignite Reading"],
    word_count: 280,
  };
}

describe("renderResumeDocx", () => {
  it("produces a valid DOCX buffer (ZIP format)", async () => {
    const buffer = await renderResumeDocx(makeSampleResume(), sampleProfile);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it("does not contain [object Object]", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).not.toContain("[object Object]");
  });

  it("contains the candidate name", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    // Name is rendered uppercase in the DOCX header
    expect(xml).toContain("ED MARTINEZ");
  });

  it("contains EXECUTIVE SUMMARY heading exactly once", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    const matches = xml.match(/EXECUTIVE SUMMARY/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("contains PROFESSIONAL EXPERIENCE heading exactly once", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    const matches = xml.match(/PROFESSIONAL EXPERIENCE/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("contains SKILLS heading exactly once", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    const matches = xml.match(/>SKILLS</g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("contains employer names and job titles", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).toContain("Acme Financial Group");
    expect(xml).toContain("VP of Data");
    expect(xml).toContain("HealthTech Solutions");
  });

  it("contains bullet text not objects", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).toContain("45-person data organization");
    expect(xml).toContain("$12M annual cost savings");
  });

  it("contains skills as text strings", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).toContain("Python");
    expect(xml).toContain("SQL");
    expect(xml).toContain("Snowflake");
  });

  it("contains education", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).toContain("MBA");
    expect(xml).toContain("University of Chicago");
  });

  it("contains certifications", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).toContain("AWS Certified Solutions Architect");
  });

  it("formats dates as 'Mar 2021' not '2021-03'", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).toContain("Mar 2021");
    expect(xml).toContain("Present");
  });

  it("handles missing optional fields gracefully", async () => {
    const resume = makeSampleResume();
    delete (resume as any).certifications;
    delete (resume as any).skills.data_science;

    const buffer = await renderResumeDocx(resume, { name: "Jane Doe" });
    expect(buffer).toBeInstanceOf(Buffer);
    const xml = await extractDocxText(buffer);
    expect(xml).not.toContain("[object Object]");
    // Name is rendered uppercase in the DOCX header
    expect(xml).toContain("JANE DOE");
    expect(xml).not.toContain("CERTIFICATIONS");
  });

  it("renders skill categories with labels", async () => {
    const xml = await extractDocxText(
      await renderResumeDocx(makeSampleResume(), sampleProfile),
    );
    expect(xml).toContain("Technical");
    expect(xml).toContain("Leadership");
  });
});

describe("renderCoverLetterDocx", () => {
  it("produces a valid DOCX buffer", async () => {
    const buffer = await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it("does not contain [object Object]", async () => {
    const xml = await extractDocxText(
      await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile),
    );
    expect(xml).not.toContain("[object Object]");
  });

  it("contains salutation and body content", async () => {
    const xml = await extractDocxText(
      await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile),
    );
    expect(xml).toContain("Dear Hiring Manager");
    expect(xml).toContain("Ignite Reading");
    expect(xml).toContain("$12M");
    expect(xml).toContain("Sincerely");
    expect(xml).toContain("Ed Martinez");
  });

  it("contains subject line", async () => {
    const xml = await extractDocxText(
      await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile),
    );
    expect(xml).toContain("Re:");
    expect(xml).toContain("VP, Data");
  });

  it("contains today's year", async () => {
    const xml = await extractDocxText(
      await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile),
    );
    const year = new Date().getFullYear().toString();
    expect(xml).toContain(year);
  });
});

describe("checkPagination", () => {
  it("1 page within 2-page limit", () => {
    const r = checkPagination(1, 2);
    expect(r.withinLimit).toBe(true);
    expect(r.warning).toBeNull();
  });

  it("2 pages at 2-page limit with capacity warning", () => {
    const r = checkPagination(2, 2);
    expect(r.withinLimit).toBe(true);
    expect(r.warning).toContain("capacity");
  });

  it("3 pages exceeds 2-page limit", () => {
    const r = checkPagination(3, 2);
    expect(r.withinLimit).toBe(false);
    expect(r.warning).toContain("3 pages");
  });

  it("1 page at 1-page limit with capacity warning", () => {
    const r = checkPagination(1, 1);
    expect(r.withinLimit).toBe(true);
    expect(r.warning).toContain("capacity");
  });

  it("2 pages exceeds 1-page limit", () => {
    const r = checkPagination(2, 1);
    expect(r.withinLimit).toBe(false);
    expect(r.warning).toContain("2 pages");
  });
});

describe("safePrimitive guard against [object Object]", () => {
  it("bullet objects render as text not toString()", async () => {
    const resume = makeSampleResume();
    const xml = await extractDocxText(
      await renderResumeDocx(resume, sampleProfile),
    );
    expect(xml).not.toContain("[object Object]");
    expect(xml).toContain("45-person data organization");
  });

  it("null professional_summary does not crash", async () => {
    const resume = makeSampleResume();
    (resume as any).professional_summary = null;
    const buffer = await renderResumeDocx(resume, { name: "Test" });
    expect(buffer).toBeInstanceOf(Buffer);
  });
});
