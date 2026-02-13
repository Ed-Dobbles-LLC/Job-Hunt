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
  attempt_history: AttemptRecord[];
  human_review_required: boolean;
  human_review_notes: string[];
  stage_results: Record<string, StageResult<any>>;
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

// ── Embedding Scoring Config ─────────────────────────────────────

export interface EmbeddingConfig {
  enabled: boolean;
  model: string;
  weight: number;
}
