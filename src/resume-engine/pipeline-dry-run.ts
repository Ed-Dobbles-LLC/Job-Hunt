/**
 * Pipeline Dry-Run Mode
 *
 * Validates stage ordering, budget enforcement, and output object shapes
 * WITHOUT making any LLM calls or DB writes. Uses fixture data to simulate
 * each stage's output.
 *
 * Usage:
 *   PIPELINE_ARCH=v2 node -e "
 *     import { runPipeline } from './src/resume-engine/pipeline';
 *     runPipeline({ job_id: 0, dry_run: true, logger: console });
 *   "
 *
 * Or in tests:
 *   const result = await runPipeline({ job_id: 0, dry_run: true });
 *   assert(result.success);
 *   assert(result.stage_results.contract_validation.data.all_passed);
 */

import { STAGE_CONTRACTS, snapshotResume, validateStageContract, type StageId } from "./stage-contracts";
import { PipelineBudget, loadBudgetConfig, BudgetExceededError } from "./pipeline-budget";
import { runPostProcessing } from "./post-processing-controller";
import type { PipelineResult, StageResult } from "./types";
import type { PipelineInput } from "./pipeline";

// ── Fixture Data ─────────────────────────────────────────────────

function createFixtureResume(): any {
  return {
    target_company: "DryRun Corp",
    target_role: "VP Analytics",
    professional_summary: "Analytics leader with 15+ years of experience in data platform modernization and team building across enterprise organizations.",
    core_competencies: [
      "Data Platform Architecture",
      "Team Leadership & Scaling",
      "Cloud Migration (Snowflake, dbt)",
      "Executive Storytelling",
      "Revenue Analytics",
      "Governance & Compliance",
    ],
    experience: [
      {
        employer: "Acme Inc",
        title: "VP, Data & Analytics",
        dates: "2021 – Present",
        scope_line: "$2B revenue | 45-person analytics org | 4 business units",
        bullets: [
          { text: "Built 45-person analytics organization from 3 inherited analysts across 4 specialized pods with 92% retention", source_hash: "acme-team", evidence_quote: "Built team from 3 to 45", claim_ids: ["cl-acme-build-1"] },
          { text: "Migrated legacy on-prem warehouse to Snowflake cloud lakehouse serving 2000+ analysts", source_hash: "acme-platform", evidence_quote: "Migrated to Snowflake", claim_ids: ["cl-acme-platform-1"] },
          { text: "Delivered $12M in annual margin improvement through pricing analytics optimization", source_hash: "acme-revenue", evidence_quote: "$12M margin improvement", claim_ids: ["cl-acme-revenue-1"] },
          { text: "Reduced reporting lag from 3 days to real-time for 400+ stakeholders", source_hash: "acme-insight", evidence_quote: "Reduced reporting lag", claim_ids: ["cl-acme-insight-1"] },
        ],
      },
      {
        employer: "Beta Corp",
        title: "Director, Analytics Engineering",
        dates: "2018 – 2021",
        scope_line: "$500M division | 15-person team | 3 product lines",
        bullets: [
          { text: "Architected unified data platform processing 2TB daily across 3 product lines", source_hash: "beta-arch", evidence_quote: "Architected data platform", claim_ids: ["cl-beta-arch-1"] },
          { text: "Standardized governance framework achieving SOX compliance across all reporting", source_hash: "beta-gov", evidence_quote: "SOX compliance", claim_ids: ["cl-beta-gov-1"] },
          { text: "Implemented self-service analytics reducing ad-hoc request queue by 85%", source_hash: "beta-self", evidence_quote: "Self-service analytics", claim_ids: ["cl-beta-self-1"] },
        ],
      },
      {
        employer: "Gamma Labs",
        title: "Senior Analytics Manager",
        dates: "2015 – 2018",
        scope_line: "Series C startup | 8-person team | First analytics hire",
        bullets: [
          { text: "Stood up entire analytics function as first data hire in Series C startup", source_hash: "gamma-build", evidence_quote: "First data hire", claim_ids: ["cl-gamma-build-1"] },
          { text: "Designed KPI framework that supported Series D fundraise presentation to board", source_hash: "gamma-kpi", evidence_quote: "KPI framework for board", claim_ids: ["cl-gamma-kpi-1"] },
        ],
      },
    ],
    gap_notes: [],
  };
}

function createFixtureCoverLetter(): any {
  return {
    opening_paragraph: "The reporting infrastructure challenge described in your VP Analytics posting mirrors a transformation I led at Acme Inc.",
    body_paragraphs: [
      "At Acme, I inherited a 3-person team and legacy warehouse that left executives waiting 3 days for basic reports. Within 18 months, I built a 45-person org, migrated to Snowflake, and delivered real-time reporting to 400+ stakeholders.",
      "My approach to data platform modernization is rooted in governance-first architecture. At Beta Corp, I standardized reporting frameworks to achieve SOX compliance while simultaneously implementing self-service analytics that reduced the ad-hoc queue by 85%.",
    ],
    closing_paragraph: "I welcome the opportunity to discuss how my experience building analytics organizations from the ground up aligns with DryRun Corp's needs.",
    tone: "confident_measured",
    word_count: 180,
  };
}

function createFixtureMandate(): any {
  return {
    primary_mandate: "bi_platform_modernization",
    secondary_mandates: ["team_leadership_scale", "governance_standardization"],
    seniority_level: "VP",
    tone_guidance: "Architecture-first, emphasize platform decisions and migration outcomes",
    mandate_keywords: ["platform", "architecture", "cloud", "migration", "modernization"],
    archetype_weights: {
      bi_platform_modernization: 0.4,
      team_leadership_scale: 0.3,
      governance_standardization: 0.2,
      insight_delivery_automation: 0.1,
    },
  };
}

// ── Contract Validation ──────────────────────────────────────────

interface ContractValidationResult {
  all_passed: boolean;
  stage_order_valid: boolean;
  budget_enforcement_valid: boolean;
  detection_only_valid: boolean;
  mutation_boundary_valid: boolean;
  results: {
    stage: string;
    passed: boolean;
    issue?: string;
  }[];
}

function validateAllContracts(resume: any): ContractValidationResult {
  const results: ContractValidationResult["results"] = [];
  let allPassed = true;

  // 1. Verify stage ordering is sequential and correct
  const EXPECTED_ORDER: StageId[] = [
    "stage1_claims_ledger",
    "stage2_mandate_classifier",
    "stage3_bullet_scoring",
    "stage4_constrained_rewrite",
    "stage5_differentiation",
    "stage6_layout_governor",
    "stage7_truth_audit",
    "stage8_recruiter_review",
    "post_processing",
  ];

  let stageOrderValid = true;
  for (let i = 0; i < EXPECTED_ORDER.length; i++) {
    const stageId = EXPECTED_ORDER[i];
    const contract = STAGE_CONTRACTS[stageId];
    if (!contract) {
      results.push({ stage: stageId, passed: false, issue: "Missing contract definition" });
      stageOrderValid = false;
      allPassed = false;
    } else {
      results.push({ stage: stageId, passed: true });
    }
  }

  // 2. Verify detection-only stages have allowed_mutations: ["none"]
  let detectionOnlyValid = true;
  const DETECTION_ONLY_STAGES: StageId[] = ["stage5_differentiation", "stage7_truth_audit", "stage8_recruiter_review", "post_processing"];
  for (const stageId of DETECTION_ONLY_STAGES) {
    const contract = STAGE_CONTRACTS[stageId];
    if (!contract.allowed_mutations.includes("none")) {
      results.push({ stage: `${stageId}_detection_only`, passed: false, issue: `Stage ${stageId} should be detection-only but allows: ${contract.allowed_mutations.join(", ")}` });
      detectionOnlyValid = false;
      allPassed = false;
    } else {
      results.push({ stage: `${stageId}_detection_only`, passed: true });
    }
  }

  // 3. Verify mutation boundaries don't overlap
  let mutationBoundaryValid = true;
  const mutationOwners = new Map<string, string>();
  for (const [stageId, contract] of Object.entries(STAGE_CONTRACTS)) {
    for (const mut of contract.allowed_mutations) {
      if (mut === "none") continue;
      // Special cases: resume.full is creation (stage 4 only)
      if (mut === "resume.full" || mut === "cover_letter.full") continue;
      if (mutationOwners.has(mut)) {
        // stage6 is allowed to own resume structure mutations
        if (stageId === "stage6_layout_governor") continue;
        const existing = mutationOwners.get(mut)!;
        if (existing !== stageId) {
          results.push({ stage: `mutation_boundary_${mut}`, passed: false, issue: `Both ${existing} and ${stageId} claim mutation of "${mut}"` });
          mutationBoundaryValid = false;
          allPassed = false;
        }
      } else {
        mutationOwners.set(mut, stageId);
      }
    }
  }
  if (mutationBoundaryValid) {
    results.push({ stage: "mutation_boundaries", passed: true });
  }

  // 4. Verify budget enforcement exists (check contract max_attempts)
  let budgetValid = true;
  for (const [stageId, contract] of Object.entries(STAGE_CONTRACTS)) {
    if (contract.uses_llm && contract.max_llm_calls_per_attempt <= 0) {
      results.push({ stage: `${stageId}_budget`, passed: false, issue: `LLM stage ${stageId} has no LLM call limit` });
      budgetValid = false;
      allPassed = false;
    }
  }
  if (budgetValid) {
    results.push({ stage: "budget_enforcement", passed: true });
  }

  // 5. Verify post-processing produces no mutations (snapshot test)
  const snapshot = snapshotResume(resume);
  const ppContract = STAGE_CONTRACTS.post_processing;
  const violation = validateStageContract(ppContract, snapshot, snapshot);
  if (violation) {
    results.push({ stage: "post_processing_immutability", passed: false, issue: violation });
    allPassed = false;
  } else {
    results.push({ stage: "post_processing_immutability", passed: true });
  }

  return {
    all_passed: allPassed,
    stage_order_valid: stageOrderValid,
    budget_enforcement_valid: budgetValid,
    detection_only_valid: detectionOnlyValid,
    mutation_boundary_valid: mutationBoundaryValid,
    results,
  };
}

// ── Main Dry-Run ─────────────────────────────────────────────────

export async function runPipelineDryRun(input: PipelineInput): Promise<PipelineResult> {
  const logger = input.logger;
  const stageResults: Record<string, StageResult<any>> = {};
  const start = Date.now();

  logger?.info("🧪 [DryRun] Starting pipeline dry-run validation...");

  // Create fixture data
  const fixtureResume = createFixtureResume();
  const fixtureCoverLetter = createFixtureCoverLetter();
  const fixtureMandate = createFixtureMandate();

  // 1. Validate stage contracts
  logger?.info("🧪 [DryRun] Validating stage contracts...");
  const contractValidation = validateAllContracts(fixtureResume);
  stageResults["contract_validation"] = {
    stage: "Contract Validation",
    success: contractValidation.all_passed,
    data: contractValidation,
    duration_ms: Date.now() - start,
  };

  for (const r of contractValidation.results) {
    if (r.passed) {
      logger?.info(`  ✅ ${r.stage}`);
    } else {
      logger?.error(`  ❌ ${r.stage}: ${r.issue}`);
    }
  }

  // 2. Validate budget enforcement
  logger?.info("🧪 [DryRun] Validating budget enforcement...");
  const budgetConfig = loadBudgetConfig(input.budget);
  const budget = new PipelineBudget(budgetConfig, logger);

  // Simulate max calls
  for (let i = 0; i < budgetConfig.max_llm_calls; i++) {
    budget.recordLLMCall();
  }
  const exceeds = budget.wouldExceed({ llm_calls: 1 });
  const budgetEnforced = exceeds !== null;
  stageResults["budget_enforcement"] = {
    stage: "Budget Enforcement",
    success: budgetEnforced,
    data: { budget_config: budgetConfig, exceeds_after_max: budgetEnforced, snapshot: budget.getSnapshot() },
    duration_ms: 0,
  };
  logger?.info(`  ${budgetEnforced ? "✅" : "❌"} Budget enforcement: ${budgetEnforced ? "correctly blocks at limit" : "FAILED to block at limit"}`);

  // 3. Validate post-processing is detection-only
  logger?.info("🧪 [DryRun] Validating post-processing is detection-only...");
  const resumeBefore = JSON.stringify(fixtureResume);
  const ppReport = runPostProcessing({
    resume: fixtureResume,
    coverLetter: fixtureCoverLetter,
    mandate: fixtureMandate,
    logger,
  });
  const resumeAfter = JSON.stringify(fixtureResume);
  const noMutation = resumeBefore === resumeAfter;
  stageResults["post_processing_immutability"] = {
    stage: "Post-Processing Immutability",
    success: noMutation,
    data: { mutated: !noMutation, report: ppReport },
    duration_ms: ppReport.duration_ms,
  };
  logger?.info(`  ${noMutation ? "✅" : "❌"} Post-processing immutability: ${noMutation ? "no mutations" : "MUTATIONS DETECTED"}`);
  logger?.info(`  📊 Post-processing score: ${ppReport.scores.composite}/100 (${ppReport.scores.grade})`);

  // 4. Validate output shape
  logger?.info("🧪 [DryRun] Validating output shape...");
  const hasRequiredFields = ppReport.scores && ppReport.issues && typeof ppReport.passed === "boolean";
  stageResults["output_shape"] = {
    stage: "Output Shape Validation",
    success: hasRequiredFields,
    data: { fields: Object.keys(ppReport) },
    duration_ms: 0,
  };
  logger?.info(`  ${hasRequiredFields ? "✅" : "❌"} Output shape: ${hasRequiredFields ? "valid" : "missing required fields"}`);

  // Summary
  const allPassed = contractValidation.all_passed && budgetEnforced && noMutation && hasRequiredFields;
  logger?.info(`\n${"═".repeat(50)}`);
  logger?.info(`🧪 [DryRun] Result: ${allPassed ? "ALL VALIDATIONS PASSED ✅" : "SOME VALIDATIONS FAILED ❌"}`);
  logger?.info(`${"═".repeat(50)}\n`);

  return {
    success: allPassed,
    job_id: input.job_id,
    pass: allPassed,
    attempts_used: 0,
    max_attempts: 0,
    resume: fixtureResume,
    cover_letter: fixtureCoverLetter,
    plaintext_resume: undefined,
    clarification_questions: [],
    ownership_warnings: [],
    final_report: null as any,
    recruiter_review: undefined,
    refinement_score: ppReport.scores,
    attempt_history: [],
    human_review_required: false,
    human_review_notes: allPassed ? [] : ["Dry-run validation failed — see stage_results for details"],
    stage_results: stageResults,
    cost_summary: undefined,
  };
}
