import * as fs from "fs";
import * as crypto from "crypto";
import { workspacePath } from "./paths";

export interface AllowlistEntry {
  value: string;
  normalized: string;
  sourceId: string;
  sourcePath: string;
}

export interface MetricEntry extends AllowlistEntry {
  number: string;
  unit: string;
  raw: string;
}

export interface EntityAllowlist {
  companies: AllowlistEntry[];
  titles: AllowlistEntry[];
  dates: AllowlistEntry[];
  locations: AllowlistEntry[];
  degrees: AllowlistEntry[];
  certifications: AllowlistEntry[];
  tools: AllowlistEntry[];
  metrics: MetricEntry[];
  skills: AllowlistEntry[];
}

export interface DenylistEntry {
  pattern: string;
  regex: RegExp;
  reason: string;
  category: "placeholder_domain" | "placeholder_phone" | "placeholder_name" | "placeholder_company" | "code_artifact" | "template_variable";
}

export interface EntityDenylist {
  entries: DenylistEntry[];
}

export interface AllowlistReport {
  allowlist: EntityAllowlist;
  denylist: EntityDenylist;
  stats: {
    companies: number;
    titles: number;
    dates: number;
    locations: number;
    degrees: number;
    certifications: number;
    tools: number;
    metrics: number;
    skills: number;
    denylistRules: number;
  };
  detectedPlaceholders: { field: string; value: string; reason: string }[];
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function parseMetric(raw: string): { number: string; unit: string } {
  const dollarMatch = raw.match(/^\$?([\d,.]+)\s*([MBKmbk]?\b.*)/);
  if (dollarMatch) {
    return { number: dollarMatch[1].replace(/,/g, ""), unit: raw.startsWith("$") ? `$${dollarMatch[2] || ""}`.trim() : dollarMatch[2].trim() };
  }
  const pctMatch = raw.match(/([\d,.]+)\s*%/);
  if (pctMatch) {
    return { number: pctMatch[1], unit: "%" };
  }
  const numMatch = raw.match(/([\d,.]+[+]?)\s*(.*)/);
  if (numMatch) {
    return { number: numMatch[1].replace(/,/g, ""), unit: numMatch[2].trim() };
  }
  return { number: raw, unit: "" };
}

const DEFAULT_DENYLIST: DenylistEntry[] = [
  {
    pattern: "example\\.com",
    regex: /example\.com/gi,
    reason: "Placeholder domain (example.com)",
    category: "placeholder_domain",
  },
  {
    pattern: "example\\.org",
    regex: /example\.org/gi,
    reason: "Placeholder domain (example.org)",
    category: "placeholder_domain",
  },
  {
    pattern: "test\\.com",
    regex: /\btest\.com\b/gi,
    reason: "Placeholder domain (test.com)",
    category: "placeholder_domain",
  },
  {
    pattern: "placeholder\\.com",
    regex: /placeholder\.com/gi,
    reason: "Placeholder domain",
    category: "placeholder_domain",
  },
  {
    pattern: "555-",
    regex: /\(?\s*555\s*\)?\s*[-.]?\s*\d{3}\s*[-.]?\s*\d{4}|\d{3}\s*[-.]?\s*555\s*[-.]?\s*\d{4}/g,
    reason: "Placeholder phone number (555 pattern)",
    category: "placeholder_phone",
  },
  {
    pattern: "Jane Doe",
    regex: /\bJane\s+Doe\b/gi,
    reason: "Placeholder name (Jane Doe)",
    category: "placeholder_name",
  },
  {
    pattern: "John Doe",
    regex: /\bJohn\s+Doe\b/gi,
    reason: "Placeholder name (John Doe)",
    category: "placeholder_name",
  },
  {
    pattern: "John Smith",
    regex: /\bJohn\s+Smith\b/gi,
    reason: "Placeholder name (John Smith)",
    category: "placeholder_name",
  },
  {
    pattern: "Acme",
    regex: /\bAcme\b/gi,
    reason: "Placeholder company name (Acme)",
    category: "placeholder_company",
  },
  {
    pattern: "ACME Corp",
    regex: /\bACME\s+Corp\b/gi,
    reason: "Placeholder company name (ACME Corp)",
    category: "placeholder_company",
  },
  {
    pattern: "Foo Bar",
    regex: /\bFoo\s*Bar\b/gi,
    reason: "Placeholder name (Foo Bar)",
    category: "placeholder_name",
  },
  {
    pattern: "[object Object]",
    regex: /\[object\s+Object\]/g,
    reason: "Code artifact ([object Object])",
    category: "code_artifact",
  },
  {
    pattern: "undefined",
    regex: /\bundefined\b/g,
    reason: "Code artifact (undefined)",
    category: "code_artifact",
  },
  {
    pattern: "null",
    regex: /\bnull\b/g,
    reason: "Code artifact (null literal)",
    category: "code_artifact",
  },
  {
    pattern: "NaN",
    regex: /\bNaN\b/g,
    reason: "Code artifact (NaN)",
    category: "code_artifact",
  },
  {
    pattern: "{{",
    regex: /\{\{[^}]*\}\}/g,
    reason: "Unresolved template variable ({{ }})",
    category: "template_variable",
  },
  {
    pattern: "${",
    regex: /\$\{[^}]*\}/g,
    reason: "Unresolved template variable (${ })",
    category: "template_variable",
  },
  {
    pattern: "<%= %>",
    regex: /<%[=\-]?\s*[^%]*%>/g,
    reason: "Unresolved template variable (<%= %>)",
    category: "template_variable",
  },
  {
    pattern: "lorem ipsum",
    regex: /\blorem\s+ipsum\b/gi,
    reason: "Placeholder text (Lorem Ipsum)",
    category: "placeholder_name",
  },
  {
    pattern: "TODO",
    regex: /\bTODO\b/g,
    reason: "Unresolved TODO marker",
    category: "code_artifact",
  },
  {
    pattern: "FIXME",
    regex: /\bFIXME\b/g,
    reason: "Unresolved FIXME marker",
    category: "code_artifact",
  },
  {
    pattern: "xxx",
    regex: /\bxxx+\b/gi,
    reason: "Placeholder text (xxx)",
    category: "placeholder_name",
  },
  {
    pattern: "TBD",
    regex: /\bTBD\b/g,
    reason: "Unresolved TBD placeholder",
    category: "code_artifact",
  },
];

export function buildEntityAllowlist(inventory?: any): EntityAllowlist {
  if (!inventory) {
    const inventoryPath = workspacePath("experience_inventory.json");
    inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  }

  const companies: AllowlistEntry[] = [];
  const titles: AllowlistEntry[] = [];
  const dates: AllowlistEntry[] = [];
  const locations: AllowlistEntry[] = [];
  const degrees: AllowlistEntry[] = [];
  const certifications: AllowlistEntry[] = [];
  const tools: AllowlistEntry[] = [];
  const metrics: MetricEntry[] = [];
  const skills: AllowlistEntry[] = [];

  if (inventory.profile) {
    const p = inventory.profile;
    if (p.current_title) {
      titles.push({ value: p.current_title, normalized: normalize(p.current_title), sourceId: "profile", sourcePath: "profile.current_title" });
    }
    if (p.location) {
      locations.push({ value: p.location, normalized: normalize(p.location), sourceId: "profile", sourcePath: "profile.location" });
    }
  }

  for (let i = 0; i < (inventory.experience || []).length; i++) {
    const exp = inventory.experience[i];
    companies.push({ value: exp.employer, normalized: normalize(exp.employer), sourceId: exp.id, sourcePath: `experience[${i}].employer` });
    titles.push({ value: exp.title, normalized: normalize(exp.title), sourceId: exp.id, sourcePath: `experience[${i}].title` });

    if (exp.start_date) {
      dates.push({ value: exp.start_date, normalized: exp.start_date.toLowerCase(), sourceId: exp.id, sourcePath: `experience[${i}].start_date` });
    }
    if (exp.end_date) {
      dates.push({ value: exp.end_date, normalized: exp.end_date.toLowerCase(), sourceId: exp.id, sourcePath: `experience[${i}].end_date` });
    }
    if (exp.location) {
      locations.push({ value: exp.location, normalized: normalize(exp.location), sourceId: exp.id, sourcePath: `experience[${i}].location` });
    }

    for (let j = 0; j < (exp.bullets || []).length; j++) {
      const bullet = exp.bullets[j];
      for (const m of bullet.metrics || []) {
        const parsed = parseMetric(m);
        metrics.push({
          value: m,
          normalized: normalize(m),
          sourceId: bullet.id,
          sourcePath: `experience[${i}].bullets[${j}].metrics`,
          number: parsed.number,
          unit: parsed.unit,
          raw: m,
        });
      }
      for (const t of bullet.tools || []) {
        const exists = tools.some(e => e.normalized === normalize(t));
        if (!exists) {
          tools.push({ value: t, normalized: normalize(t), sourceId: bullet.id, sourcePath: `experience[${i}].bullets[${j}].tools` });
        }
      }
    }
  }

  for (let i = 0; i < (inventory.education || []).length; i++) {
    const edu = inventory.education[i];
    if (edu.degree) {
      degrees.push({ value: edu.degree, normalized: normalize(edu.degree), sourceId: edu.id, sourcePath: `education[${i}].degree` });
    }
    if (edu.institution) {
      companies.push({ value: edu.institution, normalized: normalize(edu.institution), sourceId: edu.id, sourcePath: `education[${i}].institution` });
    }
    if (edu.year) {
      dates.push({ value: edu.year, normalized: edu.year, sourceId: edu.id, sourcePath: `education[${i}].year` });
    }
  }

  for (let i = 0; i < (inventory.certifications || []).length; i++) {
    const cert = inventory.certifications[i];
    const certName = typeof cert === "string" ? cert : cert.name;
    const certId = typeof cert === "string" ? `cert-${i}` : cert.id;
    certifications.push({ value: certName, normalized: normalize(certName), sourceId: certId, sourcePath: `certifications[${i}]` });
    if (typeof cert === "object" && cert.year) {
      dates.push({ value: cert.year, normalized: cert.year, sourceId: certId, sourcePath: `certifications[${i}].year` });
    }
  }

  const skillCategories = inventory.skills || {};
  for (const [category, skillList] of Object.entries(skillCategories)) {
    for (const skill of (skillList as string[]) || []) {
      skills.push({ value: skill, normalized: normalize(skill), sourceId: `skill-${category}`, sourcePath: `skills.${category}` });
      const existsInTools = tools.some(e => e.normalized === normalize(skill));
      if (!existsInTools) {
        tools.push({ value: skill, normalized: normalize(skill), sourceId: `skill-${category}`, sourcePath: `skills.${category}` });
      }
    }
  }

  return { companies, titles, dates, locations, degrees, certifications, tools, metrics, skills };
}

export function buildEntityDenylist(customEntries?: DenylistEntry[]): EntityDenylist {
  const entries = [...DEFAULT_DENYLIST];
  if (customEntries) {
    entries.push(...customEntries);
  }
  return { entries };
}

export function scanForPlaceholders(inventory: any): { field: string; value: string; reason: string }[] {
  const detected: { field: string; value: string; reason: string }[] = [];
  const denylist = buildEntityDenylist();

  function scanValue(field: string, value: string) {
    if (typeof value !== "string") return;
    for (const entry of denylist.entries) {
      const re = new RegExp(entry.regex.source, entry.regex.flags);
      if (re.test(value)) {
        detected.push({ field, value, reason: entry.reason });
      }
    }
  }

  if (inventory.profile) {
    for (const [key, val] of Object.entries(inventory.profile)) {
      scanValue(`profile.${key}`, val as string);
    }
  }

  for (let i = 0; i < (inventory.experience || []).length; i++) {
    const exp = inventory.experience[i];
    scanValue(`experience[${i}].employer`, exp.employer);
    scanValue(`experience[${i}].title`, exp.title);
    scanValue(`experience[${i}].location`, exp.location || "");
    for (let j = 0; j < (exp.bullets || []).length; j++) {
      scanValue(`experience[${i}].bullets[${j}].text`, exp.bullets[j].text);
    }
  }

  for (let i = 0; i < (inventory.education || []).length; i++) {
    const edu = inventory.education[i];
    scanValue(`education[${i}].institution`, edu.institution || "");
    scanValue(`education[${i}].degree`, edu.degree || "");
  }

  return detected;
}

export function checkTextAgainstDenylist(text: string, denylist: EntityDenylist): { matched: boolean; violations: { pattern: string; reason: string; match: string }[] } {
  const violations: { pattern: string; reason: string; match: string }[] = [];

  for (const entry of denylist.entries) {
    const re = new RegExp(entry.regex.source, entry.regex.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      violations.push({ pattern: entry.pattern, reason: entry.reason, match: match[0] });
      if (!entry.regex.flags.includes("g")) break;
    }
  }

  return { matched: violations.length > 0, violations };
}

export function checkTextAgainstAllowlist(text: string, allowlist: EntityAllowlist): { companies: string[]; tools: string[]; metrics: string[]; dates: string[]; unlisted: string[] } {
  const foundCompanies: string[] = [];
  const foundTools: string[] = [];
  const foundMetrics: string[] = [];
  const foundDates: string[] = [];
  const unlisted: string[] = [];

  const textNorm = normalize(text);

  for (const entry of allowlist.companies) {
    if (textNorm.includes(entry.normalized)) {
      foundCompanies.push(entry.value);
    }
  }

  for (const entry of allowlist.tools) {
    if (entry.normalized.length >= 2 && textNorm.includes(entry.normalized)) {
      foundTools.push(entry.value);
    }
  }

  const yearPattern = /\b(19|20)\d{2}\b/g;
  const yearsFound = new Set((text.match(yearPattern) || []).map(y => y.trim()));
  const currentYear = new Date().getFullYear().toString();
  for (const year of yearsFound) {
    if (year === currentYear) continue;
    const inList = allowlist.dates.some(d => d.value === year || d.normalized.includes(year));
    if (inList) {
      foundDates.push(year);
    } else {
      unlisted.push(`year: ${year}`);
    }
  }

  const numberMatches = text.match(/\$[\d,.]+[MBK]?|\d+[\d,.]*%|\d{3,}[\d,.]*[+]?/g) || [];
  for (const num of numberMatches) {
    const stripped = num.replace(/[$,%.\s]+$/g, "").replace(/[$,%]/g, "").replace(/,/g, "");
    if (yearsFound.has(stripped) || stripped === currentYear) continue;
    const numNorm = normalize(num);
    const inList = allowlist.metrics.some(m =>
      m.normalized.includes(numNorm) || numNorm.includes(m.normalized) || m.number === stripped
    );
    if (inList) {
      foundMetrics.push(num);
    } else {
      unlisted.push(`number: ${num}`);
    }
  }

  return { companies: foundCompanies, tools: foundTools, metrics: foundMetrics, dates: foundDates, unlisted };
}

export function buildAllowlistReport(inventory?: any): AllowlistReport {
  if (!inventory) {
    const inventoryPath = workspacePath("experience_inventory.json");
    inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  }

  const allowlist = buildEntityAllowlist(inventory);
  const denylist = buildEntityDenylist();
  const detectedPlaceholders = scanForPlaceholders(inventory);

  return {
    allowlist,
    denylist,
    stats: {
      companies: allowlist.companies.length,
      titles: allowlist.titles.length,
      dates: allowlist.dates.length,
      locations: allowlist.locations.length,
      degrees: allowlist.degrees.length,
      certifications: allowlist.certifications.length,
      tools: allowlist.tools.length,
      metrics: allowlist.metrics.length,
      skills: allowlist.skills.length,
      denylistRules: denylist.entries.length,
    },
    detectedPlaceholders,
  };
}
