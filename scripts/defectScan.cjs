#!/usr/bin/env node
// defectScan.cjs — mandatory pre-delivery scan. Run on extracted PDF text.
// Usage: pdftotext -layout resume.pdf out.txt && node scripts/defectScan.cjs out.txt [coverletter.txt]
// Exit 0 = clean, exit 1 = defects present. Intended as a hard gate: a failing
// packet must never reach Ed or an employer.
const fs = require("fs");

const BANNED = /leverag|utiliz|synerg|delv|game.chang|holistic|enterprise.grade/i;
const CONFLATION = /teams? of \d+\+?\s*FTEs?\s*,?\s*(with|managing)\s+\$\d+M/i;
const THIRD_PERSON = /Ed Dobbles (built|led|has)/;
const ROLES = ["Dobbles.AI", "Overproof", "Diageo", "H&R Block", "SuperValu", "Best Buy"];

function scanResume(txt) {
  const pages = txt.split("\f").filter((p) => p.trim());
  const lines = (p) => p.split("\n").filter((l) => l.trim()).length;
  const r = [];
  const chk = (name, ok, detail = "") => r.push({ name, ok, detail });

  chk("Exactly 2 pages", pages.length === 2, `${pages.length}`);
  if (pages[0]) chk("Page 1 fill", lines(pages[0]) >= 40, `${lines(pages[0])} lines`);
  if (pages[1]) chk("Page 2 fill", lines(pages[1]) >= 33, `${lines(pages[1])} lines`);
  if (pages[1]) chk("H&R Block opens page 2", /ANALYTICS & PRICING/i.test(pages[1].slice(0, 300)));

  ROLES.forEach((role) => chk(`Role: ${role}`, txt.includes(role)));

  chk("Diageo 60 hrs (never 100)", /60\s*hours?/i.test(txt) && !/100\s*hours?/i.test(txt));
  chk("DBA year 2023", /Doctor of Business Administration[^\n]*2023/.test(txt));
  chk("Title Founder & CEO", /FOUNDER & CEO/i.test(txt) && !/Founder & Principal/i.test(txt));
  chk("No FTE/budget conflation", !CONFLATION.test(txt));
  const bad = txt.match(new RegExp(BANNED.source, "gi"));
  chk("No banned words", !bad, bad ? [...new Set(bad.map((s) => s.toLowerCase()))].join(",") : "");
  chk("No third person", !THIRD_PERSON.test(txt));
  chk("Dissertation line", txt.includes("Driving Adoption"));
  chk("Harvard certificate", txt.includes("Harvard"));
  chk("Snowflake in tools", txt.includes("Snowflake"));
  return r;
}

function scanCover(txt) {
  const r = [];
  const chk = (name, ok, detail = "") => r.push({ name, ok, detail });
  const paras = txt.split(/\n\s*\n/).filter((p) => p.trim());
  chk("Cover: gap paragraph present", /\b(gap|limitation|haven't|have not|don't have|do not have|no direct)\b/i.test(txt));
  chk("Cover: thesis in sentence one", (paras[0] || "").split(/(?<=\.)\s/)[0].length > 40);
  chk("Cover: specific clarifying question", /\?/.test(txt.slice(-600)));
  const bad = txt.match(new RegExp(BANNED.source, "gi"));
  chk("Cover: no banned words", !bad, bad ? [...new Set(bad.map((s) => s.toLowerCase()))].join(",") : "");
  chk("Cover: no conflation", !CONFLATION.test(txt));
  chk("Cover: no third person", !THIRD_PERSON.test(txt));
  return r;
}

const [resumePath, coverPath] = process.argv.slice(2);
if (!resumePath) {
  console.error("usage: node scripts/defectScan.cjs <resume.txt> [cover.txt]");
  process.exit(2);
}
let results = scanResume(fs.readFileSync(resumePath, "utf8"));
if (coverPath && fs.existsSync(coverPath)) {
  results = results.concat(scanCover(fs.readFileSync(coverPath, "utf8")));
}
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
console.log(pad("CHECK", 42) + "RESULT");
console.log("-".repeat(72));
results.forEach((c) => console.log(pad(c.name, 42) + pad(c.ok ? "PASS" : "FAIL", 6) + c.detail));
console.log("-".repeat(72));
const ok = results.filter((c) => c.ok).length;
const clean = ok === results.length;
console.log(`${ok}/${results.length} PASS  — ${clean ? "CLEAN" : "DEFECTS PRESENT — DO NOT DELIVER"}`);
process.exit(clean ? 0 : 1);
