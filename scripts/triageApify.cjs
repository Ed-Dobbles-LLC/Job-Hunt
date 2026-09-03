#!/usr/bin/env node
// triageApify.cjs — dedupe + hard-pass triage for an Apify LinkedIn dataset.
// Usage: node scripts/triageApify.cjs <datasetId> [<datasetId>...]
// Reads Apify datasets UNAUTHENTICATED (dataset reads are not token-gated),
// cross-checks every row against the live tracker, and applies Ed's standing filters.
const TRACKER = "https://job-hunt-production-f825.up.railway.app/api/dashboard/job-log";

const AGENCY_NAME = /harnham|millman|morpheus|talener|robert half|michael page|korn ferry|heidrick|russell reynolds|spencer stuart|insight global|recruit|staffing|executive search|talent solutions/i;
const AGENCY_INDUSTRY = /staffing and recruiting/i;
const FIN = /\bbank\b|credit union|financial services|capital|insurance|wealth|investment|securities/i;
const PHARMA = /pharmaceutical|biotechnology/i;
const ENGINEERING = /\bengineer|architect|developer\b/i;
const GOVERNANCE = /governance|master data/i;
const COMP_FLOOR = 175000; // employer-stated only; predicted salary is ignored

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const j = async (u) => (await fetch(u)).json();

(async () => {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.error("usage: node scripts/triageApify.cjs <datasetId>..."); process.exit(2); }

  const rows = (await Promise.all(
    ids.map((id) => j(`https://api.apify.com/v2/datasets/${id}/items`))
  )).flat();

  const log = await j(TRACKER);
  const jobs = log.jobs || log;
  const byCompany = new Map();
  const applied = new Set();
  for (const t of jobs) {
    const k = norm(t.company);
    if (!byCompany.has(k)) byCompany.set(k, t);
    if (t.user_action === "applied" || t.job_status === "applied") applied.add(k);
  }

  const seen = new Set();
  const out = rows.map((r) => {
    const flags = [];
    const co = r.company || "", k = norm(co), ind = r.industry || "";
    if (AGENCY_NAME.test(co) || AGENCY_INDUSTRY.test(ind)) flags.push("AGENCY");
    if (FIN.test(co) || FIN.test(ind)) flags.push("FIN?");        // case-by-case, surfaces flagged
    if (PHARMA.test(ind)) flags.push("PHARMA?");                  // case-by-case, surfaces flagged
    if (ENGINEERING.test(r.title || "")) flags.push("ENG");
    if (GOVERNANCE.test(r.title || "")) flags.push("GOV");
    if (byCompany.has(k)) flags.push(`DUP(${byCompany.get(k).job_id})`);
    if (applied.has(k)) flags.push("APPLIED");
    const dupKey = `${k}|${norm(r.title)}`;
    if (seen.has(dupKey)) flags.push("DUP-IN-RUN"); else seen.add(dupKey);
    if (!r.salaryIsPredicted && r.salaryMin && r.salaryMin < COMP_FLOOR) flags.push("LOW-COMP");
    return { r, flags };
  });

  const hard = (f) => f.some((x) => /^(AGENCY|ENG|GOV|APPLIED|DUP\(|DUP-IN-RUN|LOW-COMP)/.test(x));
  const pad = (s, n) => ((s || "") + " ".repeat(n)).slice(0, n);
  console.log(pad("COMPANY", 26) + pad("TITLE", 42) + pad("SENIOR", 11) + pad("SALARY", 22) + "FLAGS");
  console.log("-".repeat(140));
  for (const { r, flags } of out) {
    const sal = r.salaryMin && !r.salaryIsPredicted
      ? `$${r.salaryMin.toLocaleString()}-${(r.salaryMax || 0).toLocaleString()}` : "";
    console.log(pad(r.company, 26) + pad(r.title, 42) + pad(r.seniorityLevel, 11) + pad(sal, 22) + flags.join(" "));
  }
  const survivors = out.filter((o) => !hard(o.flags));
  console.log("-".repeat(140));
  console.log(`${rows.length} rows | ${rows.length - survivors.length} killed | ${survivors.length} to assess`);
  console.log("\nTO ASSESS:");
  survivors.forEach(({ r, flags }) =>
    console.log(`  ${r.company} — ${r.title}  ${flags.join(" ")}\n    ${r.applyUrl || r.jobUrl}`));
})();
