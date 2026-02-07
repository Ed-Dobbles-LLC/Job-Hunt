import { z } from "zod";
import { createHash } from "crypto";

export const JobPostingSchema = z.object({
  job_id: z.number().optional().describe("Auto-generated database primary key"),
  source: z.string().describe("Origin of the posting: email, linkedin, indeed, etc."),
  url: z.string().describe("Original posting URL"),
  url_canonical: z.string().optional().describe("Normalized/canonical URL for dedup"),
  company: z.string(),
  title: z.string(),
  location: z.string(),
  remote_hybrid: z.string().optional().describe("Remote / Hybrid / On-site / Unknown"),
  level: z.enum(["IC", "Manager", "Director", "Senior Director", "VP", "SVP", "C-Suite", "Unknown"]).describe("Seniority level inferred from title"),
  date_posted: z.string().describe("ISO date string when posting appeared"),
  date_ingested: z.string().optional().describe("ISO timestamp when record was created"),
  description: z.string().describe("Full job description text"),
  keywords: z.array(z.string()).describe("Extracted keywords and phrases from JD"),
  compensation: z.string().optional(),
  hash: z.string().describe("SHA-256 hash of normalized description for exact dedup"),
  simhash: z.string().optional().describe("64-bit SimHash fingerprint for near-duplicate detection"),
  status: z.enum(["new", "scored", "applied", "dismissed", "expired"]).default("new"),
});

export type JobPosting = z.infer<typeof JobPostingSchema>;

export const SAMPLE_JOB_POSTING: JobPosting = {
  job_id: 1,
  source: "linkedin",
  url: "https://www.linkedin.com/jobs/view/123456",
  url_canonical: "https://www.linkedin.com/jobs/view/123456",
  company: "Global Payments Inc.",
  title: "VP of Analytics & Insights",
  location: "Atlanta, GA (Hybrid)",
  remote_hybrid: "Hybrid",
  level: "VP",
  date_posted: "2026-02-07",
  date_ingested: "2026-02-07T12:30:00.000Z",
  description: "We are seeking a VP of Analytics & Insights to lead our enterprise data strategy...",
  keywords: ["analytics", "data strategy", "leadership", "enterprise", "VP"],
  compensation: "$200,000 - $250,000/year",
  hash: "abc123def456...",
  simhash: "a1b2c3d4e5f6a7b8",
  status: "new",
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "was", "are", "were", "been", "be",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "not", "no", "nor",
  "so", "if", "then", "than", "too", "very", "just", "about", "above",
  "after", "all", "also", "am", "any", "because", "before", "both", "each",
  "few", "get", "got", "her", "here", "him", "his", "how", "its", "let",
  "more", "most", "much", "must", "my", "new", "now", "off", "old", "one",
  "only", "other", "our", "out", "over", "own", "per", "put", "same",
  "she", "some", "such", "that", "their", "them", "they", "this",
  "those", "through", "under", "up", "use", "way", "we", "what", "when",
  "where", "which", "while", "who", "why", "work", "you", "your",
]);

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function fnv1aHash(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

export function computeSimhash(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return "0000000000000000";

  const v = new Array(64).fill(0);

  for (const token of tokens) {
    const hash = fnv1aHash(token);
    for (let i = 0; i < 64; i++) {
      if ((hash >> BigInt(i)) & 1n) {
        v[i] += 1;
      } else {
        v[i] -= 1;
      }
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }

  return fingerprint.toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  const aVal = BigInt("0x" + a);
  const bVal = BigInt("0x" + b);
  let xor = aVal ^ bVal;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

export function isNearDuplicate(hashA: string, hashB: string, threshold: number = 10): boolean {
  return hammingDistance(hashA, hashB) <= threshold;
}

const LEVEL_PATTERNS: { level: JobPosting["level"]; patterns: RegExp[] }[] = [
  { level: "C-Suite", patterns: [/\b(?:chief|c[a-z]o|cto|cfo|coo|cdo|cio|cdao|cao)\b/i, /\bchief\s+(?:data|analytics|information|technology|digital|ai)\s+officer\b/i] },
  { level: "SVP", patterns: [/\b(?:svp|senior\s+vice\s+president|sr\.?\s+vice\s+president|evp|executive\s+vice\s+president)\b/i] },
  { level: "VP", patterns: [/\b(?:vp|vice\s+president)\b/i, /\bvp[\s,]/i] },
  { level: "Senior Director", patterns: [/\b(?:senior\s+director|sr\.?\s+director)\b/i] },
  { level: "Director", patterns: [/\b(?:director)\b/i, /\bhead\s+of\b/i] },
  { level: "Manager", patterns: [/\b(?:manager|lead)\b/i] },
  { level: "IC", patterns: [/\b(?:engineer|scientist|analyst|developer|architect|specialist|consultant|staff)\b/i] },
];

export function classifyLevel(title: string): JobPosting["level"] {
  const titleLower = title.toLowerCase();
  for (const { level, patterns } of LEVEL_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(titleLower)) {
        return level;
      }
    }
  }
  return "Unknown";
}

const KEYWORD_BOOST_PATTERNS = [
  /\b(?:machine\s+learning|deep\s+learning|natural\s+language\s+processing|nlp|computer\s+vision)\b/gi,
  /\b(?:data\s+strategy|data\s+governance|data\s+platform|data\s+engineering|data\s+science|data\s+analytics)\b/gi,
  /\b(?:ai|artificial\s+intelligence|generative\s+ai|gen\s*ai|llm|large\s+language\s+model)\b/gi,
  /\b(?:python|sql|spark|snowflake|dbt|airflow|tableau|looker|power\s+bi|kubernetes|docker|aws|gcp|azure|terraform)\b/gi,
  /\b(?:p&l|budget|revenue|roi|kpi|okr|stakeholder|board|c-suite|executive)\b/gi,
  /\b(?:team\s+building|mentorship|hiring|scaling|cross-functional|transformation|roadmap|strategy)\b/gi,
  /\b(?:a\/b\s+testing|experimentation|mlops|feature\s+engineering|model\s+deployment)\b/gi,
  /\b(?:healthcare|financial\s+services|fintech|retail|e-commerce|saas|b2b|b2c|cpg)\b/gi,
];

export function extractKeywords(text: string, maxKeywords: number = 30): string[] {
  const keywordsSet = new Set<string>();

  for (const pattern of KEYWORD_BOOST_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      keywordsSet.add(match[0].toLowerCase().trim());
    }
  }

  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .filter(w => w.length > 3 && !keywordsSet.has(w));

  for (const word of sorted) {
    if (keywordsSet.size >= maxKeywords) break;
    keywordsSet.add(word);
  }

  return [...keywordsSet].slice(0, maxKeywords);
}

export function isNewSinceYesterday(dateIngested: string | Date): boolean {
  const ingested = typeof dateIngested === "string" ? new Date(dateIngested) : dateIngested;
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  return ingested >= yesterday;
}

export function getNewSinceYesterdayQuery(): string {
  return `SELECT * FROM jobs WHERE date_ingested >= (CURRENT_DATE - INTERVAL '1 day') ORDER BY date_ingested DESC`;
}

export interface DedupeResult {
  isDuplicate: boolean;
  reason: "exact_hash" | "canonical_url" | "near_duplicate_simhash" | "company_title_location" | null;
  matchedJobId: number | null;
  hammingDistance: number | null;
}

export function buildJobPosting(input: {
  company: string;
  title: string;
  location: string;
  url?: string;
  description?: string;
  source?: string;
  compensation?: string;
  date_posted?: string;
}): Omit<JobPosting, "job_id" | "date_ingested"> {
  const description = input.description || "";
  const hashInput = description || `${input.company}|${input.title}|${input.location}|${input.url || ""}`;

  return {
    source: input.source || "email",
    url: input.url || "",
    company: input.company,
    title: input.title,
    location: input.location,
    level: classifyLevel(input.title),
    date_posted: input.date_posted || new Date().toISOString().split("T")[0],
    description,
    keywords: extractKeywords(description),
    compensation: input.compensation || "",
    hash: computeHash(hashInput),
    simhash: computeSimhash(description),
    status: "new",
  };
}
