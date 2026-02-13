import { z } from "zod";
import type { TailoredResume } from "./tailoredResumePrompt";
import type { TailoredCoverLetter } from "./tailoredCoverLetterPrompt";
import type { EntityAllowlist } from "./entityAllowlist";
import { buildEntityDenylist, checkTextAgainstDenylist } from "./entityAllowlist";
import { extractClaimsLedger, validateAllMetricsInText, type ClaimsLedger } from "./claimsLedger";

export const ViolationTypeEnum = z.enum([
  "NEW_ENTITY",
  "UNSUPPORTED_METRIC",
  "PLACEHOLDER",
  "INCONSISTENT_DATE",
  "STYLE_RULE_BROKEN",
  "ATS_RISK",
]);
export type ViolationType = z.infer<typeof ViolationTypeEnum>;

export const ViolationSchema = z.object({
  type: ViolationTypeEnum,
  severity: z.enum(["critical", "warning"]),
  location: z.string().describe("Where the violation was found (e.g., 'resume.experience[0].bullets[1]', 'cover_letter.body_paragraphs[0]')"),
  found_value: z.string().describe("The offending value that was detected"),
  expected: z.string().optional().describe("What was expected instead, if applicable"),
  explanation: z.string().describe("Human-readable explanation of the violation"),
});
export type Violation = z.infer<typeof ViolationSchema>;

export const LineItemFixSchema = z.object({
  location: z.string().describe("Where to apply the fix"),
  current_text: z.string().describe("The current text that needs fixing"),
  suggested_text: z.string().describe("The suggested replacement text"),
  reason: z.string().describe("Why this fix is needed"),
  violation_type: ViolationTypeEnum,
});
export type LineItemFix = z.infer<typeof LineItemFixSchema>;

export const VerifierReportSchema = z.object({
  pass: z.boolean().describe("true if zero critical violations, false otherwise"),
  violations: z.array(ViolationSchema),
  line_item_fixes: z.array(LineItemFixSchema),
  stats: z.object({
    total_checks: z.number(),
    critical_violations: z.number(),
    warnings: z.number(),
    entities_checked: z.number(),
    metrics_checked: z.number(),
    dates_checked: z.number(),
    evidence_pointers_validated: z.number(),
    denylist_scans: z.number(),
  }),
});
export type VerifierReport = z.infer<typeof VerifierReportSchema>;

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function checkEntityInAllowlist(
  value: string,
  category: keyof EntityAllowlist,
  allowlist: EntityAllowlist,
): boolean {
  const entries = allowlist[category] as Array<{ normalized: string; value: string }>;
  const norm = normalize(value);
  return entries.some(
    (e) => e.normalized === norm || norm.includes(e.normalized) || e.normalized.includes(norm),
  );
}

export function verifyNewEntities(
  resume: TailoredResume,
  coverLetter: TailoredCoverLetter,
  allowlist: EntityAllowlist,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];

    checksRun++;
    if (!checkEntityInAllowlist(exp.employer, "companies", allowlist)) {
      violations.push({
        type: "NEW_ENTITY",
        severity: "critical",
        location: `resume.experience[${i}].employer`,
        found_value: exp.employer,
        explanation: `Employer "${exp.employer}" not found in EntityAllowlist. The generator may have hallucinated this company name.`,
      });
    }

    checksRun++;
    if (!checkEntityInAllowlist(exp.title, "titles", allowlist)) {
      violations.push({
        type: "NEW_ENTITY",
        severity: "critical",
        location: `resume.experience[${i}].title`,
        found_value: exp.title,
        explanation: `Title "${exp.title}" not found in EntityAllowlist. The generator may have hallucinated or altered this job title.`,
      });
    }

    checksRun++;
    if (!checkEntityInAllowlist(exp.location, "locations", allowlist)) {
      violations.push({
        type: "NEW_ENTITY",
        severity: "warning",
        location: `resume.experience[${i}].location`,
        found_value: exp.location,
        explanation: `Location "${exp.location}" not found in EntityAllowlist.`,
      });
    }
  }

  if (resume.education) {
    for (let i = 0; i < resume.education.length; i++) {
      const edu = resume.education[i];
      checksRun++;
      if (!checkEntityInAllowlist(edu.institution, "companies", allowlist)) {
        violations.push({
          type: "NEW_ENTITY",
          severity: "critical",
          location: `resume.education[${i}].institution`,
          found_value: edu.institution,
          explanation: `Institution "${edu.institution}" not found in EntityAllowlist.`,
        });
      }
      checksRun++;
      if (!checkEntityInAllowlist(edu.degree, "degrees", allowlist)) {
        violations.push({
          type: "NEW_ENTITY",
          severity: "critical",
          location: `resume.education[${i}].degree`,
          found_value: edu.degree,
          explanation: `Degree "${edu.degree}" not found in EntityAllowlist.`,
        });
      }
    }
  }

  if (resume.certifications) {
    for (let i = 0; i < resume.certifications.length; i++) {
      const cert = resume.certifications[i];
      checksRun++;
      if (!checkEntityInAllowlist(cert.name, "certifications", allowlist)) {
        violations.push({
          type: "NEW_ENTITY",
          severity: "critical",
          location: `resume.certifications[${i}].name`,
          found_value: cert.name,
          explanation: `Certification "${cert.name}" not found in EntityAllowlist. The generator may have invented this credential.`,
        });
      }
    }
  }

  const s = resume.skills as any;
  const skillsToCheck = [
    ...(s.enterprise_capabilities || s.technical || []),
    ...(s.tools_and_platforms || []),
    ...(s.leadership || []),
    ...(s.data_science || []),
  ];
  for (const skill of skillsToCheck) {
    checksRun++;
    const inSkills = checkEntityInAllowlist(skill, "skills", allowlist);
    const inTools = checkEntityInAllowlist(skill, "tools", allowlist);
    if (!inSkills && !inTools) {
      violations.push({
        type: "NEW_ENTITY",
        severity: "warning",
        location: `resume.skills`,
        found_value: skill,
        explanation: `Skill "${skill}" not found in EntityAllowlist skills or tools.`,
      });
    }
  }

  return { violations, fixes, checksRun };
}

export function verifyMetrics(
  resume: TailoredResume,
  coverLetter: TailoredCoverLetter,
  allowlist: EntityAllowlist,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  const metricPattern = /\$[\d,.]+[MBK]?|\d+[\d,.]*%|\d{2,}[\d,.]*[+]?\s*(?:person|people|team|member|engineer|analyst|unit|business unit|report|year|month|department|client|partner|stakeholder|model)/gi;

  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      const matches = bullet.text.match(metricPattern) || [];
      for (const m of matches) {
        checksRun++;
        const stripped = m.replace(/[,$%\s]+$/g, "").trim();
        const numOnly = stripped.replace(/[^0-9.+]/g, "");
        if (numOnly.length < 2) continue;

        const inAllowlist = allowlist.metrics.some((metric) => {
          const metricNum = metric.number.replace(/[,]/g, "");
          return (
            metricNum === numOnly ||
            normalize(metric.raw).includes(normalize(stripped)) ||
            normalize(stripped).includes(normalize(metric.raw))
          );
        });

        if (!inAllowlist) {
          violations.push({
            type: "UNSUPPORTED_METRIC",
            severity: "critical",
            location: `resume.experience[${i}].bullets[${j}]`,
            found_value: m.trim(),
            explanation: `Metric "${m.trim()}" in resume bullet not found in EntityAllowlist metrics. The generator may have invented, rounded, or combined numbers.`,
          });
          fixes.push({
            location: `resume.experience[${i}].bullets[${j}]`,
            current_text: bullet.text,
            suggested_text: `[Remove or replace "${m.trim()}" with an allowlisted metric, or remove the bullet entirely]`,
            reason: `Metric not in inventory`,
            violation_type: "UNSUPPORTED_METRIC",
          });
        }
      }
    }
  }

  for (const claim of coverLetter.value_claims) {
    const matches = claim.claim_sentence.match(metricPattern) || [];
    for (const m of matches) {
      checksRun++;
      const stripped = m.replace(/[,$%\s]+$/g, "").trim();
      const numOnly = stripped.replace(/[^0-9.+]/g, "");
      if (numOnly.length < 2) continue;

      const inAllowlist = allowlist.metrics.some((metric) => {
        const metricNum = metric.number.replace(/[,]/g, "");
        return (
          metricNum === numOnly ||
          normalize(metric.raw).includes(normalize(stripped)) ||
          normalize(stripped).includes(normalize(metric.raw))
        );
      });

      if (!inAllowlist) {
        violations.push({
          type: "UNSUPPORTED_METRIC",
          severity: "critical",
          location: `cover_letter.value_claims`,
          found_value: m.trim(),
          explanation: `Metric "${m.trim()}" in cover letter value claim not found in EntityAllowlist metrics. The generator may have fabricated this number.`,
        });
      }
    }
  }

  for (let i = 0; i < coverLetter.body_paragraphs.length; i++) {
    const para = coverLetter.body_paragraphs[i];
    const dollarMatches = para.match(/\$[\d,.]+[MBK]?/g) || [];
    const pctMatches = para.match(/\d+[\d,.]*%/g) || [];
    for (const m of [...dollarMatches, ...pctMatches]) {
      checksRun++;
      const numOnly = m.replace(/[^0-9.+]/g, "");
      if (numOnly.length < 2) continue;

      const inAllowlist = allowlist.metrics.some((metric) => {
        const metricNum = metric.number.replace(/[,]/g, "");
        return metricNum === numOnly;
      });

      if (!inAllowlist) {
        violations.push({
          type: "UNSUPPORTED_METRIC",
          severity: "critical",
          location: `cover_letter.body_paragraphs[${i}]`,
          found_value: m,
          explanation: `Metric "${m}" in cover letter body not found in EntityAllowlist.`,
        });
      }
    }
  }

  return { violations, fixes, checksRun };
}

export function verifyPlaceholders(
  resume: TailoredResume,
  coverLetter: TailoredCoverLetter,
  allowlist?: EntityAllowlist,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  const denylist = buildEntityDenylist();

  const allowlistedValues = new Set<string>();
  if (allowlist) {
    for (const cat of Object.values(allowlist) as Array<Array<{ value: string }>>) {
      for (const entry of cat) {
        allowlistedValues.add(normalize(entry.value));
      }
    }
  }

  function isAllowlisted(matchText: string, fullText: string): boolean {
    if (allowlistedValues.size === 0) return false;
    const matchNorm = normalize(matchText);
    for (const allowed of allowlistedValues) {
      if (allowed.includes(matchNorm)) {
        const allowedInText = normalize(fullText).includes(allowed);
        if (allowedInText) return true;
      }
    }
    return false;
  }

  function scanText(text: string, location: string): void {
    checksRun++;
    const result = checkTextAgainstDenylist(text, denylist);
    for (const v of result.violations) {
      if (isAllowlisted(v.match, text)) continue;
      violations.push({
        type: "PLACEHOLDER",
        severity: "critical",
        location,
        found_value: v.match,
        explanation: `Placeholder/artifact detected: "${v.match}" — ${v.reason}`,
      });
      fixes.push({
        location,
        current_text: v.match,
        suggested_text: "[Remove placeholder content]",
        reason: v.reason,
        violation_type: "PLACEHOLDER",
      });
    }
  }

  scanText(resume.professional_summary, "resume.professional_summary");
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      scanText(resume.experience[i].bullets[j].text, `resume.experience[${i}].bullets[${j}]`);
    }
  }

  scanText(coverLetter.opening_paragraph, "cover_letter.opening_paragraph");
  for (let i = 0; i < coverLetter.body_paragraphs.length; i++) {
    scanText(coverLetter.body_paragraphs[i], `cover_letter.body_paragraphs[${i}]`);
  }
  scanText(coverLetter.closing_paragraph, "cover_letter.closing_paragraph");
  scanText(coverLetter.salutation, "cover_letter.salutation");
  scanText(coverLetter.sign_off, "cover_letter.sign_off");

  return { violations, fixes, checksRun };
}

export function verifyDates(
  resume: TailoredResume,
  allowlist: EntityAllowlist,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];

    checksRun++;
    if (exp.start_date && exp.start_date !== "present") {
      const inAllowlist = allowlist.dates.some(
        (d) => d.normalized === exp.start_date.toLowerCase() || d.value === exp.start_date,
      );
      if (!inAllowlist) {
        violations.push({
          type: "INCONSISTENT_DATE",
          severity: "critical",
          location: `resume.experience[${i}].start_date`,
          found_value: exp.start_date,
          explanation: `Start date "${exp.start_date}" not found in EntityAllowlist. The generator may have altered the date.`,
        });
      }
    }

    checksRun++;
    if (exp.end_date && exp.end_date !== "present") {
      const inAllowlist = allowlist.dates.some(
        (d) => d.normalized === exp.end_date.toLowerCase() || d.value === exp.end_date,
      );
      if (!inAllowlist) {
        violations.push({
          type: "INCONSISTENT_DATE",
          severity: "critical",
          location: `resume.experience[${i}].end_date`,
          found_value: exp.end_date,
          explanation: `End date "${exp.end_date}" not found in EntityAllowlist. The generator may have altered the date.`,
        });
      }
    }

    checksRun++;
    if (exp.start_date && exp.end_date && exp.start_date !== "present" && exp.end_date !== "present") {
      const startParts = exp.start_date.match(/(\d{4})-?(\d{2})?/);
      const endParts = exp.end_date.match(/(\d{4})-?(\d{2})?/);
      if (startParts && endParts) {
        const startYear = parseInt(startParts[1]);
        const endYear = parseInt(endParts[1]);
        if (startYear > endYear) {
          violations.push({
            type: "INCONSISTENT_DATE",
            severity: "critical",
            location: `resume.experience[${i}]`,
            found_value: `${exp.start_date} — ${exp.end_date}`,
            explanation: `Start date is after end date for "${exp.employer}". Dates are inconsistent.`,
          });
        }
      }
    }
  }

  if (resume.education) {
    for (let i = 0; i < resume.education.length; i++) {
      const edu = resume.education[i];
      if (edu.year) {
        checksRun++;
        const inAllowlist = allowlist.dates.some(
          (d) => d.normalized === edu.year.toLowerCase() || d.value === edu.year,
        );
        if (!inAllowlist) {
          violations.push({
            type: "INCONSISTENT_DATE",
            severity: "warning",
            location: `resume.education[${i}].year`,
            found_value: edu.year,
            explanation: `Education year "${edu.year}" not found in EntityAllowlist.`,
          });
        }
      }
    }
  }

  return { violations, fixes, checksRun };
}

export function verifyStyleRules(
  resume: TailoredResume,
  coverLetter: TailoredCoverLetter,
  inventory: Record<string, any>,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  checksRun++;
  for (let i = 0; i < resume.experience.length; i++) {
    for (let j = 0; j < resume.experience[i].bullets.length; j++) {
      const bullet = resume.experience[i].bullets[j];
      checksRun++;
      if (!bullet.source_hash || bullet.source_hash.trim() === "") {
        violations.push({
          type: "STYLE_RULE_BROKEN",
          severity: "critical",
          location: `resume.experience[${i}].bullets[${j}].source_hash`,
          found_value: bullet.source_hash || "(empty)",
          explanation: `Resume bullet missing source_hash evidence pointer. Every bullet MUST trace to an inventory item.`,
        });
      }

      checksRun++;
      if (!bullet.evidence_quote || bullet.evidence_quote.trim() === "") {
        violations.push({
          type: "STYLE_RULE_BROKEN",
          severity: "critical",
          location: `resume.experience[${i}].bullets[${j}].evidence_quote`,
          found_value: "(empty)",
          explanation: `Resume bullet missing evidence_quote. Every bullet MUST include a verbatim inventory quote.`,
        });
      }

      checksRun++;
      if (bullet.source_hash) {
        const bulletId = bullet.source_hash.toLowerCase().trim();
        let foundInInventory = false;
        for (const exp of inventory.experience || []) {
          for (const b of exp.bullets || []) {
            if (b.id && b.id.toLowerCase() === bulletId) {
              foundInInventory = true;
              const invNorm = normalize(b.text);
              const quoteNorm = normalize(bullet.evidence_quote || "");
              if (quoteNorm.length > 0 && !invNorm.includes(quoteNorm) && !quoteNorm.includes(invNorm)) {
                const quoteWords = quoteNorm.split(/\s+/);
                const invWords = invNorm.split(/\s+/);
                const matchCount = quoteWords.filter((w) => invWords.includes(w)).length;
                const matchRatio = matchCount / Math.max(quoteWords.length, 1);
                if (matchRatio < 0.6) {
                  violations.push({
                    type: "STYLE_RULE_BROKEN",
                    severity: "critical",
                    location: `resume.experience[${i}].bullets[${j}].evidence_quote`,
                    found_value: bullet.evidence_quote.substring(0, 100),
                    expected: b.text.substring(0, 100),
                    explanation: `Evidence quote does not match inventory bullet ${bullet.source_hash}. Match ratio: ${(matchRatio * 100).toFixed(0)}%. The generator may have paraphrased beyond acceptable limits.`,
                  });
                }
              }
              break;
            }
          }
          if (foundInInventory) break;
        }
        if (!foundInInventory) {
          violations.push({
            type: "STYLE_RULE_BROKEN",
            severity: "critical",
            location: `resume.experience[${i}].bullets[${j}].source_hash`,
            found_value: bullet.source_hash,
            explanation: `source_hash "${bullet.source_hash}" does not exist in the experience inventory. The generator hallucinated this ID.`,
          });
        }
      }
    }
  }

  for (const claim of coverLetter.value_claims) {
    checksRun++;
    if (!claim.source_hash || claim.source_hash.trim() === "") {
      violations.push({
        type: "STYLE_RULE_BROKEN",
        severity: "critical",
        location: `cover_letter.value_claims`,
        found_value: claim.claim_sentence.substring(0, 80),
        explanation: `Value claim missing source_hash. Every value claim MUST trace to an inventory item.`,
      });
    }
    checksRun++;
    if (!claim.evidence_quote || claim.evidence_quote.trim() === "") {
      violations.push({
        type: "STYLE_RULE_BROKEN",
        severity: "critical",
        location: `cover_letter.value_claims`,
        found_value: claim.claim_sentence.substring(0, 80),
        explanation: `Value claim missing evidence_quote.`,
      });
    }
  }

  for (const pointer of resume.evidence_pointers) {
    checksRun++;
    if (pointer.confidence < 0.7) {
      violations.push({
        type: "STYLE_RULE_BROKEN",
        severity: "warning",
        location: `resume.evidence_pointers`,
        found_value: `confidence=${pointer.confidence} for "${pointer.claim_text.substring(0, 60)}"`,
        explanation: `Evidence pointer confidence ${pointer.confidence} is below the 0.7 minimum threshold.`,
      });
    }
  }

  for (const pointer of coverLetter.evidence_pointers) {
    checksRun++;
    if (pointer.confidence < 0.7) {
      violations.push({
        type: "STYLE_RULE_BROKEN",
        severity: "warning",
        location: `cover_letter.evidence_pointers`,
        found_value: `confidence=${pointer.confidence} for "${pointer.claim_text.substring(0, 60)}"`,
        explanation: `Evidence pointer confidence ${pointer.confidence} is below the 0.7 minimum threshold.`,
      });
    }
  }

  checksRun++;
  const totalBullets = resume.experience.reduce((sum, exp) => sum + exp.bullets.length, 0);
  if (resume.evidence_pointers.length < totalBullets) {
    violations.push({
      type: "STYLE_RULE_BROKEN",
      severity: "critical",
      location: `resume.evidence_pointers`,
      found_value: `${resume.evidence_pointers.length} pointers for ${totalBullets} bullets`,
      explanation: `Evidence pointer count (${resume.evidence_pointers.length}) does not match bullet count (${totalBullets}). Every bullet MUST have exactly one evidence pointer.`,
    });
  }

  checksRun++;
  const wordCount = coverLetter.word_count;
  if (wordCount < 250 || wordCount > 350) {
    violations.push({
      type: "STYLE_RULE_BROKEN",
      severity: "warning",
      location: `cover_letter.word_count`,
      found_value: `${wordCount} words`,
      expected: "250-350 words",
      explanation: `Cover letter word count (${wordCount}) is outside the 250-350 word range.`,
    });
  }

  checksRun++;
  const cliches = ["passionate", "synergy", "results-driven", "team player", "go-getter", "think outside the box", "wear many hats", "hit the ground running", "move the needle"];
  const allCLText = [
    coverLetter.opening_paragraph,
    ...coverLetter.body_paragraphs,
    coverLetter.closing_paragraph,
  ].join(" ").toLowerCase();

  for (const cliche of cliches) {
    if (allCLText.includes(cliche)) {
      violations.push({
        type: "STYLE_RULE_BROKEN",
        severity: "warning",
        location: `cover_letter`,
        found_value: cliche,
        explanation: `Cliché "${cliche}" detected in cover letter. Executive tone guidelines forbid buzzwords.`,
      });
      fixes.push({
        location: `cover_letter`,
        current_text: cliche,
        suggested_text: `[Replace with specific, evidence-backed language]`,
        reason: `Clichés violate executive tone guidelines`,
        violation_type: "STYLE_RULE_BROKEN",
      });
    }
  }

  return { violations, fixes, checksRun };
}

export function verifyATSRisks(
  resume: TailoredResume,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  const fullText = [
    resume.professional_summary,
    ...resume.experience.flatMap((exp) =>
      exp.bullets.map((b) => b.text),
    ),
  ].join("\n");

  checksRun++;
  const tableIndicators = /[│┌┐└┘├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]|\|{3,}/;
  if (tableIndicators.test(fullText)) {
    violations.push({
      type: "ATS_RISK",
      severity: "critical",
      location: "resume",
      found_value: "Table/grid characters detected",
      explanation: "ATS systems cannot parse tables. Use plain text with bullet points only.",
    });
  }

  checksRun++;
  const unicodeEmoji = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  if (unicodeEmoji.test(fullText)) {
    violations.push({
      type: "ATS_RISK",
      severity: "warning",
      location: "resume",
      found_value: "Unicode emoji detected",
      explanation: "Some ATS systems strip or misinterpret emoji characters. Remove them from resume content.",
    });
  }

  checksRun++;
  const specialChars = /[★☆●◆▶►▸▹◀◄◂◃■□▪▫◊○◎⊕⊖⊗⊘⊙⊚⊛]/;
  if (specialChars.test(fullText)) {
    violations.push({
      type: "ATS_RISK",
      severity: "warning",
      location: "resume",
      found_value: "Special characters detected",
      explanation: "Special characters may not render correctly in ATS. Use standard ASCII bullets (- or •).",
    });
  }

  checksRun++;
  if (resume.ats_keywords_used.length === 0) {
    violations.push({
      type: "ATS_RISK",
      severity: "warning",
      location: "resume.ats_keywords_used",
      found_value: "0 keywords",
      explanation: "No ATS keywords tracked. The resume should intentionally include JD keywords for ATS matching.",
    });
  }

  checksRun++;
  for (let i = 0; i < resume.experience.length; i++) {
    const exp = resume.experience[i];
    if (exp.bullets.length < 2) {
      violations.push({
        type: "ATS_RISK",
        severity: "warning",
        location: `resume.experience[${i}]`,
        found_value: `${exp.bullets.length} bullet(s) for ${exp.employer}`,
        explanation: `Only ${exp.bullets.length} bullet(s) for ${exp.employer}. ATS-optimized resumes typically have 3-6 bullets per role.`,
      });
    }
  }

  return { violations, fixes, checksRun };
}

/**
 * NEW CHECK: Verify professional summary claims against the claims ledger.
 * The summary is the highest hallucination risk area — every factual claim must
 * be backed by the inventory.
 */
export function verifySummaryClaims(
  resume: TailoredResume,
  ledger: ClaimsLedger,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  checksRun++;
  const summary = resume.professional_summary || "";
  const metricCheck = validateAllMetricsInText(summary, ledger);
  for (const v of metricCheck.violations) {
    violations.push({
      type: "UNSUPPORTED_METRIC",
      severity: "critical",
      location: "resume.professional_summary",
      found_value: v.metric,
      explanation: `Metric "${v.metric}" in professional summary not found in claims ledger. ${v.reason}`,
    });
    fixes.push({
      location: "resume.professional_summary",
      current_text: v.metric,
      suggested_text: `[Remove "${v.metric}" or replace with a metric from the claims ledger]`,
      reason: "No-new-numbers rule: all metrics must come from the inventory",
      violation_type: "UNSUPPORTED_METRIC",
    });
  }

  return { violations, fixes, checksRun };
}

/**
 * NEW CHECK: Verify scope_line claims against the claims ledger.
 * scope_line is a high-risk field because it synthesizes multiple facts.
 */
export function verifyScopeLines(
  resume: TailoredResume,
  ledger: ClaimsLedger,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  for (let i = 0; i < resume.experience.length; i++) {
    const scopeLine = (resume.experience[i] as any).scope_line;
    if (!scopeLine) continue;

    checksRun++;
    const metricCheck = validateAllMetricsInText(scopeLine, ledger);
    for (const v of metricCheck.violations) {
      violations.push({
        type: "UNSUPPORTED_METRIC",
        severity: "critical",
        location: `resume.experience[${i}].scope_line`,
        found_value: v.metric,
        explanation: `Metric "${v.metric}" in scope_line for ${resume.experience[i].employer} not found in claims ledger. Scope lines must only contain verified facts.`,
      });
      fixes.push({
        location: `resume.experience[${i}].scope_line`,
        current_text: v.metric,
        suggested_text: `[Remove "${v.metric}" from scope_line — only verified inventory facts allowed]`,
        reason: "Scope line metrics must be in claims ledger",
        violation_type: "UNSUPPORTED_METRIC",
      });
    }
  }

  return { violations, fixes, checksRun };
}

/**
 * NEW CHECK: Validate executive_headline against inventory seniority.
 * Prevents claiming "Chief Data Officer" when inventory shows "Director".
 */
export function verifyHeadlineCalibration(
  resume: TailoredResume,
  inventory: Record<string, any>,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  checksRun++;
  const headline = (resume as any).executive_headline || "";
  if (!headline) return { violations, fixes, checksRun };

  const headlineLower = headline.toLowerCase();
  const inventoryTitles = (inventory.experience || []).map((e: any) => e.title?.toLowerCase() || "");

  // C-Suite headline check: only allow if inventory has C-suite or VP+ titles
  const cSuiteTerms = ["chief", "cdo", "cao", "cto", "cio", "cfo", "coo", "ceo", "cmo", "cpo"];
  const hasCsuiteHeadline = cSuiteTerms.some((t) => headlineLower.includes(t));

  if (hasCsuiteHeadline) {
    const hasCSuiteInInventory = inventoryTitles.some((t: string) =>
      cSuiteTerms.some((c) => t.includes(c)) || t.includes("vice president") || t.includes("vp"),
    );
    if (!hasCSuiteInInventory) {
      violations.push({
        type: "NEW_ENTITY",
        severity: "warning",
        location: "resume.executive_headline",
        found_value: headline,
        explanation: `Executive headline "${headline}" claims C-suite level, but inventory titles don't include C-suite or VP roles. Use a neutral headline matching actual seniority.`,
      });
    }
  }

  return { violations, fixes, checksRun };
}

/**
 * NEW CHECK: Validate cover letter body paragraphs for unledgered metrics.
 * Extends the existing metric check to scan ALL cover letter text.
 */
export function verifyCoverLetterClaims(
  coverLetter: TailoredCoverLetter,
  ledger: ClaimsLedger,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  const allText = [
    coverLetter.opening_paragraph,
    ...coverLetter.body_paragraphs,
    coverLetter.closing_paragraph,
  ].join(" ");

  checksRun++;
  const metricCheck = validateAllMetricsInText(allText, ledger);
  for (const v of metricCheck.violations) {
    violations.push({
      type: "UNSUPPORTED_METRIC",
      severity: "critical",
      location: "cover_letter.body",
      found_value: v.metric,
      explanation: `Metric "${v.metric}" in cover letter body not found in claims ledger. ${v.reason}`,
    });
  }

  return { violations, fixes, checksRun };
}

/**
 * NEW CHECK: Validate core_competencies don't claim tools/platforms not in ledger.
 * Core competencies should be STRATEGIC (e.g., "Revenue Optimization") not
 * tactical tool names unless the tool is in the inventory.
 */
export function verifyCoreCompetencies(
  resume: TailoredResume,
  ledger: ClaimsLedger,
): { violations: Violation[]; fixes: LineItemFix[]; checksRun: number } {
  const violations: Violation[] = [];
  const fixes: LineItemFix[] = [];
  let checksRun = 0;

  const coreCompetencies = (resume as any).core_competencies || [];

  // Known tool/platform names that should NOT be in core competencies unless in ledger
  const toolPatterns = [
    /\b(?:looker|tableau|power\s*bi|qlik|sigma|thoughtspot)\b/i,
    /\b(?:snowflake|databricks|bigquery|redshift|dbt)\b/i,
    /\b(?:python|java|scala|sql|r\b|spark|tensorflow|pytorch)\b/i,
    /\b(?:aws|gcp|azure|kubernetes|docker|airflow)\b/i,
    /\b(?:salesforce|hubspot|marketo|workday|sap)\b/i,
  ];

  for (const comp of coreCompetencies) {
    checksRun++;
    const compLower = comp.toLowerCase();
    for (const pattern of toolPatterns) {
      const match = compLower.match(pattern);
      if (match) {
        // Check if this tool is in the claims ledger
        const toolNorm = normalize(match[0]);
        const inLedger = ledger.tools.some((t) => t.normalized === toolNorm) ||
                         ledger.skills.some((s) => s.normalized === toolNorm);
        if (!inLedger) {
          violations.push({
            type: "NEW_ENTITY",
            severity: "critical",
            location: "resume.core_competencies",
            found_value: comp,
            explanation: `Core competency "${comp}" references tool "${match[0]}" not found in claims ledger. Either remove the tool name or rephrase as a strategic capability.`,
          });
          fixes.push({
            location: "resume.core_competencies",
            current_text: comp,
            suggested_text: `[Rephrase without naming "${match[0]}" — use strategic framing instead]`,
            reason: "Core competencies should be strategic, not tactical tool names unless tool is in inventory",
            violation_type: "NEW_ENTITY",
          });
        }
      }
    }
  }

  return { violations, fixes, checksRun };
}

export function runTruthfulnessVerification(
  resume: TailoredResume,
  coverLetter: TailoredCoverLetter,
  allowlist: EntityAllowlist,
  inventory: Record<string, any>,
): VerifierReport {
  const allViolations: Violation[] = [];
  const allFixes: LineItemFix[] = [];
  let totalChecks = 0;
  let entitiesChecked = 0;
  let metricsChecked = 0;
  let datesChecked = 0;
  let evidencePointersValidated = 0;
  let denylistScans = 0;

  const entityResult = verifyNewEntities(resume, coverLetter, allowlist);
  allViolations.push(...entityResult.violations);
  allFixes.push(...entityResult.fixes);
  entitiesChecked = entityResult.checksRun;
  totalChecks += entityResult.checksRun;

  const metricResult = verifyMetrics(resume, coverLetter, allowlist);
  allViolations.push(...metricResult.violations);
  allFixes.push(...metricResult.fixes);
  metricsChecked = metricResult.checksRun;
  totalChecks += metricResult.checksRun;

  const placeholderResult = verifyPlaceholders(resume, coverLetter, allowlist);
  allViolations.push(...placeholderResult.violations);
  allFixes.push(...placeholderResult.fixes);
  denylistScans = placeholderResult.checksRun;
  totalChecks += placeholderResult.checksRun;

  const dateResult = verifyDates(resume, allowlist);
  allViolations.push(...dateResult.violations);
  allFixes.push(...dateResult.fixes);
  datesChecked = dateResult.checksRun;
  totalChecks += dateResult.checksRun;

  const styleResult = verifyStyleRules(resume, coverLetter, inventory);
  allViolations.push(...styleResult.violations);
  allFixes.push(...styleResult.fixes);
  evidencePointersValidated = styleResult.checksRun;
  totalChecks += styleResult.checksRun;

  const atsResult = verifyATSRisks(resume);
  allViolations.push(...atsResult.violations);
  allFixes.push(...atsResult.fixes);
  totalChecks += atsResult.checksRun;

  // ── Claims Ledger checks (new hardened layer) ──
  const ledger = extractClaimsLedger(inventory);

  const summaryResult = verifySummaryClaims(resume, ledger);
  allViolations.push(...summaryResult.violations);
  allFixes.push(...summaryResult.fixes);
  totalChecks += summaryResult.checksRun;

  const scopeResult = verifyScopeLines(resume, ledger);
  allViolations.push(...scopeResult.violations);
  allFixes.push(...scopeResult.fixes);
  totalChecks += scopeResult.checksRun;

  const headlineResult = verifyHeadlineCalibration(resume, inventory);
  allViolations.push(...headlineResult.violations);
  allFixes.push(...headlineResult.fixes);
  totalChecks += headlineResult.checksRun;

  const clBodyResult = verifyCoverLetterClaims(coverLetter, ledger);
  allViolations.push(...clBodyResult.violations);
  allFixes.push(...clBodyResult.fixes);
  totalChecks += clBodyResult.checksRun;

  const compResult = verifyCoreCompetencies(resume, ledger);
  allViolations.push(...compResult.violations);
  allFixes.push(...compResult.fixes);
  totalChecks += compResult.checksRun;

  const criticalCount = allViolations.filter((v) => v.severity === "critical").length;
  const warningCount = allViolations.filter((v) => v.severity === "warning").length;

  return {
    pass: criticalCount === 0,
    violations: allViolations,
    line_item_fixes: allFixes,
    stats: {
      total_checks: totalChecks,
      critical_violations: criticalCount,
      warnings: warningCount,
      entities_checked: entitiesChecked,
      metrics_checked: metricsChecked,
      dates_checked: datesChecked,
      evidence_pointers_validated: evidencePointersValidated,
      denylist_scans: denylistScans,
    },
  };
}
