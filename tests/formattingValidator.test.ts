import { describe, it, expect } from "vitest";
import {
  checkDuplicateHeadings,
  checkPlaceholders,
  checkPageCount,
  checkMissingContactInfo,
  checkBrokenLinks,
  checkResumeSections,
  validateResumeFormatting,
  validateCoverLetterFormatting,
  validatePacketFormatting,
} from "../src/mastra/tools/formattingValidator";
import {
  renderResumeDocx,
  renderCoverLetterDocx,
} from "../src/mastra/tools/docxRenderer";
import type { TailoredResume } from "../src/mastra/tools/tailoredResumePrompt";
import type { TailoredCoverLetter } from "../src/mastra/tools/tailoredCoverLetterPrompt";

const sampleProfile = {
  name: "Ed Martinez",
  email: "ed.martinez@example.com",
  phone: "(555) 123-4567",
  location: "Chicago, IL",
  linkedin: "linkedin.com/in/edmartinez",
};

function makeSampleResume(): TailoredResume {
  return {
    target_role: "VP, Data & Analytics",
    target_company: "Ignite Reading",
    professional_summary:
      "Data executive with 15+ years leading enterprise data transformations.",
    experience: [
      {
        employer: "Acme Financial Group",
        title: "VP of Data & Analytics",
        start_date: "2021-03",
        end_date: "present",
        location: "Chicago, IL (Hybrid)",
        bullets: [
          {
            text: "Led a 45-person data organization spanning analytics engineering",
            source_hash: "exp-001-b1",
            evidence_quote: "Led a 45-person data organization",
          },
          {
            text: "Drove $12M annual cost savings by architecting a unified Snowflake platform",
            source_hash: "exp-001-b2",
            evidence_quote: "Drove $12M annual cost savings",
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
      { claim_text: "Led 45-person", source_hash: "exp-001-b1", evidence_quote: "Led 45", confidence: 0.95 },
    ],
    gap_notes: [],
    ats_keywords_used: ["data governance"],
  };
}

function makeSampleCoverLetter(): TailoredCoverLetter {
  return {
    target_role: "VP, Data & Analytics",
    target_company: "Ignite Reading",
    salutation: "Dear Hiring Manager,",
    opening_paragraph: "I am writing to express my interest in the VP of Data position.",
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
      { claim_text: "$12M cost savings", source_hash: "exp-001-b2", evidence_quote: "Drove $12M", confidence: 0.95 },
    ],
    gap_notes: [],
    company_research_todo: [],
    word_count: 280,
  };
}

describe("checkDuplicateHeadings", () => {
  it("returns no violations for unique headings", () => {
    const xml = `<w:t>EXPERIENCE</w:t><w:t>SKILLS</w:t><w:t>EDUCATION</w:t>`;
    expect(checkDuplicateHeadings(xml)).toHaveLength(0);
  });

  it("detects duplicate section headings", () => {
    const xml = `<w:t>EXPERIENCE</w:t><w:t>some text</w:t><w:t>EXPERIENCE</w:t>`;
    const violations = checkDuplicateHeadings(xml);
    expect(violations.length).toBe(1);
    expect(violations[0].check).toBe("DUPLICATE_HEADING");
    expect(violations[0].severity).toBe("critical");
    expect(violations[0].message).toContain("EXPERIENCE");
    expect(violations[0].message).toContain("2 times");
  });

  it("detects triple duplicate headings", () => {
    const xml = `<w:t>SKILLS</w:t><w:t>text</w:t><w:t>SKILLS</w:t><w:t>more</w:t><w:t>SKILLS</w:t>`;
    const violations = checkDuplicateHeadings(xml);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("3 times");
  });

  it("ignores short uppercase text", () => {
    const xml = `<w:t>VP</w:t><w:t>VP</w:t><w:t>IL</w:t>`;
    expect(checkDuplicateHeadings(xml)).toHaveLength(0);
  });
});

describe("checkPlaceholders", () => {
  it("returns no violations for clean text", () => {
    const xml = `<w:t>Led a 45-person data organization</w:t>`;
    expect(checkPlaceholders(xml)).toHaveLength(0);
  });

  it("detects mustache template variables", () => {
    const xml = `<w:t>Dear {{ company_name }}</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0].check).toBe("PLACEHOLDER");
    expect(violations[0].severity).toBe("critical");
  });

  it("detects template literal variables", () => {
    const xml = `<w:t>Position at \${company}</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects [INSERT] placeholders", () => {
    const xml = `<w:t>[INSERT COMPANY NAME HERE]</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects [YOUR] placeholders", () => {
    const xml = `<w:t>[YOUR NAME]</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects lorem ipsum text", () => {
    const xml = `<w:t>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.message.includes("Lorem ipsum"))).toBe(true);
  });

  it("detects [object Object] rendering bugs", () => {
    const xml = `<w:t>[object Object]</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects TODO markers", () => {
    const xml = `<w:t>TODO: add more details here</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects placeholder domains", () => {
    const xml = `<w:t>Visit example.com for more info</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects N/A and TBD placeholders", () => {
    const xml = `<w:t>Salary: N/A and start date TBD</w:t>`;
    const violations = checkPlaceholders(xml);
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it("respects allowlist for legitimate content", () => {
    const xml = `<w:t>ed.martinez@example.com</w:t>`;
    const violations = checkPlaceholders(xml, ["ed.martinez@example.com"]);
    const exampleDomainViolations = violations.filter(
      (v) => v.message.includes("example.com"),
    );
    expect(exampleDomainViolations).toHaveLength(0);
  });
});

describe("checkPageCount", () => {
  it("returns no violations for 1-page resume", () => {
    expect(checkPageCount(1, 2, "Resume")).toHaveLength(0);
  });

  it("returns no violations for 2-page resume", () => {
    expect(checkPageCount(2, 2, "Resume")).toHaveLength(0);
  });

  it("returns critical violation for 3-page resume", () => {
    const violations = checkPageCount(3, 2, "Resume");
    expect(violations.length).toBe(1);
    expect(violations[0].severity).toBe("critical");
    expect(violations[0].message).toContain("3 page");
    expect(violations[0].message).toContain("max 2");
  });

  it("returns critical violation for 2-page cover letter", () => {
    const violations = checkPageCount(2, 1, "Cover letter");
    expect(violations.length).toBe(1);
    expect(violations[0].severity).toBe("critical");
    expect(violations[0].message).toContain("2 page");
    expect(violations[0].message).toContain("max 1");
  });
});

describe("checkMissingContactInfo", () => {
  it("returns no violations when all contact info present", () => {
    const xml = `<w:t>Ed Martinez</w:t><w:t>ed.martinez@example.com</w:t><w:t>(555) 123-4567</w:t><w:t>Chicago, IL</w:t>`;
    const violations = checkMissingContactInfo(xml, sampleProfile);
    const nameViolations = violations.filter((v) => v.message.includes("name"));
    expect(nameViolations).toHaveLength(0);
  });

  it("detects missing candidate name", () => {
    const xml = `<w:t>Some other person</w:t>`;
    const violations = checkMissingContactInfo(xml, { name: "Ed Martinez" });
    expect(violations.some((v) => v.message.includes("Ed Martinez"))).toBe(true);
    expect(violations.find((v) => v.message.includes("name"))?.severity).toBe("critical");
  });

  it("detects missing email", () => {
    const xml = `<w:t>Ed Martinez</w:t><w:t>Chicago, IL</w:t>`;
    const violations = checkMissingContactInfo(xml, sampleProfile);
    expect(violations.some((v) => v.message.includes("Email"))).toBe(true);
  });

  it("detects missing phone", () => {
    const xml = `<w:t>Ed Martinez</w:t><w:t>ed.martinez@example.com</w:t>`;
    const violations = checkMissingContactInfo(xml, sampleProfile);
    expect(violations.some((v) => v.message.includes("Phone"))).toBe(true);
  });

  it("detects missing location", () => {
    const xml = `<w:t>Ed Martinez</w:t><w:t>ed.martinez@example.com</w:t><w:t>5551234567</w:t>`;
    const violations = checkMissingContactInfo(xml, sampleProfile);
    expect(violations.some((v) => v.message.includes("Location"))).toBe(true);
  });
});

describe("checkBrokenLinks", () => {
  it("returns no violations for text without URLs", () => {
    const xml = `<w:t>Regular text without any links</w:t>`;
    expect(checkBrokenLinks(xml)).toHaveLength(0);
  });

  it("detects localhost URLs", () => {
    const xml = `<w:t>Visit http://localhost:3000/test for more</w:t>`;
    const violations = checkBrokenLinks(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0].check).toBe("BROKEN_LINK");
  });

  it("detects example.com placeholder URLs", () => {
    const xml = `<w:t>See https://example.com/profile for details</w:t>`;
    const violations = checkBrokenLinks(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects 127.0.0.1 URLs", () => {
    const xml = `<w:t>API at http://127.0.0.1:8080/api</w:t>`;
    const violations = checkBrokenLinks(xml);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag legitimate external URLs", () => {
    const xml = `<w:t>Visit https://linkedin.com/in/edmartinez</w:t>`;
    const violations = checkBrokenLinks(xml);
    expect(violations).toHaveLength(0);
  });
});

describe("checkResumeSections", () => {
  it("returns no violations when all required sections present", () => {
    const xml = `
      <w:t>PROFESSIONAL SUMMARY</w:t>
      <w:t>some summary</w:t>
      <w:t>EXPERIENCE</w:t>
      <w:t>job details</w:t>
      <w:t>SKILLS</w:t>
      <w:t>Python, SQL</w:t>
      <w:t>EDUCATION</w:t>
      <w:t>MBA</w:t>
    `;
    expect(checkResumeSections(xml)).toHaveLength(0);
  });

  it("detects missing EXPERIENCE section", () => {
    const xml = `<w:t>PROFESSIONAL SUMMARY</w:t><w:t>SKILLS</w:t><w:t>EDUCATION</w:t>`;
    const violations = checkResumeSections(xml);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("EXPERIENCE");
    expect(violations[0].severity).toBe("critical");
  });

  it("detects missing SKILLS section", () => {
    const xml = `<w:t>PROFESSIONAL SUMMARY</w:t><w:t>EXPERIENCE</w:t><w:t>EDUCATION</w:t>`;
    const violations = checkResumeSections(xml);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("SKILLS");
  });

  it("detects multiple missing sections", () => {
    const xml = `<w:t>PROFESSIONAL SUMMARY</w:t>`;
    const violations = checkResumeSections(xml);
    expect(violations.length).toBe(3);
  });
});

describe("validateResumeFormatting (integration)", () => {
  it("passes for a clean resume", async () => {
    const buffer = await renderResumeDocx(makeSampleResume(), sampleProfile);
    const report = await validateResumeFormatting(buffer, sampleProfile);
    expect(report.documentType).toBe("resume");
    expect(report.checksRun).toBeGreaterThanOrEqual(5);
    expect(report.criticalCount).toBe(0);
    expect(report.pass).toBe(true);
  });

  it("fails when page count exceeds limit", async () => {
    const buffer = await renderResumeDocx(makeSampleResume(), sampleProfile);
    const report = await validateResumeFormatting(buffer, sampleProfile, 5);
    expect(report.pass).toBe(false);
    expect(report.criticalCount).toBeGreaterThanOrEqual(1);
    expect(report.violations.some((v) => v.check === "PAGE_COUNT")).toBe(true);
  });

  it("reports warnings for missing email in DOCX content", async () => {
    const buffer = await renderResumeDocx(makeSampleResume(), { name: "Ed Martinez" });
    const report = await validateResumeFormatting(buffer, {
      name: "Ed Martinez",
      email: "not.in.document@gmail.com",
    });
    expect(report.violations.some((v) => v.check === "MISSING_CONTACT" && v.message.includes("Email"))).toBe(true);
  });
});

describe("validateCoverLetterFormatting (integration)", () => {
  it("passes for a clean cover letter", async () => {
    const buffer = await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile);
    const report = await validateCoverLetterFormatting(buffer, sampleProfile);
    expect(report.documentType).toBe("cover_letter");
    expect(report.checksRun).toBeGreaterThanOrEqual(4);
    expect(report.criticalCount).toBe(0);
    expect(report.pass).toBe(true);
  });

  it("fails when cover letter exceeds 1 page", async () => {
    const buffer = await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile);
    const report = await validateCoverLetterFormatting(buffer, sampleProfile, 3);
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.check === "PAGE_COUNT")).toBe(true);
  });
});

describe("validatePacketFormatting (combined)", () => {
  it("passes when both documents are clean", async () => {
    const resumeBuffer = await renderResumeDocx(makeSampleResume(), sampleProfile);
    const coverBuffer = await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile);
    const report = await validatePacketFormatting(resumeBuffer, coverBuffer, sampleProfile);
    expect(report.pass).toBe(true);
    expect(report.blockSending).toBe(false);
    expect(report.totalCritical).toBe(0);
    expect(report.resumeReport.pass).toBe(true);
    expect(report.coverLetterReport.pass).toBe(true);
  });

  it("blocks sending when resume has critical violations", async () => {
    const resumeBuffer = await renderResumeDocx(makeSampleResume(), sampleProfile);
    const coverBuffer = await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile);
    const report = await validatePacketFormatting(resumeBuffer, coverBuffer, sampleProfile, 5);
    expect(report.pass).toBe(false);
    expect(report.blockSending).toBe(true);
  });

  it("includes page count violations from both documents", async () => {
    const resumeBuffer = await renderResumeDocx(makeSampleResume(), sampleProfile);
    const coverBuffer = await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile);
    const report = await validatePacketFormatting(resumeBuffer, coverBuffer, sampleProfile, 4, 3);
    expect(report.totalCritical).toBeGreaterThanOrEqual(2);
    const pageViolations = [
      ...report.resumeReport.violations,
      ...report.coverLetterReport.violations,
    ].filter((v) => v.check === "PAGE_COUNT");
    expect(pageViolations.length).toBe(2);
  });

  it("has correct timestamp format", async () => {
    const resumeBuffer = await renderResumeDocx(makeSampleResume(), sampleProfile);
    const coverBuffer = await renderCoverLetterDocx(makeSampleCoverLetter(), sampleProfile);
    const report = await validatePacketFormatting(resumeBuffer, coverBuffer, sampleProfile);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
