/**
 * Stage 1 — Claims Ledger Extractor
 *
 * Extracts every verifiable claim from a resume, whether provided as:
 *   (a) raw text  — parsed by the sub-parsers below, or
 *   (b) a structured JSON inventory — delegated to the existing claimsLedger.ts
 *
 * Every claim gets a unique ID (`cl-{role_index}-{type}-{seq}`) and lands in a
 * ClaimsLedger that downstream stages consume.  If a bullet cannot cite a claim,
 * it gets rejected — this module builds the foundation for that hard gate.
 */

import type {
  Claim,
  ClaimType,
  ClaimsLedger,
} from "../types";

import {
  extractClaimsLedger as extractLegacyLedger,
  type ClaimsLedger as LegacyClaimsLedger,
  type Claim as LegacyClaim,
} from "../../mastra/tools/claimsLedger";

// ── Helpers ───────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Build a sequential claim ID in the pipeline's naming convention. */
function makeClaimId(roleIndex: number | null, type: ClaimType, seq: number): string {
  const ri = roleIndex !== null ? String(roleIndex) : "g";
  return `cl-${ri}-${type}-${seq}`;
}

// ── Tool Catalogue ────────────────────────────────────────────────

interface ToolEntry {
  canonical: string;
  category: Claim["tool_detail"] extends undefined ? never : NonNullable<Claim["tool_detail"]>["category"];
  aliases: string[];
}

const TOOL_CATALOGUE: ToolEntry[] = [
  // Languages
  { canonical: "Python", category: "language", aliases: ["python"] },
  { canonical: "R", category: "language", aliases: ["r lang", "r language"] },
  { canonical: "SQL", category: "language", aliases: ["sql", "t-sql", "tsql", "plsql", "pl/sql", "mysql", "postgresql", "postgres"] },
  { canonical: "Java", category: "language", aliases: ["java"] },
  { canonical: "Scala", category: "language", aliases: ["scala"] },
  { canonical: "JavaScript", category: "language", aliases: ["javascript", "js"] },
  { canonical: "TypeScript", category: "language", aliases: ["typescript", "ts"] },
  { canonical: "Go", category: "language", aliases: ["golang"] },
  { canonical: "C++", category: "language", aliases: ["c++", "cpp"] },
  { canonical: "C#", category: "language", aliases: ["c#", "csharp", "c sharp"] },
  { canonical: "Ruby", category: "language", aliases: ["ruby"] },
  { canonical: "SAS", category: "language", aliases: ["sas"] },
  { canonical: "MATLAB", category: "language", aliases: ["matlab"] },
  { canonical: "Julia", category: "language", aliases: ["julia"] },
  { canonical: "Bash", category: "language", aliases: ["bash", "shell", "sh"] },

  // Platforms / Cloud
  { canonical: "AWS", category: "cloud", aliases: ["aws", "amazon web services"] },
  { canonical: "GCP", category: "cloud", aliases: ["gcp", "google cloud", "google cloud platform"] },
  { canonical: "Azure", category: "cloud", aliases: ["azure", "microsoft azure"] },
  { canonical: "Snowflake", category: "platform", aliases: ["snowflake"] },
  { canonical: "Databricks", category: "platform", aliases: ["databricks"] },
  { canonical: "Redshift", category: "database", aliases: ["redshift", "amazon redshift"] },
  { canonical: "BigQuery", category: "database", aliases: ["bigquery", "big query"] },
  { canonical: "Teradata", category: "database", aliases: ["teradata"] },
  { canonical: "MongoDB", category: "database", aliases: ["mongodb", "mongo"] },
  { canonical: "DynamoDB", category: "database", aliases: ["dynamodb"] },
  { canonical: "Cassandra", category: "database", aliases: ["cassandra"] },
  { canonical: "Redis", category: "database", aliases: ["redis"] },
  { canonical: "Elasticsearch", category: "database", aliases: ["elasticsearch", "elastic search", "elastic"] },
  { canonical: "Oracle", category: "database", aliases: ["oracle", "oracle db"] },

  // BI Tools
  { canonical: "Tableau", category: "bi_tool", aliases: ["tableau"] },
  { canonical: "Looker", category: "bi_tool", aliases: ["looker"] },
  { canonical: "Power BI", category: "bi_tool", aliases: ["power bi", "powerbi"] },
  { canonical: "Qlik", category: "bi_tool", aliases: ["qlik", "qlikview", "qliksense", "qlik sense"] },
  { canonical: "Metabase", category: "bi_tool", aliases: ["metabase"] },
  { canonical: "Superset", category: "bi_tool", aliases: ["superset", "apache superset"] },
  { canonical: "Sigma", category: "bi_tool", aliases: ["sigma", "sigma computing"] },
  { canonical: "Mode", category: "bi_tool", aliases: ["mode analytics"] },
  { canonical: "ThoughtSpot", category: "bi_tool", aliases: ["thoughtspot"] },

  // Frameworks / Libraries
  { canonical: "Spark", category: "framework", aliases: ["spark", "apache spark", "pyspark"] },
  { canonical: "Kafka", category: "framework", aliases: ["kafka", "apache kafka"] },
  { canonical: "Airflow", category: "framework", aliases: ["airflow", "apache airflow"] },
  { canonical: "dbt", category: "framework", aliases: ["dbt", "data build tool"] },
  { canonical: "Terraform", category: "framework", aliases: ["terraform"] },
  { canonical: "Docker", category: "framework", aliases: ["docker"] },
  { canonical: "Kubernetes", category: "framework", aliases: ["kubernetes", "k8s"] },
  { canonical: "TensorFlow", category: "framework", aliases: ["tensorflow"] },
  { canonical: "PyTorch", category: "framework", aliases: ["pytorch"] },
  { canonical: "Scikit-learn", category: "framework", aliases: ["scikit-learn", "sklearn", "scikit learn"] },
  { canonical: "Pandas", category: "framework", aliases: ["pandas"] },
  { canonical: "NumPy", category: "framework", aliases: ["numpy"] },
  { canonical: "Hadoop", category: "framework", aliases: ["hadoop", "apache hadoop"] },
  { canonical: "Flink", category: "framework", aliases: ["flink", "apache flink"] },
  { canonical: "Luigi", category: "framework", aliases: ["luigi"] },
  { canonical: "Prefect", category: "framework", aliases: ["prefect"] },
  { canonical: "Dagster", category: "framework", aliases: ["dagster"] },
  { canonical: "MLflow", category: "framework", aliases: ["mlflow"] },
  { canonical: "SageMaker", category: "platform", aliases: ["sagemaker", "aws sagemaker"] },
  { canonical: "Vertex AI", category: "platform", aliases: ["vertex ai", "vertex"] },
  { canonical: "Fivetran", category: "platform", aliases: ["fivetran"] },
  { canonical: "Stitch", category: "platform", aliases: ["stitch"] },
  { canonical: "Matillion", category: "platform", aliases: ["matillion"] },
  { canonical: "Informatica", category: "platform", aliases: ["informatica"] },
  { canonical: "Talend", category: "platform", aliases: ["talend"] },
  { canonical: "Alteryx", category: "platform", aliases: ["alteryx"] },
  { canonical: "Datadog", category: "platform", aliases: ["datadog"] },
  { canonical: "Splunk", category: "platform", aliases: ["splunk"] },
  { canonical: "Grafana", category: "platform", aliases: ["grafana"] },
  { canonical: "Prometheus", category: "platform", aliases: ["prometheus"] },
  { canonical: "Jenkins", category: "platform", aliases: ["jenkins"] },
  { canonical: "GitHub Actions", category: "platform", aliases: ["github actions"] },
  { canonical: "CircleCI", category: "platform", aliases: ["circleci", "circle ci"] },
  { canonical: "Jira", category: "platform", aliases: ["jira"] },
  { canonical: "Confluence", category: "platform", aliases: ["confluence"] },
  { canonical: "Salesforce", category: "platform", aliases: ["salesforce", "sfdc"] },
  { canonical: "SAP", category: "platform", aliases: ["sap"] },
  { canonical: "Excel", category: "bi_tool", aliases: ["excel", "microsoft excel"] },
  { canonical: "Google Sheets", category: "bi_tool", aliases: ["google sheets", "gsheets"] },
  { canonical: "SPSS", category: "framework", aliases: ["spss"] },
  { canonical: "Stata", category: "framework", aliases: ["stata"] },
  { canonical: "D3.js", category: "framework", aliases: ["d3", "d3.js"] },
  { canonical: "React", category: "framework", aliases: ["react", "reactjs", "react.js"] },
  { canonical: "Node.js", category: "framework", aliases: ["node.js", "nodejs", "node"] },
  { canonical: "FastAPI", category: "framework", aliases: ["fastapi"] },
  { canonical: "Flask", category: "framework", aliases: ["flask"] },
  { canonical: "Django", category: "framework", aliases: ["django"] },
  { canonical: "Streamlit", category: "framework", aliases: ["streamlit"] },
  { canonical: "Great Expectations", category: "framework", aliases: ["great expectations"] },
  { canonical: "Monte Carlo", category: "platform", aliases: ["monte carlo"] },
  { canonical: "Collibra", category: "platform", aliases: ["collibra"] },
  { canonical: "Alation", category: "platform", aliases: ["alation"] },
  { canonical: "Atlan", category: "platform", aliases: ["atlan"] },
  { canonical: "Unity Catalog", category: "platform", aliases: ["unity catalog"] },
  { canonical: "Delta Lake", category: "framework", aliases: ["delta lake", "delta"] },
  { canonical: "Iceberg", category: "framework", aliases: ["iceberg", "apache iceberg"] },
  { canonical: "Hudi", category: "framework", aliases: ["hudi", "apache hudi"] },
];

// Pre-build a case-insensitive lookup map: lowercased alias/canonical -> ToolEntry
const TOOL_LOOKUP = new Map<string, ToolEntry>();
for (const entry of TOOL_CATALOGUE) {
  TOOL_LOOKUP.set(entry.canonical.toLowerCase(), entry);
  for (const alias of entry.aliases) {
    TOOL_LOOKUP.set(alias.toLowerCase(), entry);
  }
}

// ── Capability Domains ────────────────────────────────────────────

interface CapabilityDomain {
  domain: string;
  keywords: string[];
}

const CAPABILITY_DOMAINS: CapabilityDomain[] = [
  { domain: "forecasting", keywords: ["forecast", "forecasting", "prediction", "predictive", "projections", "time series", "demand planning"] },
  { domain: "governance", keywords: ["governance", "compliance", "regulatory", "audit", "policy", "controls", "sox", "gdpr", "hipaa", "pci"] },
  { domain: "data quality", keywords: ["data quality", "quality assurance", "data validation", "data integrity", "cleansing", "deduplication", "profiling"] },
  { domain: "revenue optimization", keywords: ["revenue", "monetization", "pricing", "yield", "arpu", "ltv", "conversion", "upsell", "cross-sell"] },
  { domain: "cost reduction", keywords: ["cost reduction", "cost savings", "cost optimization", "efficiency", "reduce cost", "savings", "consolidat"] },
  { domain: "machine learning", keywords: ["machine learning", "ml model", "deep learning", "neural network", "nlp", "computer vision", "classification", "regression", "clustering", "recommendation"] },
  { domain: "data engineering", keywords: ["data pipeline", "etl", "elt", "data warehouse", "data lake", "data lakehouse", "ingestion", "orchestration", "batch processing", "stream processing"] },
  { domain: "analytics", keywords: ["analytics", "business intelligence", "reporting", "dashboard", "kpi", "metrics", "insights", "self-service analytics"] },
  { domain: "data strategy", keywords: ["data strategy", "data mesh", "data fabric", "data catalog", "metadata", "data democratization", "data literacy"] },
  { domain: "stakeholder management", keywords: ["stakeholder", "executive", "c-suite", "board", "cross-functional", "alignment", "influence", "partnership"] },
  { domain: "team leadership", keywords: ["team lead", "managed team", "built team", "hired", "mentored", "coaching", "performance review", "direct reports", "skip-level", "onboarded"] },
  { domain: "product analytics", keywords: ["product analytics", "a/b test", "experimentation", "funnel", "user behavior", "retention", "cohort", "product metric"] },
  { domain: "cloud migration", keywords: ["cloud migration", "migrated to", "lift and shift", "replatform", "on-prem to cloud", "moderniz"] },
  { domain: "automation", keywords: ["automat", "workflow automation", "rpa", "self-service", "reduce manual", "eliminated manual"] },
  { domain: "security", keywords: ["security", "infosec", "cybersecurity", "encryption", "access control", "iam", "zero trust", "vulnerability"] },
  { domain: "real-time", keywords: ["real-time", "real time", "streaming", "low-latency", "sub-second", "event-driven", "cdc"] },
  { domain: "financial analysis", keywords: ["financial analysis", "p&l", "profit and loss", "budget", "financial model", "variance analysis", "opex", "capex", "roi"] },
  { domain: "customer analytics", keywords: ["customer analytics", "churn", "segmentation", "customer lifetime", "nps", "csat", "customer 360", "propensity"] },
  { domain: "supply chain", keywords: ["supply chain", "inventory management", "logistics", "procurement", "demand forecast", "supplier", "warehouse"] },
  { domain: "risk management", keywords: ["risk management", "risk model", "credit risk", "market risk", "operational risk", "fraud detection", "anomaly"] },
];

// ── Section Detection ─────────────────────────────────────────────

interface ResumeSection {
  name: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

const SECTION_HEADERS = [
  { pattern: /^(?:professional\s+)?experience$/i, name: "experience" },
  { pattern: /^(?:work\s+)?history$/i, name: "experience" },
  { pattern: /^education$/i, name: "education" },
  { pattern: /^certifications?$/i, name: "certifications" },
  { pattern: /^(?:technical\s+)?skills$/i, name: "skills" },
  { pattern: /^(?:core\s+)?competencies$/i, name: "skills" },
  { pattern: /^summary$/i, name: "summary" },
  { pattern: /^(?:professional\s+)?summary$/i, name: "summary" },
  { pattern: /^(?:executive\s+)?profile$/i, name: "summary" },
  { pattern: /^objective$/i, name: "summary" },
  { pattern: /^projects?$/i, name: "projects" },
  { pattern: /^publications?$/i, name: "publications" },
  { pattern: /^awards?\s*(?:&|and)?\s*(?:honors?)?$/i, name: "awards" },
  { pattern: /^volunteer(?:ing)?(?:\s+experience)?$/i, name: "volunteer" },
  { pattern: /^leadership$/i, name: "leadership" },
  { pattern: /^(?:additional\s+)?information$/i, name: "additional" },
];

function detectSections(lines: string[]): ResumeSection[] {
  const sections: ResumeSection[] = [];
  let currentSection: { name: string; startLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Check for section header: line is short, possibly ALL CAPS or Title Case, matches a known header
    const cleaned = trimmed.replace(/[:\-—_=|]+$/g, "").trim();
    const match = SECTION_HEADERS.find((h) => h.pattern.test(cleaned));

    if (match && cleaned.length < 60) {
      if (currentSection) {
        sections.push({
          name: currentSection.name,
          startLine: currentSection.startLine,
          endLine: i - 1,
          lines: lines.slice(currentSection.startLine + 1, i),
        });
      }
      currentSection = { name: match.name, startLine: i };
    }
  }

  // Close the last section
  if (currentSection) {
    sections.push({
      name: currentSection.name,
      startLine: currentSection.startLine,
      endLine: lines.length - 1,
      lines: lines.slice(currentSection.startLine + 1),
    });
  }

  // If no sections detected, treat the entire text as one block
  if (sections.length === 0) {
    sections.push({
      name: "body",
      startLine: 0,
      endLine: lines.length - 1,
      lines: [...lines],
    });
  }

  return sections;
}

// ── Sub-Parser: Roles ─────────────────────────────────────────────

interface ParsedRole {
  employer: string;
  title: string;
  start_date: string;
  end_date: string;
  location: string;
  section: string;
  original_text: string;
  bullets: string[];
  roleIndex: number;
}

// Month names for date patterns
const MONTH_NAMES = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

// Various date pattern fragments
const DATE_MONTH_YEAR = `${MONTH_NAMES}[.,]?\\s+\\d{4}`;
const DATE_YYYY_MM = `\\d{4}[-/]\\d{2}`;
const DATE_YEAR_ONLY = `\\d{4}`;
const DATE_PRESENT = `(?:Present|Current|Now|Ongoing)`;
const DATE_SINGLE = `(?:${DATE_MONTH_YEAR}|${DATE_YYYY_MM}|${DATE_YEAR_ONLY}|${DATE_PRESENT})`;
const DATE_RANGE = `(${DATE_SINGLE})\\s*[-–—to]+\\s*(${DATE_SINGLE})`;

const DATE_RANGE_RE = new RegExp(DATE_RANGE, "i");

/**
 * Detect role blocks within an experience section.
 *
 * Common patterns:
 *   EMPLOYER | TITLE | Jan 2020 - Present
 *   EMPLOYER — TITLE (Jan 2020 – Dec 2022) — City, ST
 *   TITLE, EMPLOYER (2020-01 - 2023-01)
 *   EMPLOYER\nTITLE\nJan 2020 - Present
 */
function parseRoles(experienceSection: ResumeSection, startingIndex: number): ParsedRole[] {
  const roles: ParsedRole[] = [];
  const lines = experienceSection.lines;
  let currentRole: Partial<ParsedRole> | null = null;
  let bullets: string[] = [];
  let roleCount = startingIndex;

  // Flush the current in-progress role into the results array
  function flushRole(): void {
    if (currentRole && (currentRole.employer || currentRole.title)) {
      roles.push({
        employer: currentRole.employer || "Unknown",
        title: currentRole.title || "Unknown",
        start_date: currentRole.start_date || "",
        end_date: currentRole.end_date || "",
        location: currentRole.location || "",
        section: experienceSection.name,
        original_text: currentRole.original_text || "",
        bullets,
        roleIndex: roleCount,
      });
      roleCount++;
      bullets = [];
      currentRole = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check if this line contains a date range — strong indicator of a role header
    const dateMatch = line.match(DATE_RANGE_RE);
    if (dateMatch) {
      flushRole();

      const startDate = dateMatch[1].trim();
      const endDate = dateMatch[2].trim();

      // Remove the date range from the line to parse the rest
      const withoutDate = line.replace(DATE_RANGE_RE, "").trim();

      // Try to split the remainder into employer / title / location using common delimiters
      const parts = withoutDate
        .split(/\s*[|–—•·,]\s*/)
        .map((p) => p.replace(/[()[\]]/g, "").trim())
        .filter((p) => p.length > 0);

      // Heuristic: first non-trivial part is employer, second is title; location may follow
      const employer = parts[0] || "";
      const title = parts[1] || "";
      const location = parts.slice(2).join(", ");

      currentRole = {
        employer,
        title,
        start_date: startDate,
        end_date: endDate,
        location,
        original_text: line,
        roleIndex: roleCount,
      };
      continue;
    }

    // Bullet line detection
    const isBullet = /^[-•*▪►●○◦→]\s/.test(line) || /^\d+[.)]\s/.test(line);
    if (isBullet && currentRole) {
      bullets.push(line.replace(/^[-•*▪►●○◦→]\s*/, "").replace(/^\d+[.)]\s*/, ""));
      continue;
    }

    // If no current role and line looks like a heading (short, no bullet), check if the
    // next line(s) might contain a title or date
    if (!currentRole && !isBullet && line.length < 120) {
      // Look ahead to see if next line has a date range
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
      const nextDateMatch = nextLine.match(DATE_RANGE_RE);

      if (nextDateMatch) {
        // This line is the employer (or combined employer/title), next has dates
        const startDate = nextDateMatch[1].trim();
        const endDate = nextDateMatch[2].trim();
        const remainder = nextLine.replace(DATE_RANGE_RE, "").trim();

        const parts = line
          .split(/\s*[|–—•·]\s*/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);

        const remainderParts = remainder
          .split(/\s*[|–—•·,]\s*/)
          .map((p) => p.replace(/[()[\]]/g, "").trim())
          .filter((p) => p.length > 0);

        const allParts = [...parts, ...remainderParts];
        const employer = allParts[0] || "";
        const title = allParts[1] || "";
        const location = allParts.slice(2).join(", ");

        currentRole = {
          employer,
          title,
          start_date: startDate,
          end_date: endDate,
          location,
          original_text: `${line}\n${nextLine}`,
          roleIndex: roleCount,
        };
        i++; // Skip the date line we just consumed
        continue;
      }
    }

    // Continuation line — if we have a current role, treat as bullet content
    if (currentRole && line.length > 20) {
      bullets.push(line);
    }
  }

  flushRole();
  return roles;
}

// ── Sub-Parser: Metrics ───────────────────────────────────────────

interface ParsedMetric {
  number: number;
  unit: string;
  display: string;
  originalText: string;
}

function parseMetrics(text: string): ParsedMetric[] {
  const results: ParsedMetric[] = [];
  const seen = new Set<string>();

  function add(m: ParsedMetric): void {
    const key = `${m.number}|${m.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(m);
  }

  // Dollar amounts with suffix: $12M, $4.5B, $500K, $12,000,000
  const dollarSuffix = /\$\s*([\d,.]+)\s*([BMKbmk])\b/g;
  let match: RegExpExecArray | null;
  while ((match = dollarSuffix.exec(text)) !== null) {
    const raw = parseFloat(match[1].replace(/,/g, ""));
    const suffix = match[2].toUpperCase();
    const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : 1_000;
    add({
      number: raw * multiplier,
      unit: `$${suffix}`,
      display: match[0].trim(),
      originalText: match[0],
    });
  }

  // Plain dollar amounts: $12,000,000 or $500
  const dollarPlain = /\$\s*([\d,]+(?:\.\d+)?)\b(?!\s*[BMKbmk])/g;
  while ((match = dollarPlain.exec(text)) !== null) {
    const val = parseFloat(match[1].replace(/,/g, ""));
    add({
      number: val,
      unit: "$",
      display: match[0].trim(),
      originalText: match[0],
    });
  }

  // Percentages: 35%, 12.5%
  const pctRe = /([\d,.]+)\s*%/g;
  while ((match = pctRe.exec(text)) !== null) {
    add({
      number: parseFloat(match[1].replace(/,/g, "")),
      unit: "%",
      display: match[0].trim(),
      originalText: match[0],
    });
  }

  // Counts with descriptors: "60+ FTEs", "12-person team", "3 business units"
  const countRe = /([\d,]+)\+?\s*[-]?\s*(person|people|FTEs?|members?|engineers?|scientists?|analysts?|reports?|employees?|team\s*members?|direct\s*reports?|business\s*units?|countries|regions?|offices?|locations?|departments?|clients?|customers?|users?|applications?|systems?|projects?|products?|models?|dashboards?|reports?|data\s*sources?|pipelines?|microservices?|endpoints?|APIs?|repositories|servers?|clusters?|nodes?)/gi;
  while ((match = countRe.exec(text)) !== null) {
    add({
      number: parseFloat(match[1].replace(/,/g, "")),
      unit: match[2].toLowerCase().trim(),
      display: match[0].trim(),
      originalText: match[0],
    });
  }

  // Multipliers: 3x, 5x, 10x
  const multRe = /\b([\d,.]+)\s*[xX]\b/g;
  while ((match = multRe.exec(text)) !== null) {
    add({
      number: parseFloat(match[1].replace(/,/g, "")),
      unit: "x",
      display: match[0].trim(),
      originalText: match[0],
    });
  }

  return results;
}

// ── Sub-Parser: Scope ─────────────────────────────────────────────

interface ParsedScope {
  kind: NonNullable<Claim["scope_detail"]>["kind"];
  number?: number;
  unit?: string;
  display: string;
  originalText: string;
}

function parseScope(text: string): ParsedScope[] {
  const results: ParsedScope[] = [];
  const seen = new Set<string>();

  function add(s: ParsedScope): void {
    const key = `${s.kind}|${s.display}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(s);
  }

  // Team size: "led team of 45", "managed 12 analysts", "45-person team"
  const teamPatterns: RegExp[] = [
    /(?:led|managed|oversaw|supervised|directed|headed)\s+(?:a\s+)?(?:team\s+of\s+)?([\d,]+)\+?\s*(?:[-]?\s*)?(person|people|FTEs?|members?|engineers?|scientists?|analysts?|developers?|employees?|reports?|professionals?|staff|consultants?)/gi,
    /([\d,]+)\+?\s*[-]?\s*(?:person|member|FTE)\s+team/gi,
    /team\s+of\s+([\d,]+)\+?\s*/gi,
    /([\d,]+)\+?\s+direct\s+reports?/gi,
  ];

  for (const re of teamPatterns) {
    let match: RegExpExecArray | null;
    const localRe = new RegExp(re.source, re.flags);
    while ((match = localRe.exec(text)) !== null) {
      add({
        kind: "team_size",
        number: parseFloat(match[1].replace(/,/g, "")),
        unit: "people",
        display: match[0].trim(),
        originalText: match[0],
      });
    }
  }

  // Budget: "$8M budget", "$17M investment", "budget of $5M"
  const budgetPatterns: RegExp[] = [
    /\$\s*([\d,.]+)\s*([BMKbmk])?\s*(?:budget|investment|portfolio|spend|p&l|opex|capex)/gi,
    /budget\s+of\s+\$\s*([\d,.]+)\s*([BMKbmk])?/gi,
    /(?:managed|oversaw|controlled|owned)\s+\$\s*([\d,.]+)\s*([BMKbmk])?\s+(?:budget|portfolio|spend|p&l)/gi,
  ];

  for (const re of budgetPatterns) {
    let match: RegExpExecArray | null;
    const localRe = new RegExp(re.source, re.flags);
    while ((match = localRe.exec(text)) !== null) {
      const raw = parseFloat(match[1].replace(/,/g, ""));
      const suffix = (match[2] || "").toUpperCase();
      const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
      add({
        kind: "budget",
        number: raw * multiplier,
        unit: `$${suffix || ""}`.trim(),
        display: match[0].trim(),
        originalText: match[0],
      });
    }
  }

  // Revenue: "$12M revenue", "drove $4.5B in revenue"
  const revenuePatterns: RegExp[] = [
    /\$\s*([\d,.]+)\s*([BMKbmk])?\s*(?:in\s+)?(?:revenue|ARR|MRR|GMV|sales|bookings)/gi,
    /(?:revenue|ARR|MRR|GMV|sales|bookings)\s+(?:of\s+)?\$\s*([\d,.]+)\s*([BMKbmk])?/gi,
  ];

  for (const re of revenuePatterns) {
    let match: RegExpExecArray | null;
    const localRe = new RegExp(re.source, re.flags);
    while ((match = localRe.exec(text)) !== null) {
      const raw = parseFloat(match[1].replace(/,/g, ""));
      const suffix = (match[2] || "").toUpperCase();
      const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
      add({
        kind: "revenue",
        number: raw * multiplier,
        unit: `$${suffix || ""}`.trim(),
        display: match[0].trim(),
        originalText: match[0],
      });
    }
  }

  // Geography: "North America", "global", "3 countries", "EMEA", "APAC"
  const geoPatterns: RegExp[] = [
    /\b(global(?:ly)?|worldwide|international(?:ly)?)\b/gi,
    /\b(North\s+America|South\s+America|Latin\s+America|EMEA|APAC|Europe|Asia(?:\s*[-/]\s*Pacific)?|Middle\s+East|Africa|Americas)\b/gi,
    /([\d]+)\+?\s*(?:countries|regions?|continents?|offices?|locations?|markets?|geographies|sites?|time\s*zones?)/gi,
    /\b(US|U\.S\.|United\s+States|UK|U\.K\.|United\s+Kingdom|Canada|India|China|Germany|France|Japan|Australia|Brazil|Mexico)\b/g,
  ];

  for (const re of geoPatterns) {
    let match: RegExpExecArray | null;
    const localRe = new RegExp(re.source, re.flags);
    while ((match = localRe.exec(text)) !== null) {
      const num = match[1] && /^\d+$/.test(match[1].replace(/,/g, ""))
        ? parseFloat(match[1].replace(/,/g, ""))
        : undefined;
      add({
        kind: "geography",
        number: num,
        unit: num ? (match[2] || match[0].replace(/[\d,+]+\s*/, "")).trim().toLowerCase() : undefined,
        display: match[0].trim(),
        originalText: match[0],
      });
    }
  }

  // Business units: "3 business units", "across 5 departments"
  const buPatterns: RegExp[] = [
    /([\d]+)\+?\s*(?:business\s+units?|departments?|divisions?|verticals?|product\s+lines?|brands?)/gi,
    /(?:across|spanning|supporting)\s+([\d]+)\+?\s*(?:business\s+units?|departments?|divisions?|verticals?|teams?|functions?)/gi,
  ];

  for (const re of buPatterns) {
    let match: RegExpExecArray | null;
    const localRe = new RegExp(re.source, re.flags);
    while ((match = localRe.exec(text)) !== null) {
      add({
        kind: "business_unit",
        number: parseFloat(match[1].replace(/,/g, "")),
        unit: "business_units",
        display: match[0].trim(),
        originalText: match[0],
      });
    }
  }

  return results;
}

// ── Sub-Parser: Tools ─────────────────────────────────────────────

interface ParsedTool {
  canonical: string;
  category: NonNullable<Claim["tool_detail"]>["category"];
  matchedText: string;
}

function parseTools(text: string): ParsedTool[] {
  const found: ParsedTool[] = [];
  const seen = new Set<string>();

  const textLower = text.toLowerCase();

  for (const entry of TOOL_CATALOGUE) {
    if (seen.has(entry.canonical)) continue;

    // Try canonical name first
    const canonLower = entry.canonical.toLowerCase();

    // For short names (R, Go), require word boundary
    const needsWordBoundary = canonLower.length <= 2;

    // Check canonical
    if (matchToolInText(textLower, canonLower, needsWordBoundary)) {
      seen.add(entry.canonical);
      found.push({
        canonical: entry.canonical,
        category: entry.category,
        matchedText: entry.canonical,
      });
      continue;
    }

    // Check aliases
    for (const alias of entry.aliases) {
      const aliasNeedsWordBoundary = alias.length <= 2;
      if (matchToolInText(textLower, alias.toLowerCase(), aliasNeedsWordBoundary)) {
        seen.add(entry.canonical);
        found.push({
          canonical: entry.canonical,
          category: entry.category,
          matchedText: alias,
        });
        break;
      }
    }
  }

  return found;
}

function matchToolInText(textLower: string, termLower: string, requireWordBoundary: boolean): boolean {
  if (requireWordBoundary) {
    // Use regex with word boundaries for short terms
    try {
      const escaped = termLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      return re.test(textLower);
    } catch {
      return false;
    }
  }

  // For longer terms, a simple includes check suffices since they are distinctive enough
  return textLower.includes(termLower);
}

// ── Sub-Parser: Capabilities ──────────────────────────────────────

interface ParsedCapability {
  domain: string;
  confidence: number;
  matchedKeywords: string[];
}

function parseCapabilities(text: string): ParsedCapability[] {
  const results: ParsedCapability[] = [];
  const textLower = text.toLowerCase();

  for (const domain of CAPABILITY_DOMAINS) {
    const matchedKeywords: string[] = [];
    for (const kw of domain.keywords) {
      if (textLower.includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
      }
    }

    if (matchedKeywords.length > 0) {
      // Confidence: base 0.4 for a single keyword hit, scaling up with density
      // Max confidence is 1.0, reached at 4+ keyword hits
      const confidence = Math.min(1.0, 0.4 + matchedKeywords.length * 0.15);
      results.push({
        domain: domain.domain,
        confidence: Math.round(confidence * 100) / 100,
        matchedKeywords,
      });
    }
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// ── Education & Certification Parsers ─────────────────────────────

interface ParsedEducation {
  degree: string;
  institution: string;
  year: string;
  originalText: string;
}

function parseEducation(section: ResumeSection): ParsedEducation[] {
  const results: ParsedEducation[] = [];
  const lines = section.lines;

  // Common degree abbreviations
  const degreeRe = /\b(Ph\.?D\.?|M\.?B\.?A\.?|M\.?S\.?|M\.?A\.?|B\.?S\.?|B\.?A\.?|B\.?Sc\.?|M\.?Sc\.?|Associate['']?s?|Bachelor['']?s?|Master['']?s?|Doctor(?:ate)?)\b/i;
  const degreeFullRe = /\b(Doctor\s+of\s+\w+|Master\s+of\s+\w+(?:\s+\w+)?|Bachelor\s+of\s+\w+(?:\s+\w+)?)\b/i;
  const yearRe = /\b(19|20)\d{2}\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const degreeMatch = line.match(degreeRe) || line.match(degreeFullRe);
    if (degreeMatch) {
      const degree = degreeMatch[0].trim();
      const yearMatch = line.match(yearRe);
      const year = yearMatch ? yearMatch[0] : "";

      // Institution: whatever remains after removing degree and year
      let institution = line
        .replace(degreeMatch[0], "")
        .replace(yearRe, "")
        .replace(/[|–—,]\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[\s,\-–—|]+|[\s,\-–—|]+$/g, "")
        .trim();

      // If institution is empty, check next line
      if (!institution && i + 1 < lines.length) {
        institution = lines[i + 1].trim().replace(/[|–—,]\s*/g, " ").trim();
      }

      results.push({
        degree,
        institution: institution || "Unknown",
        year,
        originalText: line,
      });
    }
  }

  return results;
}

interface ParsedCertification {
  name: string;
  originalText: string;
}

function parseCertifications(section: ResumeSection): ParsedCertification[] {
  const results: ParsedCertification[] = [];

  for (const line of section.lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Remove bullet markers
    const cleaned = trimmed.replace(/^[-•*▪►●○◦→]\s*/, "").trim();
    if (cleaned.length > 3 && cleaned.length < 200) {
      results.push({
        name: cleaned,
        originalText: trimmed,
      });
    }
  }

  return results;
}

// ── Main Text Extractor ───────────────────────────────────────────

/**
 * Parse a raw-text resume into a ClaimsLedger.
 *
 * This is the primary new capability — the sub-parsers above handle the
 * heavy lifting for each claim type.
 */
export function extractClaimsFromText(rawText: string): ClaimsLedger {
  const lines = rawText.split(/\r?\n/);
  const sections = detectSections(lines);
  const fullText = rawText;

  const claims: Claim[] = [];
  const seqCounters: Record<string, number> = {};

  function nextSeq(type: ClaimType): number {
    const c = seqCounters[type] || 0;
    seqCounters[type] = c + 1;
    return c;
  }

  function addClaim(claim: Claim): void {
    // Deduplicate by normalized value + type
    const dup = claims.find(
      (c) => c.type === claim.type && c.normalized === claim.normalized,
    );
    if (dup) return;
    claims.push(claim);
  }

  // ── 1. Parse Roles from experience sections ──

  const experienceSections = sections.filter((s) => s.name === "experience");
  const allRoles: ParsedRole[] = [];
  let roleIndexOffset = 0;

  for (const expSection of experienceSections) {
    const roles = parseRoles(expSection, roleIndexOffset);
    allRoles.push(...roles);
    roleIndexOffset += roles.length;
  }

  // If no experience sections were found, try parsing the entire body
  if (allRoles.length === 0) {
    const bodySection = sections.find((s) => s.name === "body");
    if (bodySection) {
      allRoles.push(...parseRoles(bodySection, 0));
    }
  }

  // Emit role claims
  for (const role of allRoles) {
    const ri = role.roleIndex;
    const roleLabel = `${role.employer} | ${role.title}`;
    const span = { section: role.section, original_text: role.original_text };

    // Role claim (composite: employer + title + dates)
    addClaim({
      id: makeClaimId(ri, "role", nextSeq("role")),
      type: "role",
      value: roleLabel,
      normalized: normalize(roleLabel),
      role_index: ri,
      role_label: roleLabel,
      source_span: span,
    });

    // Parse metrics from each bullet
    for (const bullet of role.bullets) {
      const bulletSpan = { section: role.section, original_text: bullet };

      // Bullet text claim
      addClaim({
        id: makeClaimId(ri, "bullet_text", nextSeq("bullet_text")),
        type: "bullet_text",
        value: bullet,
        normalized: normalize(bullet),
        role_index: ri,
        role_label: roleLabel,
        source_span: bulletSpan,
      });

      // Metrics from this bullet
      for (const m of parseMetrics(bullet)) {
        addClaim({
          id: makeClaimId(ri, "metric", nextSeq("metric")),
          type: "metric",
          value: m.display,
          normalized: normalize(m.display),
          role_index: ri,
          role_label: roleLabel,
          source_span: bulletSpan,
          metric_detail: {
            number: m.number,
            unit: m.unit,
            display: m.display,
          },
        });
      }

      // Scope from this bullet
      for (const s of parseScope(bullet)) {
        addClaim({
          id: makeClaimId(ri, "scope", nextSeq("scope")),
          type: "scope",
          value: s.display,
          normalized: normalize(s.display),
          role_index: ri,
          role_label: roleLabel,
          source_span: bulletSpan,
          scope_detail: {
            kind: s.kind,
            number: s.number,
            unit: s.unit,
          },
        });
      }

      // Tools from this bullet
      for (const t of parseTools(bullet)) {
        addClaim({
          id: makeClaimId(ri, "tool", nextSeq("tool")),
          type: "tool",
          value: t.canonical,
          normalized: normalize(t.canonical),
          role_index: ri,
          role_label: roleLabel,
          source_span: bulletSpan,
          tool_detail: { category: t.category },
        });
      }

      // Capabilities from this bullet
      for (const cap of parseCapabilities(bullet)) {
        addClaim({
          id: makeClaimId(ri, "capability", nextSeq("capability")),
          type: "capability",
          value: cap.domain,
          normalized: normalize(cap.domain),
          role_index: ri,
          role_label: roleLabel,
          source_span: bulletSpan,
          capability_detail: {
            domain: cap.domain,
            confidence: cap.confidence,
          },
        });
      }
    }
  }

  // ── 2. Parse global metrics / scope / tools / capabilities from the full text ──
  // (catches items outside of bullet context, e.g. summary section)

  for (const section of sections) {
    if (section.name === "experience") continue; // already handled above

    const sectionText = section.lines.join("\n");
    const sectionSpan = { section: section.name, original_text: sectionText.substring(0, 200) };

    // Metrics at the section level
    for (const m of parseMetrics(sectionText)) {
      addClaim({
        id: makeClaimId(null, "metric", nextSeq("metric")),
        type: "metric",
        value: m.display,
        normalized: normalize(m.display),
        role_index: null,
        role_label: null,
        source_span: sectionSpan,
        metric_detail: {
          number: m.number,
          unit: m.unit,
          display: m.display,
        },
      });
    }

    // Scope at the section level
    for (const s of parseScope(sectionText)) {
      addClaim({
        id: makeClaimId(null, "scope", nextSeq("scope")),
        type: "scope",
        value: s.display,
        normalized: normalize(s.display),
        role_index: null,
        role_label: null,
        source_span: sectionSpan,
        scope_detail: {
          kind: s.kind,
          number: s.number,
          unit: s.unit,
        },
      });
    }

    // Tools at the section level
    for (const t of parseTools(sectionText)) {
      addClaim({
        id: makeClaimId(null, "tool", nextSeq("tool")),
        type: "tool",
        value: t.canonical,
        normalized: normalize(t.canonical),
        role_index: null,
        role_label: null,
        source_span: sectionSpan,
        tool_detail: { category: t.category },
      });
    }

    // Capabilities at the section level
    for (const cap of parseCapabilities(sectionText)) {
      addClaim({
        id: makeClaimId(null, "capability", nextSeq("capability")),
        type: "capability",
        value: cap.domain,
        normalized: normalize(cap.domain),
        role_index: null,
        role_label: null,
        source_span: sectionSpan,
        capability_detail: {
          domain: cap.domain,
          confidence: cap.confidence,
        },
      });
    }
  }

  // ── 3. Parse education ──

  const educationSections = sections.filter((s) => s.name === "education");
  for (const eduSection of educationSections) {
    for (const edu of parseEducation(eduSection)) {
      addClaim({
        id: makeClaimId(null, "education", nextSeq("education")),
        type: "education",
        value: `${edu.degree} — ${edu.institution}`,
        normalized: normalize(`${edu.degree} ${edu.institution}`),
        role_index: null,
        role_label: null,
        source_span: {
          section: "education",
          original_text: edu.originalText,
        },
      });
    }
  }

  // ── 4. Parse certifications ──

  const certSections = sections.filter((s) => s.name === "certifications");
  for (const certSection of certSections) {
    for (const cert of parseCertifications(certSection)) {
      addClaim({
        id: makeClaimId(null, "certification", nextSeq("certification")),
        type: "certification",
        value: cert.name,
        normalized: normalize(cert.name),
        role_index: null,
        role_label: null,
        source_span: {
          section: "certifications",
          original_text: cert.originalText,
        },
      });
    }
  }

  // ── Build the ledger ──

  return buildLedgerFromClaims(claims);
}

// ── Bridge: Legacy Ledger → New Ledger ────────────────────────────

/**
 * Convert the legacy ClaimsLedger (from claimsLedger.ts, which has `.skills`,
 * `.employers`, `.titles`, `.date_ranges`, `.locations`, and Map-based lookups)
 * into the new pipeline ClaimsLedger format (from types.ts).
 */
export function bridgeLegacyLedger(legacy: LegacyClaimsLedger): ClaimsLedger {
  const claims: Claim[] = [];
  const seqCounters: Record<string, number> = {};

  function nextSeq(type: ClaimType): number {
    const c = seqCounters[type] || 0;
    seqCounters[type] = c + 1;
    return c;
  }

  function addClaim(claim: Claim): void {
    const dup = claims.find(
      (c) => c.type === claim.type && c.normalized === claim.normalized,
    );
    if (dup) return;
    claims.push(claim);
  }

  // Map legacy employer + title pairs into "role" claims
  // Group by source_id to correlate employer/title/date_range/location for the same role
  const roleSourceIds = new Set<string>();
  for (const emp of legacy.employers) {
    roleSourceIds.add(emp.source_id);
  }

  let roleIndex = 0;
  for (const sourceId of roleSourceIds) {
    const employer = legacy.employers.find((e) => e.source_id === sourceId);
    const title = legacy.titles.find((t) => t.source_id === sourceId);
    const dateRange = legacy.date_ranges.find((d) => d.source_id === sourceId);
    const location = legacy.locations.find((l) => l.source_id === sourceId);

    const employerValue = employer?.value || "Unknown";
    const titleValue = title?.value || "Unknown";
    const roleLabel = `${employerValue} | ${titleValue}`;

    addClaim({
      id: makeClaimId(roleIndex, "role", nextSeq("role")),
      type: "role",
      value: roleLabel,
      normalized: normalize(roleLabel),
      role_index: roleIndex,
      role_label: roleLabel,
      source_span: {
        section: "experience",
        original_text: [
          employer?.source_context,
          title?.source_context,
          dateRange?.source_context,
          location?.source_context,
        ]
          .filter(Boolean)
          .join(" | "),
      },
    });

    roleIndex++;
  }

  // Map legacy metrics → new metric claims
  for (const m of legacy.metrics) {
    // Try to find which role this metric belongs to
    const ri = findRoleIndexForSourceId(m.source_id, legacy);

    addClaim({
      id: makeClaimId(ri, "metric", nextSeq("metric")),
      type: "metric",
      value: m.value,
      normalized: m.normalized,
      role_index: ri,
      role_label: ri !== null ? findRoleLabelForIndex(ri, legacy) : null,
      source_span: {
        section: "experience",
        original_text: m.source_context,
      },
      metric_detail: m.numeric_value !== undefined
        ? {
            number: m.numeric_value,
            unit: m.numeric_unit || "",
            display: m.value,
          }
        : undefined,
    });
  }

  // Map legacy tools → new tool claims
  for (const t of legacy.tools) {
    const ri = findRoleIndexForSourceId(t.source_id, legacy);
    const toolEntry = TOOL_LOOKUP.get(t.normalized);

    addClaim({
      id: makeClaimId(ri, "tool", nextSeq("tool")),
      type: "tool",
      value: t.value,
      normalized: t.normalized,
      role_index: ri,
      role_label: ri !== null ? findRoleLabelForIndex(ri, legacy) : null,
      source_span: {
        section: "experience",
        original_text: t.source_context,
      },
      tool_detail: {
        category: toolEntry?.category || "other",
      },
    });
  }

  // Map legacy skills → new tool claims (skills map to tools in the new schema)
  for (const s of legacy.skills) {
    const toolEntry = TOOL_LOOKUP.get(s.normalized);

    addClaim({
      id: makeClaimId(null, "tool", nextSeq("tool")),
      type: "tool",
      value: s.value,
      normalized: s.normalized,
      role_index: null,
      role_label: null,
      source_span: {
        section: "skills",
        original_text: s.source_context,
      },
      tool_detail: {
        category: toolEntry?.category || "other",
      },
    });
  }

  // Map legacy bullet_text claims
  const legacyBullets = legacy.claims.filter((c) => c.type === "bullet_text");
  for (const b of legacyBullets) {
    const ri = findRoleIndexForSourceId(b.source_id, legacy);

    addClaim({
      id: makeClaimId(ri, "bullet_text", nextSeq("bullet_text")),
      type: "bullet_text",
      value: b.value,
      normalized: b.normalized,
      role_index: ri,
      role_label: ri !== null ? findRoleLabelForIndex(ri, legacy) : null,
      source_span: {
        section: "experience",
        original_text: b.source_context,
      },
    });

    // Also extract capabilities from each bullet
    for (const cap of parseCapabilities(b.value)) {
      addClaim({
        id: makeClaimId(ri, "capability", nextSeq("capability")),
        type: "capability",
        value: cap.domain,
        normalized: normalize(cap.domain),
        role_index: ri,
        role_label: ri !== null ? findRoleLabelForIndex(ri, legacy) : null,
        source_span: {
          section: "experience",
          original_text: b.source_context,
        },
        capability_detail: {
          domain: cap.domain,
          confidence: cap.confidence,
        },
      });
    }

    // Extract scope from each bullet
    for (const sc of parseScope(b.value)) {
      addClaim({
        id: makeClaimId(ri, "scope", nextSeq("scope")),
        type: "scope",
        value: sc.display,
        normalized: normalize(sc.display),
        role_index: ri,
        role_label: ri !== null ? findRoleLabelForIndex(ri, legacy) : null,
        source_span: {
          section: "experience",
          original_text: b.source_context,
        },
        scope_detail: {
          kind: sc.kind,
          number: sc.number,
          unit: sc.unit,
        },
      });
    }
  }

  // Map legacy certifications
  for (const cert of legacy.certifications) {
    addClaim({
      id: makeClaimId(null, "certification", nextSeq("certification")),
      type: "certification",
      value: cert.value,
      normalized: cert.normalized,
      role_index: null,
      role_label: null,
      source_span: {
        section: "certifications",
        original_text: cert.source_context,
      },
    });
  }

  // Map legacy education
  for (const edu of legacy.education) {
    addClaim({
      id: makeClaimId(null, "education", nextSeq("education")),
      type: "education",
      value: edu.value,
      normalized: edu.normalized,
      role_index: null,
      role_label: null,
      source_span: {
        section: "education",
        original_text: edu.source_context,
      },
    });
  }

  return buildLedgerFromClaims(claims);
}

/** Find the role index for a legacy claim's source_id. */
function findRoleIndexForSourceId(sourceId: string, legacy: LegacyClaimsLedger): number | null {
  // source_id like "exp-001-b2" belongs to "exp-001"
  const expPrefix = sourceId.replace(/-b\d+$/, "");
  const employerList = legacy.employers;
  for (let i = 0; i < employerList.length; i++) {
    if (employerList[i].source_id === expPrefix || sourceId.startsWith(employerList[i].source_id)) {
      return i;
    }
  }
  return null;
}

/** Build the role label for a given role index from the legacy ledger. */
function findRoleLabelForIndex(roleIndex: number, legacy: LegacyClaimsLedger): string | null {
  if (roleIndex < legacy.employers.length) {
    const emp = legacy.employers[roleIndex];
    const title = legacy.titles.find((t) => t.source_id === emp.source_id);
    return `${emp.value} | ${title?.value || "Unknown"}`;
  }
  return null;
}

// ── Inventory Extractor (wraps existing) ──────────────────────────

/**
 * Extract claims from a structured JSON inventory.
 * Delegates to the existing `extractClaimsLedger()` from claimsLedger.ts
 * and bridges the result into the new ClaimsLedger format.
 */
export function extractClaimsFromInventory(inventory: Record<string, any>): ClaimsLedger {
  const legacyLedger = extractLegacyLedger(inventory);
  return bridgeLegacyLedger(legacyLedger);
}

// ── Auto-Detect Extractor ─────────────────────────────────────────

/**
 * Auto-detect input format and extract claims accordingly.
 *
 * - If `input` is a string, it is treated as raw resume text.
 * - If `input` is an object, it is treated as a JSON inventory and passed
 *   to the existing parser via the bridge.
 */
export function extractClaims(input: string | Record<string, any>): ClaimsLedger {
  if (typeof input === "string") {
    return extractClaimsFromText(input);
  }
  return extractClaimsFromInventory(input);
}

// ── Shared Ledger Builder ─────────────────────────────────────────

function buildLedgerFromClaims(claims: Claim[]): ClaimsLedger {
  const roles = claims.filter((c) => c.type === "role");
  const metrics = claims.filter((c) => c.type === "metric");
  const scopes = claims.filter((c) => c.type === "scope");
  const tools = claims.filter((c) => c.type === "tool");
  const capabilities = claims.filter((c) => c.type === "capability");
  const certifications = claims.filter((c) => c.type === "certification");
  const education = claims.filter((c) => c.type === "education");
  const bullet_texts = claims.filter((c) => c.type === "bullet_text");

  return {
    claims,
    roles,
    metrics,
    scopes,
    tools,
    capabilities,
    certifications,
    education,
    bullet_texts,
    total_claims: claims.length,
  };
}
