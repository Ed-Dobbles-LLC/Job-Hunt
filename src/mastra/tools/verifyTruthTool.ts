import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { extractFactRegistry, type FactRegistry } from "./factRegistry";

const EvidencePointerSchema = z.object({
  claim_text: z.string(),
  evidence_id: z.string().describe("Inventory bullet ID (e.g., exp-001-b2) or section ID (e.g., edu-001, cert-001)"),
  evidence_quote: z.string().describe("Exact or near-exact quote from the inventory that supports this claim"),
  evidence_source_key: z.string().describe("Inventory section path (e.g., experience[0].bullets[1])"),
  confidence: z.number().min(0).max(1),
});

export type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

export interface VerificationLayer {
  name: string;
  passed: boolean;
  failures: string[];
}

export interface VerificationReport {
  job_id: number;
  overallPass: boolean;
  layers: VerificationLayer[];
  totalFailures: number;
  evidenceCompleteness: { covered: number; total: number; percentage: number };
  llmVerification: { passed: boolean; issues: string[] };
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

export function layer1EvidenceCompleteness(
  resumeBullets: string[],
  coverLetterClaims: string[],
  evidencePointers: EvidencePointer[],
): VerificationLayer {
  const failures: string[] = [];
  const coveredClaims = new Set(evidencePointers.map(p => normalize(p.claim_text)));
  let total = 0;
  let covered = 0;

  for (const bullet of resumeBullets) {
    total++;
    const bulletNorm = normalize(bullet);
    const hasCoverage = evidencePointers.some(p =>
      normalize(p.claim_text) === bulletNorm ||
      bulletNorm.includes(normalize(p.claim_text)) ||
      normalize(p.claim_text).includes(bulletNorm)
    );
    if (hasCoverage) {
      covered++;
    } else {
      failures.push(`Resume bullet missing evidence pointer: "${bullet.substring(0, 80)}..."`);
    }
  }

  for (const claim of coverLetterClaims) {
    total++;
    const claimNorm = normalize(claim);
    const hasCoverage = evidencePointers.some(p =>
      normalize(p.claim_text) === claimNorm ||
      claimNorm.includes(normalize(p.claim_text)) ||
      normalize(p.claim_text).includes(claimNorm)
    );
    if (hasCoverage) {
      covered++;
    } else {
      failures.push(`Cover letter claim missing evidence pointer: "${claim.substring(0, 80)}..."`);
    }
  }

  return {
    name: "evidence_completeness",
    passed: failures.length === 0,
    failures,
  };
}

export function layer2PointerValidity(
  evidencePointers: EvidencePointer[],
  registry: FactRegistry,
): VerificationLayer {
  const failures: string[] = [];

  for (const pointer of evidencePointers) {
    if (!pointer.evidence_id || pointer.evidence_id.trim() === "") {
      failures.push(`Evidence pointer for "${pointer.claim_text.substring(0, 60)}..." has empty evidence_id`);
      continue;
    }

    const idNorm = pointer.evidence_id.toLowerCase().trim();
    const validId = registry.bulletIds.has(idNorm) ||
      registry.atoms.some(a => a.id.toLowerCase() === idNorm);

    if (!validId) {
      failures.push(`Invalid evidence_id "${pointer.evidence_id}" for claim "${pointer.claim_text.substring(0, 60)}..." — not found in inventory`);
    }
  }

  return {
    name: "pointer_validity",
    passed: failures.length === 0,
    failures,
  };
}

export function layer3QuoteAccuracy(
  evidencePointers: EvidencePointer[],
  registry: FactRegistry,
): VerificationLayer {
  const failures: string[] = [];

  for (const pointer of evidencePointers) {
    if (!pointer.evidence_quote || pointer.evidence_quote.trim().length === 0) {
      failures.push(`Empty evidence_quote for claim "${pointer.claim_text.substring(0, 60)}..."`);
      continue;
    }

    const quoteNorm = normalize(pointer.evidence_quote);

    const bulletText = registry.bulletTexts.get(pointer.evidence_id.toLowerCase().trim());
    if (bulletText) {
      const bulletNorm = normalize(bulletText);
      if (bulletNorm.includes(quoteNorm) || quoteNorm.includes(bulletNorm)) {
        continue;
      }

      const quoteWords = quoteNorm.split(/\s+/);
      const bulletWords = bulletNorm.split(/\s+/);
      const matchingWords = quoteWords.filter(w => bulletWords.includes(w));
      const matchRatio = matchingWords.length / quoteWords.length;
      if (matchRatio >= 0.6) {
        continue;
      }
    }

    if (registry.allText.includes(quoteNorm)) {
      continue;
    }

    const quoteWords = quoteNorm.split(/\s+/);
    if (quoteWords.length >= 3) {
      const significantWords = quoteWords.filter(w => w.length > 3);
      const matchCount = significantWords.filter(w => registry.allText.includes(w)).length;
      if (matchCount / Math.max(significantWords.length, 1) >= 0.7) {
        continue;
      }
    }

    failures.push(`Evidence quote not found in inventory for "${pointer.claim_text.substring(0, 60)}..." — quote: "${pointer.evidence_quote.substring(0, 80)}..."`);
  }

  return {
    name: "quote_accuracy",
    passed: failures.length === 0,
    failures,
  };
}

export function layer4FactAllowlist(
  resumeText: string,
  coverLetterText: string,
  registry: FactRegistry,
): VerificationLayer {
  const failures: string[] = [];
  const combinedText = resumeText + "\n" + coverLetterText;

  const numbers = (combinedText.match(/\$[\d,.]+[MBK]?|\d+[\d,.]*%|\d+[\d,.]+/g) || []).map(n => n.trim());
  for (const num of numbers) {
    const normalizedNum = num.replace(/[,$%]/g, "");
    const originalLower = num.toLowerCase();
    if (normalizedNum.length >= 3 && !registry.allText.includes(normalizedNum) && !registry.allText.includes(originalLower)) {
      failures.push(`Number "${num}" not found in inventory allowlist`);
    }
  }

  const toolPattern = /\b(?:Python|SQL|R|Spark|Snowflake|dbt|Airflow|Tableau|Looker|Power BI|AWS|GCP|Azure|Kubernetes|Docker|Git|Redshift|EMR|SageMaker|MLflow|Hadoop|Kafka|Kinesis|TensorFlow|XGBoost|Prophet|BigQuery|S3|Excel|SQL Server)\b/gi;
  const foundTools = (combinedText.match(toolPattern) || []).map(t => t.trim());
  for (const tool of foundTools) {
    const toolNorm = normalize(tool);
    if (!registry.tools.has(toolNorm) && !registry.allText.includes(toolNorm)) {
      failures.push(`Tool/technology "${tool}" not found in inventory allowlist`);
    }
  }

  const yearPattern = /\b(19|20)\d{2}\b/g;
  const foundYears = (combinedText.match(yearPattern) || []).map(y => y.trim());
  const currentYear = new Date().getFullYear().toString();
  for (const year of foundYears) {
    if (year === currentYear) continue;
    if (!registry.dates.has(year) && !registry.allText.includes(year)) {
      failures.push(`Year "${year}" not found in inventory allowlist`);
    }
  }

  const certPatterns = [
    /(?:certified|certification|certificate)[:\s]+([^,.]+)/gi,
    /(?:AWS|Google|Azure|PMP|CFA|CPA|CISSP)[^,.]*(?:Certified|Certificate|Certification)[^,.]+/gi,
  ];
  for (const pattern of certPatterns) {
    let match;
    while ((match = pattern.exec(combinedText)) !== null) {
      const certText = normalize(match[0]);
      const inAllowlist = [...registry.certifications].some(c =>
        certText.includes(c) || c.includes(certText)
      );
      if (!inAllowlist && !registry.allText.includes(certText)) {
        failures.push(`Certification reference "${match[0].substring(0, 60)}" not verified in inventory`);
      }
    }
  }

  return {
    name: "fact_allowlist",
    passed: failures.length === 0,
    failures,
  };
}

export function layer5UnknownCompliance(
  resumeText: string,
  coverLetterText: string,
): VerificationLayer {
  const failures: string[] = [];
  const combinedText = resumeText + "\n" + coverLetterText;

  const fabricationIndicators = [
    /I (?:believe|think|assume|imagine|expect) (?:that )?(?:your|the) company/gi,
    /(?:from what I (?:understand|gather|know))/gi,
    /(?:I'?m confident that|I'?m sure that|undoubtedly|without a doubt)/gi,
  ];

  for (const pattern of fabricationIndicators) {
    const matches = combinedText.match(pattern) || [];
    for (const match of matches) {
      failures.push(`Potential ungrounded assertion detected: "${match}"`);
    }
  }

  return {
    name: "unknown_compliance",
    passed: failures.length === 0,
    failures,
  };
}

function extractResumeBullets(resumeText: string): string[] {
  const lines = resumeText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  return lines.filter(l =>
    l.startsWith("•") || l.startsWith("-") || l.startsWith("–") || l.match(/^\d+\./)
  ).map(l => l.replace(/^[•\-–]\s*/, "").replace(/^\d+\.\s*/, "").trim());
}

function extractCoverLetterClaims(coverLetterText: string): string[] {
  const sentences = coverLetterText
    .replace(/\n/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  return sentences.filter(s => {
    const hasMetric = /\d+/.test(s);
    const hasAction = /(?:led|built|managed|delivered|achieved|drove|launched|established|created|developed|implemented|designed|reduced|increased|improved)/i.test(s);
    const hasToolRef = /(?:Python|SQL|Snowflake|dbt|AWS|GCP|Tableau|Spark|Kubernetes)/i.test(s);
    return hasMetric || hasAction || hasToolRef;
  });
}

export const verifyTruthTool = createTool({
  id: "verify-truth",
  description:
    "Performs 5-layer truth verification on generated resume and cover letter content. Layer 1: Evidence completeness (every bullet/claim has a pointer). Layer 2: Pointer validity (evidence_id exists in inventory). Layer 3: Quote accuracy (evidence_quote matches inventory text). Layer 4: Fact allowlist (all numbers, tools, dates, certs exist in inventory). Layer 5: Unknown compliance (no ungrounded assertions). MUST be called after generate-resume and generate-cover-letter, before build-output.",
  inputSchema: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    resumeText: z.string().describe("Full text of the generated resume"),
    coverLetterText: z.string().describe("Full text of the generated cover letter"),
    evidenceMap: z.array(
      z.object({
        claim_text: z.string(),
        evidence_id: z.string().describe("Inventory bullet/section ID (e.g., exp-001-b2)"),
        evidence_quote: z.string(),
        evidence_source_key: z.string(),
        confidence: z.number(),
      }),
    ),
    llmVerification: z.object({
      passed: z.boolean(),
      issues: z.array(z.string()),
    }).describe("LLM-based verification results from the agent's analysis"),
  }),
  outputSchema: z.object({
    job_id: z.number(),
    overallPass: z.boolean(),
    layers: z.array(z.object({
      name: z.string(),
      passed: z.boolean(),
      failures: z.array(z.string()),
    })),
    totalFailures: z.number(),
    evidenceCompleteness: z.object({
      covered: z.number(),
      total: z.number(),
      percentage: z.number(),
    }),
    llmVerification: z.object({
      passed: z.boolean(),
      issues: z.array(z.string()),
    }),
    deterministicVerification: z.object({
      passed: z.boolean(),
      failures: z.array(z.string()),
    }),
    evidenceMapValid: z.boolean(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info(
      `🔍 [verifyTruth] Running 5-layer verification for ${context.company} - ${context.title}`,
    );

    const registry = extractFactRegistry();

    const resumeBullets = extractResumeBullets(context.resumeText);
    const coverLetterClaims = extractCoverLetterClaims(context.coverLetterText);

    logger?.info(`🔍 [verifyTruth] Found ${resumeBullets.length} resume bullets, ${coverLetterClaims.length} cover letter claims`);
    logger?.info(`🔍 [verifyTruth] Evidence pointers provided: ${context.evidenceMap.length}`);

    const l1 = layer1EvidenceCompleteness(resumeBullets, coverLetterClaims, context.evidenceMap);
    logger?.info(`🔍 [verifyTruth] Layer 1 (Evidence Completeness): ${l1.passed ? "PASS" : "FAIL"} (${l1.failures.length} issues)`);

    const l2 = layer2PointerValidity(context.evidenceMap, registry);
    logger?.info(`🔍 [verifyTruth] Layer 2 (Pointer Validity): ${l2.passed ? "PASS" : "FAIL"} (${l2.failures.length} issues)`);

    const l3 = layer3QuoteAccuracy(context.evidenceMap, registry);
    logger?.info(`🔍 [verifyTruth] Layer 3 (Quote Accuracy): ${l3.passed ? "PASS" : "FAIL"} (${l3.failures.length} issues)`);

    const l4 = layer4FactAllowlist(context.resumeText, context.coverLetterText, registry);
    logger?.info(`🔍 [verifyTruth] Layer 4 (Fact Allowlist): ${l4.passed ? "PASS" : "FAIL"} (${l4.failures.length} issues)`);

    const l5 = layer5UnknownCompliance(context.resumeText, context.coverLetterText);
    logger?.info(`🔍 [verifyTruth] Layer 5 (Unknown Compliance): ${l5.passed ? "PASS" : "FAIL"} (${l5.failures.length} issues)`);

    const layers = [l1, l2, l3, l4, l5];
    const allDeterministicFailures = layers.flatMap(l => l.failures);
    const deterministicPassed = allDeterministicFailures.length === 0;

    const evidenceMapValid = context.evidenceMap.every(
      (e) => e.confidence >= 0.7 && e.evidence_quote.length > 0,
    );

    const totalBulletsAndClaims = resumeBullets.length + coverLetterClaims.length;
    const coveredCount = totalBulletsAndClaims - l1.failures.length;

    const overallPass =
      context.llmVerification.passed &&
      deterministicPassed &&
      evidenceMapValid;

    logger?.info(
      `🔍 [verifyTruth] Overall: ${overallPass ? "PASSED ✅" : "FAILED ❌"} (${allDeterministicFailures.length} deterministic failures, LLM: ${context.llmVerification.passed}, evidence valid: ${evidenceMapValid})`,
    );

    if (!overallPass) {
      for (const failure of allDeterministicFailures.slice(0, 10)) {
        logger?.info(`  ❌ ${failure}`);
      }
    }

    return {
      job_id: context.job_id,
      overallPass,
      layers,
      totalFailures: allDeterministicFailures.length + (context.llmVerification.passed ? 0 : context.llmVerification.issues.length),
      evidenceCompleteness: {
        covered: coveredCount,
        total: totalBulletsAndClaims,
        percentage: totalBulletsAndClaims > 0 ? Math.round((coveredCount / totalBulletsAndClaims) * 100) : 100,
      },
      llmVerification: context.llmVerification,
      deterministicVerification: {
        passed: deterministicPassed,
        failures: allDeterministicFailures,
      },
      evidenceMapValid,
    };
  },
});
