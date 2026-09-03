// renderCoverLetter.cjs — renders a cover letter DOCX matching the master resume's
// visual language (navy rules, Calibri, caps name block).
// Usage: node scripts/renderCoverLetter.cjs <letter.json> <out.docx>
// letter.json: { role, company, date?, body: [paragraphs], closing? }
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle,
} = require("docx");

const INV = process.env.INVENTORY || "/home/claude/jh/experience_inventory.json";
const inv = JSON.parse(fs.readFileSync(INV, "utf8"));
const P = inv.profile;

const NAVY = "1F3864", GRAY = "444444", FONT = "Calibri";
const rule = { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 2 } };

const [letterPath, outPath] = process.argv.slice(2);
const L = JSON.parse(fs.readFileSync(letterPath, "utf8"));

const children = [];

// ── Header block, identical treatment to the resume ──
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 40 },
  children: [new TextRun({ text: P.name.toUpperCase(), bold: true, size: 44, font: FONT, color: NAVY })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 160 }, border: rule,
  children: [new TextRun({
    text: `${P.location}  |  ${P.phone}  |  ${P.email}  |  ${P.linkedin}`,
    size: 18, font: FONT, color: GRAY,
  })],
}));

// ── Date ──
const dateStr = L.date || new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
children.push(new Paragraph({
  spacing: { before: 200, after: 260 },
  children: [new TextRun({ text: dateStr, size: 20, font: FONT, color: GRAY })],
}));

// ── Role / company line ──
children.push(new Paragraph({
  spacing: { after: 40 },
  children: [new TextRun({ text: L.role, bold: true, size: 24, font: FONT, color: NAVY })],
}));
children.push(new Paragraph({
  spacing: { after: 220 }, border: rule,
  children: [new TextRun({ text: L.company, size: 20, font: FONT, color: GRAY, allCaps: true })],
}));

// ── Body. A paragraph beginning "**" renders its lead sentence in bold navy. ──
for (const para of L.body) {
  if (para.startsWith("**")) {
    const [lead, ...rest] = para.slice(2).split("|||");
    children.push(new Paragraph({
      spacing: { before: 200, after: 70 },
      children: [new TextRun({ text: lead.trim(), bold: true, size: 21, font: FONT, color: NAVY })],
    }));
    if (rest.length) {
      children.push(new Paragraph({
        spacing: { after: 200, line: 288 }, alignment: AlignmentType.JUSTIFIED,
        children: [new TextRun({ text: rest.join("|||").trim(), size: 21, font: FONT })],
      }));
    }
  } else {
    children.push(new Paragraph({
      spacing: { after: 200, line: 288 }, alignment: AlignmentType.JUSTIFIED,
      children: [new TextRun({ text: para, size: 21, font: FONT })],
    }));
  }
}

// ── Signature ──
children.push(new Paragraph({
  spacing: { before: 320, after: 0 },
  children: [new TextRun({ text: L.closing || "Ed Dobbles", bold: true, size: 20, font: FONT, color: NAVY })],
}));

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 20 } } } },
  sections: [{
    properties: { page: { margin: { top: 900, right: 1180, bottom: 900, left: 1180 } } },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(outPath, buf); console.log("written", outPath); });
