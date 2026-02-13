import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  TabStopPosition,
  TabStopType,
  BorderStyle,
  convertInchesToTwip,
  PageBreak,
} from "docx";
import type { TailoredResume } from "./tailoredResumePrompt";
import type { TailoredCoverLetter } from "./tailoredCoverLetterPrompt";

const FONT = "Calibri";
const NAME_SIZE = 28;
const HEADLINE_SIZE = 22;
const CONTACT_SIZE = 18;
const HEADING_SIZE = 22;
const BODY_SIZE = 20;
const SUB_HEADING_SIZE = 20;
const COMPETENCY_SIZE = 19;
const BULLET_INDENT = convertInchesToTwip(0.25);
const SECTION_SPACING_AFTER = 60;
const BULLET_SPACING_AFTER = 40;
const PARAGRAPH_SPACING_AFTER = 80;
const ROLE_SPACING_BEFORE = 120;

const PAGE_MARGIN_TOP = convertInchesToTwip(0.6);
const PAGE_MARGIN_BOTTOM = convertInchesToTwip(0.6);
const PAGE_MARGIN_LEFT = convertInchesToTwip(0.7);
const PAGE_MARGIN_RIGHT = convertInchesToTwip(0.7);

function safePrimitive(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        size: HEADING_SIZE,
        font: FONT,
        color: "2B2B2B",
      }),
    ],
    spacing: { before: 160, after: SECTION_SPACING_AFTER },
    border: {
      bottom: {
        color: "999999",
        space: 1,
        style: BorderStyle.SINGLE,
        size: 4,
      },
    },
  });
}

function formatDateRange(start: string, end: string): string {
  const formatDate = (d: string): string => {
    if (d.toLowerCase() === "present") return "Present";
    const parts = d.match(/(\d{4})-(\d{2})/);
    if (!parts) return safePrimitive(d);
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${months[parseInt(parts[2]) - 1] || parts[2]} ${parts[1]}`;
  };
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export async function renderResumeDocx(
  resume: TailoredResume,
  profile: {
    name: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
  },
): Promise<Buffer> {
  const children: Paragraph[] = [];
  const renderedSections = new Set<string>();

  // ── Name ──
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: safePrimitive(profile.name).toUpperCase(),
          bold: true,
          size: NAME_SIZE,
          font: FONT,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 10 },
    }),
  );

  // ── Executive Headline ──
  const headline = (resume as any).executive_headline;
  if (headline) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: safePrimitive(headline),
            size: HEADLINE_SIZE,
            font: FONT,
            color: "333333",
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 10 },
      }),
    );
  }

  // ── Contact Info ──
  const contactParts = [
    profile.location,
    profile.phone,
    profile.email,
    profile.linkedin,
  ].filter(Boolean);

  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: contactParts.map(safePrimitive).join("  |  "),
            size: CONTACT_SIZE,
            font: FONT,
            color: "555555",
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
      }),
    );
  }

  // ── Executive Summary ──
  if (resume.professional_summary && !renderedSections.has("SUMMARY")) {
    renderedSections.add("SUMMARY");
    children.push(sectionHeading("Executive Summary"));
    // Support multi-paragraph summaries (paragraphs separated by \n\n)
    const summaryText = safePrimitive(resume.professional_summary);
    const summaryParagraphs = summaryText.split(/\n\n+/).filter((p) => p.trim());
    for (const para of summaryParagraphs) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: para.trim(),
              size: BODY_SIZE,
              font: FONT,
            }),
          ],
          spacing: { after: PARAGRAPH_SPACING_AFTER },
        }),
      );
    }
  }

  // ── Core Competencies ──
  const coreCompetencies = (resume as any).core_competencies;
  if (
    Array.isArray(coreCompetencies) &&
    coreCompetencies.length > 0 &&
    !renderedSections.has("COMPETENCIES")
  ) {
    renderedSections.add("COMPETENCIES");
    children.push(sectionHeading("Core Competencies"));

    // Render as rows of 3 separated by pipes for clean ATS-friendly grid
    const items = coreCompetencies.map(safePrimitive);
    const rowSize = 3;
    for (let i = 0; i < items.length; i += rowSize) {
      const row = items.slice(i, i + rowSize);
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: row.join("    |    "),
              size: COMPETENCY_SIZE,
              font: FONT,
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 30 },
        }),
      );
    }
    // Add spacing after the competencies block
    children.push(
      new Paragraph({
        children: [],
        spacing: { after: 40 },
      }),
    );
  }

  // ── Experience ──
  if (resume.experience?.length > 0 && !renderedSections.has("EXPERIENCE")) {
    renderedSections.add("EXPERIENCE");
    children.push(sectionHeading("Professional Experience"));

    for (const exp of resume.experience) {
      // Role title (bold) | Company (bold)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: safePrimitive(exp.title),
              bold: true,
              size: BODY_SIZE,
              font: FONT,
            }),
            new TextRun({
              text: "  |  ",
              size: BODY_SIZE,
              font: FONT,
              color: "999999",
            }),
            new TextRun({
              text: safePrimitive(exp.employer),
              bold: true,
              size: BODY_SIZE,
              font: FONT,
            }),
          ],
          spacing: { before: ROLE_SPACING_BEFORE, after: 20 },
        }),
      );

      // Location | Date Range
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${safePrimitive(exp.location)}  |  ${formatDateRange(exp.start_date, exp.end_date)}`,
              italics: true,
              size: SUB_HEADING_SIZE - 2,
              font: FONT,
              color: "666666",
            }),
          ],
          spacing: { after: 20 },
        }),
      );

      // Scope line (enterprise context)
      const scopeLine = (exp as any).scope_line;
      if (scopeLine) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: safePrimitive(scopeLine),
                italics: true,
                size: SUB_HEADING_SIZE - 2,
                font: FONT,
                color: "444444",
              }),
            ],
            spacing: { after: 40 },
          }),
        );
      }

      // Bullets
      for (const bullet of exp.bullets) {
        const bulletText =
          typeof bullet === "string"
            ? bullet
            : safePrimitive(bullet?.text ?? bullet);
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `•  ${bulletText}`,
                size: BODY_SIZE,
                font: FONT,
              }),
            ],
            indent: { left: BULLET_INDENT },
            spacing: { after: BULLET_SPACING_AFTER },
          }),
        );
      }
    }
  }

  // ── Skills / Tools ──
  // PRIORITY 3 rule: Do NOT output both "Core Competencies" and "Enterprise Capabilities"
  // if they overlap. When core_competencies exists, only render Tools & Platforms here.
  const skills = resume.skills as any;
  if (skills && !renderedSections.has("SKILLS")) {
    const enterpriseCaps = skills.enterprise_capabilities || skills.technical || [];
    const toolsAndPlatforms = skills.tools_and_platforms || [];
    const leadership = skills.leadership || [];
    const dataScience = skills.data_science || [];

    const hasNewFormat = skills.enterprise_capabilities !== undefined;
    const hasCoreCompetencies = renderedSections.has("COMPETENCIES");

    if (hasNewFormat) {
      // If Core Competencies was already rendered, skip enterprise_capabilities
      // to avoid redundancy. Only render Tools & Platforms.
      if (hasCoreCompetencies) {
        if (toolsAndPlatforms.length > 0) {
          renderedSections.add("SKILLS");
          children.push(sectionHeading("Tools & Platforms"));
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: toolsAndPlatforms.map(safePrimitive).join(",  "),
                  size: BODY_SIZE,
                  font: FONT,
                }),
              ],
              spacing: { after: BULLET_SPACING_AFTER },
            }),
          );
        }
      } else {
        // No core competencies section — render both enterprise capabilities and tools
        if (enterpriseCaps.length > 0 || toolsAndPlatforms.length > 0) {
          renderedSections.add("SKILLS");
          children.push(sectionHeading("Enterprise Capabilities & Tools"));

          if (enterpriseCaps.length > 0) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Enterprise Capabilities: ",
                    bold: true,
                    size: BODY_SIZE,
                    font: FONT,
                  }),
                  new TextRun({
                    text: enterpriseCaps.map(safePrimitive).join(",  "),
                    size: BODY_SIZE,
                    font: FONT,
                  }),
                ],
                spacing: { after: BULLET_SPACING_AFTER },
              }),
            );
          }

          if (toolsAndPlatforms.length > 0) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Tools & Platforms: ",
                    bold: true,
                    size: BODY_SIZE,
                    font: FONT,
                  }),
                  new TextRun({
                    text: toolsAndPlatforms.map(safePrimitive).join(",  "),
                    size: BODY_SIZE,
                    font: FONT,
                  }),
                ],
                spacing: { after: BULLET_SPACING_AFTER },
              }),
            );
          }
        }
      }
    } else {
      // Legacy format — backward compatible
      const allSkills: string[] = [];
      if (Array.isArray(resume.skills)) {
        allSkills.push(...(resume.skills as any[]).map(safePrimitive));
      } else if (typeof resume.skills === "object") {
        const s = resume.skills as Record<string, unknown>;
        for (const category of ["technical", "leadership", "data_science"]) {
          const arr = s[category];
          if (Array.isArray(arr)) {
            allSkills.push(...arr.map(safePrimitive));
          }
        }
      }

      if (allSkills.length > 0) {
        renderedSections.add("SKILLS");
        children.push(sectionHeading("Skills"));

        const skillsByCategory: { label: string; items: string[] }[] = [];
        const s = resume.skills as Record<string, unknown>;
        if (Array.isArray(s.technical) && s.technical.length > 0) {
          skillsByCategory.push({ label: "Technical", items: s.technical.map(safePrimitive) });
        }
        if (Array.isArray(s.leadership) && s.leadership.length > 0) {
          skillsByCategory.push({ label: "Leadership", items: s.leadership.map(safePrimitive) });
        }
        if (Array.isArray(s.data_science) && s.data_science.length > 0) {
          skillsByCategory.push({ label: "Data Science", items: s.data_science.map(safePrimitive) });
        }

        if (skillsByCategory.length > 0) {
          for (const cat of skillsByCategory) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `${cat.label}: `,
                    bold: true,
                    size: BODY_SIZE,
                    font: FONT,
                  }),
                  new TextRun({
                    text: cat.items.join(",  "),
                    size: BODY_SIZE,
                    font: FONT,
                  }),
                ],
                spacing: { after: BULLET_SPACING_AFTER },
              }),
            );
          }
        } else {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: allSkills.join(",  "),
                  size: BODY_SIZE,
                  font: FONT,
                }),
              ],
              spacing: { after: PARAGRAPH_SPACING_AFTER },
            }),
          );
        }
      }
    }
  }

  // ── Education ──
  if (resume.education?.length > 0 && !renderedSections.has("EDUCATION")) {
    renderedSections.add("EDUCATION");
    children.push(sectionHeading("Education"));
    for (const edu of resume.education) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: safePrimitive(edu.degree),
              bold: true,
              size: BODY_SIZE,
              font: FONT,
            }),
            new TextRun({
              text: ` — ${safePrimitive(edu.institution)}`,
              size: BODY_SIZE,
              font: FONT,
            }),
            new TextRun({
              text: edu.year ? `  (${safePrimitive(edu.year)})` : "",
              size: BODY_SIZE,
              font: FONT,
              color: "666666",
            }),
          ],
          spacing: { after: BULLET_SPACING_AFTER },
        }),
      );
    }
  }

  // ── Certifications ──
  if (
    resume.certifications &&
    resume.certifications.length > 0 &&
    !renderedSections.has("CERTIFICATIONS")
  ) {
    renderedSections.add("CERTIFICATIONS");
    children.push(sectionHeading("Certifications"));
    for (const cert of resume.certifications) {
      const certName =
        typeof cert === "string" ? cert : safePrimitive(cert?.name ?? cert);
      const certYear =
        typeof cert === "string" ? "" : (cert as any)?.year || "";
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `•  ${certName}`,
              size: BODY_SIZE,
              font: FONT,
            }),
            ...(certYear
              ? [
                  new TextRun({
                    text: `  (${safePrimitive(certYear)})`,
                    size: BODY_SIZE,
                    font: FONT,
                    color: "666666",
                  }),
                ]
              : []),
          ],
          indent: { left: BULLET_INDENT },
          spacing: { after: BULLET_SPACING_AFTER },
        }),
      );
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: PAGE_MARGIN_TOP,
              bottom: PAGE_MARGIN_BOTTOM,
              left: PAGE_MARGIN_LEFT,
              right: PAGE_MARGIN_RIGHT,
            },
          },
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export async function renderCoverLetterDocx(
  coverLetter: TailoredCoverLetter,
  profile: {
    name: string;
    email?: string;
    phone?: string;
    location?: string;
  },
): Promise<Buffer> {
  const children: Paragraph[] = [];
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: safePrimitive(profile.name),
          bold: true,
          size: 24,
          font: FONT,
        }),
      ],
      spacing: { after: 20 },
    }),
  );

  const contactParts = [
    profile.email,
    profile.phone,
    profile.location,
  ].filter(Boolean);

  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: contactParts.map(safePrimitive).join("  |  "),
            size: CONTACT_SIZE,
            font: FONT,
            color: "555555",
          }),
        ],
        spacing: { after: 200 },
      }),
    );
  }

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: today, size: BODY_SIZE, font: FONT }),
      ],
      spacing: { after: 200 },
    }),
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Re: ${safePrimitive(coverLetter.target_role)} at ${safePrimitive(coverLetter.target_company)}`,
          bold: true,
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
      spacing: { after: 200 },
    }),
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: safePrimitive(coverLetter.salutation),
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
      spacing: { after: 120 },
    }),
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: safePrimitive(coverLetter.opening_paragraph),
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
      spacing: { after: 160 },
    }),
  );

  for (const para of coverLetter.body_paragraphs) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: safePrimitive(para),
            size: BODY_SIZE,
            font: FONT,
          }),
        ],
        spacing: { after: 160 },
      }),
    );
  }

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: safePrimitive(coverLetter.closing_paragraph),
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
      spacing: { after: 200 },
    }),
  );

  const signOffLines = safePrimitive(coverLetter.sign_off).split("\n");
  for (const line of signOffLines) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: line.trim(),
            size: BODY_SIZE,
            font: FONT,
          }),
        ],
        spacing: { after: 20 },
      }),
    );
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
            },
          },
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export async function convertDocxToPdf(
  docxPath: string,
  outputDir: string,
): Promise<{ pdfPath: string; pageCount: number }> {
  const { execSync } = await import("child_process");
  const path = await import("path");
  const fs = await import("fs");

  execSync(
    `HOME=/tmp libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${docxPath}"`,
    { timeout: 60000, stdio: "pipe" },
  );

  const baseName = path.basename(docxPath, ".docx");
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF conversion failed: ${pdfPath} not found`);
  }

  const pdfBuffer = fs.readFileSync(pdfPath);
  const pageCount = countPdfPages(pdfBuffer);

  return { pdfPath, pageCount };
}

function countPdfPages(buffer: Buffer): number {
  const text = buffer.toString("latin1");

  const linearizedMatch = text.match(/\/N\s+(\d+)/);
  if (linearizedMatch) {
    const count = parseInt(linearizedMatch[1]);
    if (count > 0 && count < 100) return count;
  }

  const pageMatches = text.match(/\/Type\s*\/Page(?!\s*s)/g);
  return pageMatches ? pageMatches.length : 1;
}

export interface PaginationCheck {
  pageCount: number;
  withinLimit: boolean;
  maxPages: number;
  warning: string | null;
}

export function checkPagination(
  pageCount: number,
  maxPages: number = 2,
): PaginationCheck {
  const withinLimit = pageCount <= maxPages;
  let warning: string | null = null;

  if (!withinLimit) {
    warning = `Document is ${pageCount} pages (max ${maxPages}). Consider reducing content to fit within ${maxPages} pages.`;
  } else if (pageCount === maxPages) {
    warning = `Document uses all ${maxPages} pages. Content is at capacity.`;
  }

  return { pageCount, withinLimit, maxPages, warning };
}
