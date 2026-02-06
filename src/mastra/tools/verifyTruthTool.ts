import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { workspacePath } from "./paths";

function loadInventory(): any {
  const inventoryPath = workspacePath("experience_inventory.json");
  return JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
}

function extractFactsFromText(text: string): {
  numbers: string[];
  dates: string[];
  toolNames: string[];
  employers: string[];
  titles: string[];
} {
  const numbers = (text.match(/\$[\d,.]+[MBK]?|\d+[\d,.]*%|\d+[\d,.]+/g) || []).map((n) => n.trim());
  const dates = (text.match(/\b\d{4}\b/g) || []).map((d) => d.trim());
  const toolNames = (
    text.match(
      /\b(?:Python|SQL|R|Spark|Snowflake|dbt|Airflow|Tableau|Looker|Power BI|AWS|GCP|Azure|Kubernetes|Docker|Git|Redshift|EMR|SageMaker|MLflow|Hadoop|Kafka|Kinesis|TensorFlow|XGBoost|Prophet|BigQuery|S3)\b/gi,
    ) || []
  ).map((t) => t.trim());

  const employers: string[] = [];
  const titles: string[] = [];

  return { numbers, dates, toolNames, employers, titles };
}

function deterministicValidation(
  text: string,
  inventory: any,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const facts = extractFactsFromText(text);

  const allInventoryText = JSON.stringify(inventory).toLowerCase();

  for (const num of facts.numbers) {
    const normalizedNum = num.replace(/[,$%]/g, "");
    const originalLower = num.toLowerCase();
    if (normalizedNum.length >= 3 && !allInventoryText.includes(normalizedNum) && !allInventoryText.includes(originalLower)) {
      failures.push(`Number "${num}" not found in inventory`);
    }
  }

  const inventoryToolNames = [
    ...(inventory.skills?.technical || []),
    ...(inventory.skills?.data_science || []),
    ...(inventory.skills?.cloud || []),
    ...(inventory.skills?.leadership || []),
  ].map((t: string) => t.toLowerCase());

  for (const tool of facts.toolNames) {
    const toolLower = tool.toLowerCase();
    if (!inventoryToolNames.some((it: string) => it.includes(toolLower) || toolLower.includes(it)) && !allInventoryText.includes(toolLower)) {
      failures.push(`Tool "${tool}" not found in inventory skills`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

export const verifyTruthTool = createTool({
  id: "verify-truth",
  description:
    "Performs deterministic truth verification on generated resume and cover letter content. Checks that all numbers, dates, tool names, and claims match the experience inventory.",
  inputSchema: z.object({
    job_id: z.number(),
    company: z.string(),
    title: z.string(),
    resumeText: z.string().describe("Full text of the generated resume"),
    coverLetterText: z.string().describe("Full text of the generated cover letter"),
    evidenceMap: z.array(
      z.object({
        claim_text: z.string(),
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
      `🔍 [verifyTruth] Running truth verification for ${context.company} - ${context.title}`,
    );

    const inventory = loadInventory();

    const deterResult = deterministicValidation(
      context.resumeText + "\n" + context.coverLetterText,
      inventory,
    );

    logger?.info(
      `🔍 [verifyTruth] Deterministic check: ${deterResult.passed ? "PASSED" : "FAILED"} (${deterResult.failures.length} issues)`,
    );

    const evidenceMapValid = context.evidenceMap.every(
      (e) => e.confidence >= 0.7 && e.evidence_quote.length > 0,
    );

    const overallPass =
      context.llmVerification.passed &&
      deterResult.passed &&
      evidenceMapValid;

    logger?.info(
      `🔍 [verifyTruth] Overall: ${overallPass ? "PASSED ✅" : "FAILED ❌"}`,
    );

    return {
      job_id: context.job_id,
      overallPass,
      llmVerification: context.llmVerification,
      deterministicVerification: deterResult,
      evidenceMapValid,
    };
  },
});
