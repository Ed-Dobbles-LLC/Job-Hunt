// renderMasterResume.cjs — generates Ed's master resume DOCX from experience_inventory.json
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat,
  BorderStyle, TabStopType, TabStopPosition,
} = require("docx");

const inv = JSON.parse(fs.readFileSync("/home/claude/jobhunt/experience_inventory.json", "utf8"));
const P = inv.profile;
const VARIANT = inv.resume_variants.master_2page.include_bullets;
const pickBullets = (e) => {
  const sel = VARIANT[e.id];
  if (!sel) return e.bullets || [];
  if (sel === "all") return e.bullets;
  return e.bullets.filter((b) => sel.includes(b.id));
};

const NAVY = "1F3864", GRAY = "444444";
const FONT = "Calibri";

const dateLabel = (s, e) => {
  const y = (d) => (d || "").split("-")[0];
  const end = e === "present" ? "Present" : y(e);
  return `${y(s)} \u2013 ${end}`;
};

const rule = { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 2 } };

const sectionHead = (text) =>
  new Paragraph({
    spacing: { before: 140, after: 60 },
    border: rule,
    children: [new TextRun({ text, bold: true, color: NAVY, size: 24, font: FONT, allCaps: true })],
  });

const body = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: opts.after ?? 80 },
    children: [new TextRun({ text, size: 20, font: FONT, color: "000000", ...opts.run })],
  });

const bullet = (text) =>
  new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 20 },
    children: [new TextRun({ text, size: 20, font: FONT })],
  });

const children = [];

// ── Header ──
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 40 },
  children: [new TextRun({ text: P.name.toUpperCase(), bold: true, size: 44, font: FONT, color: NAVY })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 20 },
  children: [new TextRun({
    text: `${P.location}  |  ${P.phone}  |  ${P.email}  |  ${P.linkedin}`,
    size: 18, font: FONT, color: GRAY,
  })],
}));

// ── Headline ──
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 },
  children: [new TextRun({
    text: "CHIEF ANALYTICS OFFICER  |  CHIEF DATA OFFICER  |  VP\u2013SVP ANALYTICS",
    bold: true, size: 26, font: FONT, color: NAVY,
  })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 120 },
  children: [new TextRun({
    text: "\u201CThe Geek That Can Speak\u201D \u2014 Transformational Analytics Executive Driving $300M+ in Enterprise Value Through Data Strategy & AI Innovation",
    italics: true, size: 20, font: FONT, color: GRAY,
  })],
}));

// ── Summary ──
children.push(body(P.summary, { after: 100 }));
children.push(new Paragraph({
  spacing: { after: 60 },
  children: [
    new TextRun({ text: "Core Competencies: ", bold: true, size: 20, font: FONT }),
    new TextRun({ text: inv.skills.leadership.join(" \u2022 "), size: 20, font: FONT }),
  ],
}));

// ── Experience ──
children.push(sectionHead("Executive Experience"));
for (const e of inv.experience) {
  if (!e.bullets || e.bullets.length === 0) continue; // earlier-career roles handled below
  children.push(new Paragraph({
    spacing: { before: 100, after: 4 },
    pageBreakBefore: e.id === "exp-003", // H&R Block starts page 2 (Ed, 2026-07-09)
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: e.title.toUpperCase(), bold: true, size: 21, font: FONT }),
      new TextRun({ text: `\t${dateLabel(e.start_date, e.end_date)}`, bold: true, size: 20, font: FONT, color: GRAY }),
    ],
  }));
  children.push(new Paragraph({
    spacing: { after: 30 },
    children: [new TextRun({ text: `${e.employer}  |  ${e.location}`, italics: true, size: 20, font: FONT, color: GRAY })],
  }));
  if (e.scope) {
    children.push(body(e.scope.replace(/ \| /g, " \u2022 "), { after: 30, run: { color: GRAY } }));
  }
  for (const b of pickBullets(e)) children.push(bullet(b.text));
}

// Earlier career (zero-bullet entries)
const earlier = inv.experience.filter((e) => !e.bullets || e.bullets.length === 0);
if (earlier.length) {
  children.push(new Paragraph({
    spacing: { before: 140, after: 40 },
    children: [new TextRun({ text: "EARLIER CAREER", bold: true, size: 21, font: FONT })],
  }));
  for (const e of earlier) {
    children.push(body(`${e.title}  |  ${e.employer}`, { after: 30 }));
  }
}

// ── Education ──
children.push(sectionHead("Education & Credentials"));
for (const ed of inv.education) {
  children.push(new Paragraph({
    spacing: { after: 10 },
    children: [
      new TextRun({ text: ed.degree, bold: true, size: 20, font: FONT }),
      new TextRun({ text: `  |  ${ed.institution}${ed.location ? ", " + ed.location : ""}${ed.year ? "  |  " + ed.year : ""}`, size: 20, font: FONT }),
    ],
  }));
  if (ed.detail) children.push(body(ed.detail, { after: 60, run: { italics: true, color: GRAY, size: 18 } }));
}
for (const c of inv.certifications) {
  children.push(body(`${c.name}  |  ${c.institution}`, { after: 30 }));
}

// ── Technical ──
children.push(sectionHead("Technical Proficiencies"));
children.push(new Paragraph({
  spacing: { after: 40 },
  children: [
    new TextRun({ text: "Analytics & AI: ", bold: true, size: 20, font: FONT }),
    new TextRun({ text: inv.skills.data_science.join(", "), size: 20, font: FONT }),
  ],
}));
children.push(new Paragraph({
  spacing: { after: 40 },
  children: [
    new TextRun({ text: "Platforms: ", bold: true, size: 20, font: FONT }),
    new TextRun({ text: inv.skills.technical.join(", "), size: 20, font: FONT }),
  ],
}));
if (inv.skills.domains) {
  children.push(new Paragraph({
    children: [
      new TextRun({ text: "Domains: ", bold: true, size: 20, font: FONT }),
      new TextRun({ text: inv.skills.domains.join(", "), size: 20, font: FONT }),
    ],
  }));
}

const doc = new Document({
  numbering: {
    config: [{
      reference: "bullets",
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 360, hanging: 180 } } },
      }],
    }],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 620, bottom: 620, left: 860, right: 860 },
      },
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("/home/claude/Ed_Dobbles_Resume_2026-07_2page.docx", buf);
  console.log("written");
});
