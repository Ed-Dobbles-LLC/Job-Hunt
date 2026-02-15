/**
 * Resume Tailoring Engine — Shared Types
 *
 * All TypeScript interfaces and Zod schemas used across the 7-stage pipeline.
 */

import { z } from "zod";

// ── Claim Types ──────────────────────────────────────────────────

export type ClaimType =
  | "role"
  | "metric"
  | "scope"
  | "tool"
  | "capability"
  | "certification"
  | "education"
  | "bullet_text";

export interface Claim {
  id: string;
  type: ClaimType;
  value: string;
  normalized: string;
  role_index: number | null;
  role_label: string | null;
  source_span: {
    section: string;
    original_text: string;
  };
  metric_detail?: {
    number: number;
    unit: string;
    display: string;
  };
  scope_detail?: {
    kind: "team_size" | "budget" | "revenue" | "geography" | "business_unit";
    number?: number;
    unit?: string;
  };
  tool_detail?: {
    category: "language" | "platform" | "framework" | "database" | "cloud" | "bi_tool" | "other";
  };
  capability_detail?: {
    domain: string;
    confidence: number;
  };
}

export interface ClaimsLedger {
  claims: Claim[];
  roles: Claim[];
  metrics: Claim[];
  scopes: Claim[];
  tools: Claim[];
  capabilities: Claim[];
  certifications: Claim[];
  education: Claim[];
  bullet_texts: Claim[];
  total_claims: number;
}

// ── Mandate Types ────────────────────────────────────────────────

export interface MandateDimension {
  id: string;
  label: string;
  weight: number;
  score_0_5: number;
  signal_phrases: string[];
  description: string;
}

export interface ToneGuidance {
  seniority: string;
  summary_posture: string;
  bullet_framing: string;
  competency_emphasis: string;
  headline_tone: string;
}

export type SeniorityLevel = "IC" | "Manager" | "Director" | "Sr Director" | "VP" | "SVP" | "C-Suite";

export interface MandateProfile {
  dimensions: MandateDimension[];
  primary_mandate: string;
  secondary_mandates: string[];
  top_3_archetypes: { id: string; label: string; score: number }[];
  seniority_level: SeniorityLevel;
  calibrated_headline: string;
  tone_guidance: ToneGuidance;
  gaps_vs_inventory: string[];
}

// ── Bullet Scoring Types ─────────────────────────────────────────

export interface ScoredBullet {
  bullet_id: string;
  bullet_text: string;
  experience_id: string;
  claim_ids: string[];
  mandate_scores: Record<string, number>;
  embedding_score?: number;
  total_relevance: number;
  rank: number;
}

export interface ScoredBulletPlan {
  scored_bullets: ScoredBullet[];
  reordered_roles: ReorderedRole[];
  mandate_gaps: MandateGap[];
  clarification_questions: ClarificationQuestion[];
}

export interface ReorderedRole {
  experience_id: string;
  employer: string;
  title: string;
  ordered_bullets: ScoredBullet[];
  dropped_bullets: { bullet: ScoredBullet; reason: string }[];
}

export interface MandateGap {
  dimension_id: string;
  label: string;
  weight: number;
  best_coverage: number;
  suggestion: string;
}

// ── Clarification Questions ──────────────────────────────────────

export const ClarificationQuestionSchema = z.object({
  jd_requirement: z.string().describe("The JD requirement that cannot be fully supported"),
  question: z.string().describe("Actionable question for the candidate, e.g., 'Do you have experience with Salesforce CRM?'"),
  closest_ledger_match: z.string().optional().describe("The nearest claim in the ledger, if any"),
  gap_severity: z.enum(["must_have", "nice_to_have"]).describe("How critical this gap is"),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

// ── Draft Resume (Stage 4 output) ────────────────────────────────

export const DraftBulletSchema = z.object({
  text: z.string().describe("The tailored resume bullet text. Action -> Scale -> Outcome. MAX 22 words."),
  source_hash: z.string().describe("Inventory bullet ID this was derived from"),
  evidence_quote: z.string().describe("Verbatim quote from the inventory bullet"),
  claim_ids: z.array(z.string()).describe("Claims ledger IDs that back this bullet").default([]),
});
export type DraftBullet = z.infer<typeof DraftBulletSchema>;

// ── Ownership Inflation ──────────────────────────────────────────

export interface OwnershipInflationWarning {
  location: string;
  original_text: string;
  draft_text: string;
  pattern: string;
  severity: "warning" | "critical";
  explanation: string;
}

// ── Pipeline Stage Results ───────────────────────────────────────

export interface StageResult<T> {
  stage: string;
  success: boolean;
  data: T;
  duration_ms: number;
  errors?: string[];
  warnings?: string[];
}

export interface PipelineResult {
  success: boolean;
  job_id: number;
  pass: boolean;
  attempts_used: number;
  max_attempts: number;
  resume: any;
  cover_letter: any;
  plaintext_resume?: string;
  clarification_questions: ClarificationQuestion[];
  ownership_warnings: OwnershipInflationWarning[];
  final_report: any;
  recruiter_review?: RecruiterReviewReport;
  refinement_score?: import("./refinement-layer").RefinementScore;
  positioning_score?: import("./positioning-pass").PositioningScore;
  attempt_history: AttemptRecord[];
  human_review_required: boolean;
  human_review_notes: string[];
  stage_results: Record<string, StageResult<any>>;
  cost_summary?: import("./cost-tracker").CostSummary;
}

export interface AttemptRecord {
  attempt: number;
  pass: boolean;
  critical_violations: number;
  warnings: number;
  total_checks: number;
  violation_types: string[];
  timestamp: string;
}

// ── Stage 8: Recruiter Review ────────────────────────────────────

export const RecruiterReviewIssueSchema = z.object({
  type: z.enum([
    "UNGROUNDED_METRIC",
    "UNGROUNDED_TOOL",
    "UNGROUNDED_CLAIM",
    "OWNERSHIP_INFLATION",
    "CORRUPTED_WORD",
    "TYPO",
    "INCONSISTENT_TENSE",
    "GENERIC_SUMMARY",
    "REPEATED_PHRASE",
    "VAGUE_CLAIM",
    "MANDATE_MISMATCH",
    "AESTHETIC_DENSITY",
    "COMPETENCY_BLOAT",
    "LENGTH_VIOLATION",
    "COVER_LETTER_DEFECT",
  ]).describe("Category of the issue found"),
  evidence: z.string().describe("The exact text or phrase that triggered this issue"),
  location: z.string().describe("Where in the document: e.g., resume.experience[0].bullets[1] or cover_letter.body[0]"),
  fix: z.string().describe("Specific, actionable fix the candidate or system should apply"),
});
export type RecruiterReviewIssue = z.infer<typeof RecruiterReviewIssueSchema>;

export const RecruiterReviewScoresSchema = z.object({
  truthfulness: z.number().min(0).max(100).describe("How well every claim traces to the Claims Ledger / FactRegistry (100 = all grounded)"),
  ownership_inflation: z.number().min(0).max(100).describe("Freedom from inflated ownership language (100 = no inflation detected)"),
  mandate_alignment: z.number().min(0).max(100).describe("How well summary + top bullets match the job's top mandates (100 = perfect alignment)"),
  differentiation: z.number().min(0).max(100).describe("How unique this resume feels vs a generic template (100 = highly differentiated)"),
  readability: z.number().min(0).max(100).describe("Clarity, concision, tense consistency, and absence of corrupted words (100 = flawless)"),
  aesthetics: z.number().min(0).max(100).describe("Visual scannability, section rhythm, density balance (100 = polished)"),
});
export type RecruiterReviewScores = z.infer<typeof RecruiterReviewScoresSchema>;

export const RecruiterReviewReportSchema = z.object({
  status: z.enum(["PASS", "FAIL"]).describe("Overall verdict: PASS if no critical or major issues remain"),
  critical_issues: z.array(RecruiterReviewIssueSchema).describe("Must-fix issues that block the resume from being sent"),
  major_issues: z.array(RecruiterReviewIssueSchema).describe("Important issues that significantly weaken the application"),
  minor_issues: z.array(RecruiterReviewIssueSchema).describe("Nice-to-fix polish items"),
  scores: RecruiterReviewScoresSchema,
  recommended_actions: z.array(z.string()).describe("Ordered list of the most impactful actions to improve this packet"),
  safe_rewrite_allowed: z.boolean().describe("True if the issues can be fixed by an automated constrained rewrite without human intervention"),
});
export type RecruiterReviewReport = z.infer<typeof RecruiterReviewReportSchema>;

// ── Embedding Scoring Config ─────────────────────────────────────

export interface EmbeddingConfig {
  enabled: boolean;
  model: string;
  weight: number;
}
