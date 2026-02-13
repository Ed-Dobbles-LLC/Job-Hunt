# Resume Tailoring Engine — Implementation Specification

## Version 1.0 | Resume-Agnostic, Multi-Pass Pipeline

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Module Diagram & Responsibilities](#2-module-diagram--responsibilities)
3. [JSON Schemas](#3-json-schemas)
4. [Pipeline Stage 1: Claims Ledger Extraction](#4-pipeline-stage-1-claims-ledger-extraction)
5. [Pipeline Stage 2: Job Mandate Classification](#5-pipeline-stage-2-job-mandate-classification)
6. [Pipeline Stage 3: Evidence-Based Bullet Scoring](#6-pipeline-stage-3-evidence-based-bullet-scoring)
7. [Pipeline Stage 4: Constrained Rewrite](#7-pipeline-stage-4-constrained-rewrite)
8. [Pipeline Stage 5: Differentiation Gate](#8-pipeline-stage-5-differentiation-gate)
9. [Pipeline Stage 6: Layout Governor](#9-pipeline-stage-6-layout-governor)
10. [Pipeline Stage 7: Final Truth Audit](#10-pipeline-stage-7-final-truth-audit)
11. [API Call Sequences](#11-api-call-sequences)
12. [Deterministic vs LLM Delineation](#12-deterministic-vs-llm-delineation)
13. [Model Choice Guidance](#13-model-choice-guidance)
14. [Test Plan](#14-test-plan)
15. [Edge Cases](#15-edge-cases)
16. [Gap Analysis vs Current Implementation](#16-gap-analysis-vs-current-implementation)

---

## 1. System Overview

### Architecture Principle

The engine replaces a single monolithic LLM call with a **7-stage pipeline** where each stage is either:
- **Deterministic code** (no LLM) — for enforcement, validation, layout
- **Constrained LLM call** (structured output) — for classification, rewriting

The pipeline enforces one invariant: **every factual claim in the output resume traces back to a specific claim in the Claims Ledger, which was extracted deterministically from the baseline resume. No exceptions.**

### Data Flow

```
Baseline Resume (text)          Job Description (text)
       │                                │
       ▼                                ▼
┌─────────────────┐            ┌─────────────────────┐
│ Stage 1          │            │ Stage 2              │
│ Claims Ledger    │            │ Mandate Classifier   │
│ (DETERMINISTIC)  │            │ (LLM: structured)    │
└────────┬────────┘            └──────────┬──────────┘
         │                                │
         │         ClaimsLedger           │    MandateProfile
         │              │                 │
         ▼              ▼                 ▼
    ┌────────────────────────────────────────┐
    │ Stage 3: Bullet Scoring & Reordering   │
    │ (DETERMINISTIC + optional LLM embed)   │
    └───────────────────┬────────────────────┘
                        │  ScoredBulletPlan
                        ▼
    ┌────────────────────────────────────────┐
    │ Stage 4: Constrained Rewrite           │
    │ (LLM: structured output w/ claim IDs)  │
    └───────────────────┬────────────────────┘
                        │  DraftResume
                        ▼
    ┌────────────────────────────────────────┐
    │ Stage 5: Differentiation Gate          │
    │ (DETERMINISTIC comparison)             │
    │ → If similar: loop back to Stage 4     │
    └───────────────────┬────────────────────┘
                        │  DraftResume (divergent)
                        ▼
    ┌────────────────────────────────────────┐
    │ Stage 6: Layout Governor               │
    │ (DETERMINISTIC: caps, lengths, order)  │
    └───────────────────┬────────────────────┘
                        │  FormattedResume
                        ▼
    ┌────────────────────────────────────────┐
    │ Stage 7: Final Truth Audit             │
    │ (DETERMINISTIC: allowlist + ledger)    │
    │ → If violations: loop to Stage 4       │
    └───────────────────┬────────────────────┘
                        │
                        ▼
              FinalResume (plaintext ATS-safe)
              + ClarificationQuestions (if gaps)
              + AuditReport
```

### Retry Budget

- Stage 4 → 5 → 6 → 7 loop: max **3 attempts**
- After 3 failures: return best attempt + violation report for human review
- "Best attempt" = attempt with fewest critical violations

---

## 2. Module Diagram & Responsibilities

```
src/resume-engine/
├── pipeline.ts                 # Orchestrator — runs stages in sequence
├── types.ts                    # All TypeScript interfaces and Zod schemas
│
├── stage1-claims-ledger/
│   ├── extractor.ts            # DETERMINISTIC: parse baseline → ClaimsLedger
│   ├── parser-roles.ts         # Parse employer, title, dates, location
│   ├── parser-metrics.ts       # Parse $, %, counts with unit detection
│   ├── parser-scope.ts         # Parse team size, budget, geography
│   ├── parser-tools.ts         # Parse tools/platforms (exact strings)
│   └── parser-capabilities.ts  # Parse domain tags with confidence scoring
│
├── stage2-mandate-classifier/
│   ├── classifier.ts           # LLM call: JD → MandateProfile
│   └── taxonomy.ts             # Static mandate taxonomy definitions
│
├── stage3-bullet-scoring/
│   ├── scorer.ts               # DETERMINISTIC: score + reorder bullets
│   ├── keyword-matcher.ts      # Keyword overlap scoring
│   └── embedding-scorer.ts     # Optional: embedding similarity via API
│
├── stage4-constrained-rewrite/
│   ├── rewriter.ts             # LLM call: produce DraftResume w/ claim IDs
│   ├── prompt-builder.ts       # Build system + user prompts
│   └── correction-prompt.ts    # Build correction prompts for retry
│
├── stage5-differentiation/
│   ├── gate.ts                 # DETERMINISTIC: similarity checks
│   ├── phrase-suppressor.ts    # Banned phrase list management
│   └── history-store.ts        # Load/save prior resume snapshots
│
├── stage6-layout-governor/
│   ├── governor.ts             # DETERMINISTIC: all layout enforcement
│   ├── filler-remover.ts       # Regex-based filler phrase stripping
│   └── chronology-enforcer.ts  # Reverse-chrono sorting
│
├── stage7-truth-audit/
│   ├── auditor.ts              # DETERMINISTIC: full truth verification
│   ├── metric-validator.ts     # Numeric claim checking vs ledger
│   ├── entity-validator.ts     # Employer/title/date/tool checking
│   └── placeholder-scanner.ts  # Denylist pattern scanning
│
└── output/
    ├── plaintext-renderer.ts   # Render to ATS-safe plaintext
    └── clarification-builder.ts # Build "questions for candidate" from gaps
```

### Module Responsibilities (what each module owns)

| Module | Type | Owns |
|--------|------|------|
| `pipeline.ts` | Orchestrator | Stage sequencing, retry logic, best-attempt tracking |
| `stage1-claims-ledger/` | **Deterministic** | Parsing baseline text into structured claims with IDs |
| `stage2-mandate-classifier/` | **LLM** | Classifying JD into mandate weights + tone profile |
| `stage3-bullet-scoring/` | **Deterministic** | Scoring baseline bullets against mandates, producing rank order |
| `stage4-constrained-rewrite/` | **LLM** | Producing the draft resume JSON with claim ID citations |
| `stage5-differentiation/` | **Deterministic** | Comparing against prior outputs, computing similarity scores |
| `stage6-layout-governor/` | **Deterministic** | All formatting rules, bullet caps, word limits, filler removal |
| `stage7-truth-audit/` | **Deterministic** | Verifying every claim against the ledger, producing violation report |
| `output/` | **Deterministic** | Rendering final plaintext + clarification questions |

---

## 3. JSON Schemas

### 3A. Claims Ledger Schema

```typescript
// ── Claim Types ──
type ClaimType =
  | "role"          // employer + title + dates + location as a unit
  | "metric"        // a quantified achievement
  | "scope"         // team size, budget, geography, business size
  | "tool"          // exact tool/platform string
  | "capability"    // domain skill tag (e.g., "forecasting")
  | "certification" // credential
  | "education"     // degree + institution
  | "bullet_text";  // full original bullet text (for provenance)

interface Claim {
  id: string;                   // Unique ID: "cl-{role_index}-{type}-{seq}"
                                // e.g., "cl-0-metric-1", "cl-2-tool-3"
  type: ClaimType;
  value: string;                // The factual content
  normalized: string;           // Lowercased, trimmed, whitespace-collapsed

  // Role association (which job does this fact belong to?)
  role_index: number | null;    // Index in experience array; null for education/certs
  role_label: string | null;    // "Company | Title" for human readability

  // Source provenance
  source_span: {
    section: string;            // "experience[2].bullets[1]", "education[0]"
    original_text: string;      // Verbatim text from baseline
  };

  // Type-specific fields (populated based on claim type)
  metric_detail?: {
    number: number;             // Parsed numeric value (e.g., 12000000)
    unit: string;               // "$", "%", "people", "x", "count"
    timeframe?: string;         // "annually", "over 3 years", "per quarter"
    raw_string: string;         // Original string: "$12M"
  };

  scope_detail?: {
    dimension: "team_size" | "budget" | "geography" | "business_size" | "org_units";
    raw_string: string;
  };

  capability_detail?: {
    domain_tag: string;         // "forecasting", "governance", "platform_architecture"
    confidence: number;         // 0.0-1.0 — how explicitly stated vs inferred
    explicitly_stated: boolean; // true if baseline says "forecasting"; false if inferred
  };
}

interface ClaimsLedger {
  version: string;              // Schema version for forward compat
  extraction_timestamp: string; // ISO 8601
  source_hash: string;          // SHA-256 of input baseline text (cache key)
  total_claims: number;

  claims: Claim[];              // All claims flat

  // Indexed views (built at construction time)
  by_id: Record<string, Claim>;
  by_type: Record<ClaimType, Claim[]>;
  by_role: Record<number, Claim[]>;   // role_index → claims for that role

  // Aggregate facts for quick access
  all_employers: string[];      // Deduplicated, normalized
  all_titles: string[];
  all_tools: string[];          // Exact strings only
  all_metrics_raw: string[];    // Raw metric strings
  date_ranges: { role_index: number; start: string; end: string }[];
}
```

**JSON example:**

```json
{
  "version": "1.0",
  "extraction_timestamp": "2026-02-13T10:00:00Z",
  "source_hash": "a1b2c3...",
  "total_claims": 87,
  "claims": [
    {
      "id": "cl-0-role-0",
      "type": "role",
      "value": "Acme Corp | VP Analytics | 2021-03 to present | New York",
      "normalized": "acme corp | vp analytics | 2021-03 to present | new york",
      "role_index": 0,
      "role_label": "Acme Corp | VP Analytics",
      "source_span": {
        "section": "experience[0]",
        "original_text": "VP Analytics, Acme Corp, New York, NY — March 2021 to Present"
      }
    },
    {
      "id": "cl-0-metric-1",
      "type": "metric",
      "value": "$12M annual revenue impact",
      "normalized": "$12m annual revenue impact",
      "role_index": 0,
      "role_label": "Acme Corp | VP Analytics",
      "source_span": {
        "section": "experience[0].bullets[2]",
        "original_text": "Built pricing optimization model driving $12M annual revenue impact across 3 business units"
      },
      "metric_detail": {
        "number": 12000000,
        "unit": "$",
        "timeframe": "annually",
        "raw_string": "$12M"
      }
    },
    {
      "id": "cl-0-scope-1",
      "type": "scope",
      "value": "45-person organization",
      "normalized": "45-person organization",
      "role_index": 0,
      "role_label": "Acme Corp | VP Analytics",
      "source_span": {
        "section": "experience[0].bullets[0]",
        "original_text": "Led a 45-person analytics organization across forecasting, pricing, and BI"
      },
      "scope_detail": {
        "dimension": "team_size",
        "raw_string": "45-person"
      }
    },
    {
      "id": "cl-0-tool-1",
      "type": "tool",
      "value": "Snowflake",
      "normalized": "snowflake",
      "role_index": 0,
      "role_label": "Acme Corp | VP Analytics",
      "source_span": {
        "section": "experience[0].bullets[3]",
        "original_text": "Migrated legacy warehouse to Snowflake, reducing query latency 65%"
      }
    },
    {
      "id": "cl-0-capability-1",
      "type": "capability",
      "value": "forecasting",
      "normalized": "forecasting",
      "role_index": 0,
      "role_label": "Acme Corp | VP Analytics",
      "source_span": {
        "section": "experience[0].bullets[0]",
        "original_text": "Led a 45-person analytics organization across forecasting, pricing, and BI"
      },
      "capability_detail": {
        "domain_tag": "forecasting",
        "confidence": 1.0,
        "explicitly_stated": true
      }
    }
  ]
}
```

### 3B. Mandate Profile Schema

```typescript
// ── Mandate Taxonomy ──
// Generic across analytics/data leadership roles
type MandateArchetype =
  | "governance_compliance_controls"
  | "reporting_rigor_okrs_cadence"
  | "operating_model_transformation"
  | "insight_delivery_automation"
  | "revenue_ops_pipeline_forecasting"
  | "product_analytics_experimentation"
  | "platform_modernization_data_mgmt"
  | "client_reporting_stakeholder_enablement"
  | "distributed_team_leadership"
  | "growth_monetization";

type ToneProfile =
  | "operator-builder"
  | "governance-rigor"
  | "platform-modernizer"
  | "client-facing"
  | "growth-monetization";

interface MandateWeight {
  archetype: MandateArchetype;
  weight: number;               // 0-5 scale
  signal_phrases: string[];     // JD phrases that triggered this classification
}

interface MandateProfile {
  job_title: string;
  company: string;
  seniority_level: "IC" | "Manager" | "Director" | "VP" | "SVP" | "C-Suite";

  // Top 3 mandates ranked by weight
  top_mandates: [MandateWeight, MandateWeight, MandateWeight];

  // Primary mandate (highest weight)
  primary_mandate: MandateArchetype;
  primary_weight: number;

  // Tone profile
  tone: ToneProfile;

  // Derived guidance
  summary_posture: string;      // e.g., "Lead with control frameworks and metric discipline"
  bullet_framing: string;       // e.g., "Frame achievements as governance outcomes"
  competency_emphasis: string[]; // e.g., ["Data Governance", "Compliance Analytics"]

  // Gap detection (mandates the JD demands but baseline may lack)
  potential_gaps: string[];
}
```

**JSON example:**

```json
{
  "job_title": "VP, Data Governance & Analytics",
  "company": "GlobalBank",
  "seniority_level": "VP",
  "top_mandates": [
    {
      "archetype": "governance_compliance_controls",
      "weight": 5,
      "signal_phrases": ["data governance framework", "regulatory compliance", "SOX controls"]
    },
    {
      "archetype": "reporting_rigor_okrs_cadence",
      "weight": 4,
      "signal_phrases": ["executive dashboards", "KPI cadence", "monthly reporting"]
    },
    {
      "archetype": "distributed_team_leadership",
      "weight": 3,
      "signal_phrases": ["global team", "offshore centers", "multi-region"]
    }
  ],
  "primary_mandate": "governance_compliance_controls",
  "primary_weight": 5,
  "tone": "governance-rigor",
  "summary_posture": "Lead with control frameworks, metric discipline, and compliance outcomes",
  "bullet_framing": "Frame achievements as governance and standardization outcomes, not revenue wins",
  "competency_emphasis": ["Data Governance", "Regulatory Compliance", "Metric Standardization", "Audit Readiness"],
  "potential_gaps": ["SOX-specific compliance experience", "Financial services regulatory knowledge"]
}
```

### 3C. Scored Bullet Plan Schema

```typescript
interface ScoredBullet {
  claim_ids: string[];          // Claims this bullet draws from
  original_text: string;        // Verbatim from baseline
  role_index: number;           // Which role it belongs to
  score: number;                // Composite score (see formula)
  score_breakdown: {
    mandate_alignment: number;  // 0-5
    impact_magnitude: number;   // 0-5
    recency_bonus: number;      // 0-2
  };
  selected: boolean;            // true if within bullet cap for its role
  rank_within_role: number;     // 1-based rank after scoring
}

interface ScoredBulletPlan {
  role_bullet_caps: number[];   // [4, 3, 3, 2] — how many bullets per role
  bullets: ScoredBullet[];      // All bullets scored
  selected_bullets: ScoredBullet[]; // Only the ones within caps
  mandate_used: MandateArchetype;
}
```

### 3D. Draft Resume Schema (Output of Stage 4)

```typescript
interface DraftBullet {
  text: string;                 // The rewritten bullet text
  claim_ids: string[];          // REQUIRED: which ledger claims back this bullet
  original_bullet_ref: string;  // Reference to original baseline bullet
  action_verb: string;          // The leading verb
}

interface DraftRole {
  employer: string;             // Exact from ledger
  title: string;                // Exact from ledger
  start_date: string;           // Exact from ledger
  end_date: string;             // Exact from ledger
  location: string;             // Exact from ledger
  scope_line: string;           // Constructed from scope claims only
  scope_claim_ids: string[];    // Claims backing scope_line
  bullets: DraftBullet[];
}

interface DraftResume {
  target_role: string;
  target_company: string;
  executive_headline: string;
  headline_claim_ids: string[];

  professional_summary: string;
  summary_claim_ids: string[];  // All claims referenced in summary

  core_competencies: string[];
  competency_claim_ids: string[]; // Claims supporting competency inclusion

  experience: DraftRole[];

  tools_and_platforms: string[];  // Exact strings from ledger
  tool_claim_ids: string[];

  education: { institution: string; degree: string; year: string }[];
  certifications: { name: string; year?: string }[];

  // Gaps — things the JD asks for that aren't in the ledger
  clarification_questions: {
    jd_requirement: string;
    question: string;           // "Do you have experience with X?"
    closest_ledger_match?: string;
  }[];

  // ATS
  ats_keywords_used: string[];

  // Audit metadata
  generation_metadata: {
    attempt_number: number;
    model: string;
    temperature: number;
    total_claim_ids_referenced: number;
    bullets_without_claims: number; // MUST be 0
  };
}
```

### 3E. Truth Audit Report Schema

```typescript
type ViolationType =
  | "NEW_NUMBER"          // Metric not in ledger
  | "NEW_TOOL"            // Tool/platform not in ledger
  | "NEW_EMPLOYER"        // Employer name not in ledger
  | "NEW_TITLE"           // Title not in ledger
  | "DATE_MISMATCH"       // Date differs from ledger
  | "MISSING_CLAIM_ID"    // Bullet has no claim IDs
  | "INVALID_CLAIM_ID"    // Claim ID doesn't exist in ledger
  | "PLACEHOLDER"         // Denylist pattern detected
  | "OWNERSHIP_INFLATION" // Implied ownership beyond baseline
  | "CHRONOLOGY_ERROR"    // Roles not in reverse-chrono order

interface Violation {
  type: ViolationType;
  severity: "critical" | "warning";
  location: string;             // e.g., "experience[0].bullets[1].text"
  found_value: string;
  expected_value?: string;
  explanation: string;
  auto_fixable: boolean;        // Can Stage 6 fix this without LLM?
}

interface TruthAuditReport {
  pass: boolean;                // true iff zero critical violations
  attempt_number: number;
  violations: Violation[];
  stats: {
    claims_verified: number;
    metrics_checked: number;
    tools_checked: number;
    entities_checked: number;
    critical_count: number;
    warning_count: number;
  };
  // For retry: structured feedback for Stage 4 correction prompt
  correction_directives: string[];
}
```

### 3F. Differentiation Report Schema

```typescript
interface SimilarityScore {
  prior_job_id: string;
  prior_company: string;
  section: "summary" | "competencies" | "top_bullets";
  similarity_pct: number;       // 0-100
  threshold_pct: number;        // The threshold that was checked
  exceeds_threshold: boolean;
}

interface DifferentiationReport {
  compared_against_count: number;
  similarity_scores: SimilarityScore[];
  suppressed_phrases: string[];         // Phrases banned from this output
  needs_regen: boolean;
  regen_reasons: string[];
  divergence_prompt_addendum: string;   // Injected into Stage 4 retry
}
```

---

## 4. Pipeline Stage 1: Claims Ledger Extraction

### Type: DETERMINISTIC (no LLM)

### Input
- `baseline_text: string` — raw resume text (or structured JSON inventory)

### Output
- `ClaimsLedger`

### Algorithm

```
FUNCTION extractClaimsLedger(baseline_text) → ClaimsLedger:
  claims = []
  claim_counter = 0

  // ── Phase 1: Parse roles ──
  roles = parseRoles(baseline_text)
  // parseRoles uses regex + heuristics to identify:
  //   - Employer name (line before title, or "at Company")
  //   - Title
  //   - Date range (Month Year – Month Year | Present)
  //   - Location
  FOR EACH role IN roles (index i):
    ADD claim: { id: "cl-{i}-role-0", type: "role", ... }
    ADD claim: { id: "cl-{i}-employer-0", type: "role", value: role.employer }
    ADD claim: { id: "cl-{i}-title-0", type: "role", value: role.title }
    ADD claim: { id: "cl-{i}-dates-0", type: "role", value: role.date_range }

  // ── Phase 2: Parse bullets per role ──
  FOR EACH role IN roles (index i):
    bullets = parseBullets(role.raw_text)
    FOR EACH bullet IN bullets (index j):
      // Store full bullet text as a claim (provenance anchor)
      ADD claim: { id: "cl-{i}-bullet-{j}", type: "bullet_text", value: bullet }

      // ── Phase 2a: Extract metrics from bullet ──
      metrics = extractMetrics(bullet)
      // Regex patterns:
      //   \$[\d,.]+[MBKmbk]?     → dollar amounts
      //   [\d,.]+%               → percentages
      //   [\d,]+\+?\s*(?:person|people|FTE|team|member|report)  → team sizes
      //   (\d+)\s*[xX]           → multipliers
      //   (\d+)\s*(?:business unit|client|partner|department)   → scope counts
      FOR EACH metric IN metrics (index k):
        parsed = parseNumericValue(metric.raw)
        ADD claim: {
          id: "cl-{i}-metric-{claim_counter++}",
          type: "metric",
          role_index: i,
          metric_detail: { number: parsed.value, unit: parsed.unit, raw_string: metric.raw },
          source_span: { section: "experience[{i}].bullets[{j}]", original_text: bullet }
        }

      // ── Phase 2b: Extract scope facts ──
      scope_facts = extractScope(bullet)
      // Patterns: team size, budget ($XM budget/investment), geography, business size
      FOR EACH scope IN scope_facts:
        ADD claim: { id: "cl-{i}-scope-{claim_counter++}", type: "scope", scope_detail: {...} }

      // ── Phase 2c: Extract tools/platforms ──
      tools = extractTools(bullet, KNOWN_TOOL_PATTERNS)
      // Uses a static dictionary of ~200 common tools + regex for capitalized proper nouns
      // Exact string matching only — no fuzzy inference
      FOR EACH tool IN tools:
        ADD claim: { id: "cl-{i}-tool-{claim_counter++}", type: "tool", value: tool }

      // ── Phase 2d: Extract capability tags ──
      capabilities = extractCapabilities(bullet)
      // Domain tag dictionary:
      //   "forecast" → forecasting
      //   "governance|compliance|audit|control" → governance
      //   "pipeline|etl|ingestion" → data_engineering
      //   "dashboard|visualization|reporting" → reporting
      //   "experiment|a/b test" → experimentation
      //   etc.
      FOR EACH cap IN capabilities:
        ADD claim: {
          id: "cl-{i}-cap-{claim_counter++}",
          type: "capability",
          capability_detail: {
            domain_tag: cap.tag,
            confidence: cap.confidence,        // 1.0 if exact keyword match; 0.7 if inferred
            explicitly_stated: cap.exact_match  // true if the word appeared verbatim
          }
        }

  // ── Phase 3: Parse education ──
  FOR EACH edu IN parseEducation(baseline_text):
    ADD claim: { type: "education", value: edu.degree + " — " + edu.institution }

  // ── Phase 4: Parse certifications ──
  FOR EACH cert IN parseCertifications(baseline_text):
    ADD claim: { type: "certification", value: cert }

  // ── Phase 5: Build indexes ──
  by_id = Map(claim.id → claim FOR claim IN claims)
  by_type = groupBy(claims, claim.type)
  by_role = groupBy(claims, claim.role_index)

  RETURN ClaimsLedger { claims, by_id, by_type, by_role, ... }
```

### Key Design Decisions

1. **Exact string extraction for tools**: No fuzzy matching. If baseline says "Snowflake", the claim is "Snowflake". Not "Snowflake Data Cloud" or "snowflake".

2. **Confidence scoring for capabilities**: Explicit mentions get 1.0. Inferred capabilities (e.g., "built demand model" → "forecasting") get 0.7. The rewrite step can use capabilities with confidence < 0.8 but must not present them as primary competencies.

3. **Source span preservation**: Every claim keeps the original text it was extracted from. This enables the truth audit to verify that rewritten bullets don't drift from their source.

4. **Deduplication**: Claims are deduplicated by (type, normalized_value, role_index). A tool mentioned in 3 bullets of the same role produces 1 claim with the first occurrence's source span.

---

## 5. Pipeline Stage 2: Job Mandate Classification

### Type: LLM (structured output)

### Input
- `job_description: string`

### Output
- `MandateProfile`

### Mandate Taxonomy

| Archetype | Description | Signal Keywords |
|-----------|-------------|-----------------|
| `governance_compliance_controls` | Establishing/enforcing data governance, SOX, audit, data quality frameworks | governance, compliance, regulatory, SOX, audit, controls, data quality, lineage, catalog |
| `reporting_rigor_okrs_cadence` | Standardizing exec reporting, OKR tracking, metric discipline | reporting cadence, OKR, KPI, executive dashboards, metric standardization, scorecards |
| `operating_model_transformation` | Changing how the org uses data — embed analytics, democratize, restructure | operating model, transform, embed, democratize, COE, center of excellence, org design |
| `insight_delivery_automation` | Automating insight delivery — alerts, narratives, self-service | self-service, automated reporting, alerting, narrative generation, data products |
| `revenue_ops_pipeline_forecasting` | Revenue analytics, pipeline, pricing, demand planning, P&L | revenue, pipeline, pricing, demand planning, forecast, P&L, ARR, LTV, commercial |
| `product_analytics_experimentation` | Product metrics, feature adoption, A/B testing, user journeys | product analytics, experimentation, A/B test, feature adoption, user journey, funnel |
| `platform_modernization_data_mgmt` | Data platform builds, cloud migration, lakehouse, MDM | platform, architecture, migration, cloud, lakehouse, warehouse, MDM, data management |
| `client_reporting_stakeholder_enablement` | External client-facing analytics, stakeholder enablement | client reporting, partner analytics, stakeholder, external dashboards, customer insights |
| `distributed_team_leadership` | Managing distributed/global teams, org building at scale | global team, distributed, offshore, multi-region, hiring, org building, scaling team |
| `growth_monetization` | Growth engineering, conversion optimization, monetization | growth, conversion, monetization, experiment velocity, funnel, acquisition, retention |

### Tone Profile Mapping

| Tone Profile | When to Apply |
|--------------|---------------|
| `operator-builder` | Primary mandate is operating_model or insight_delivery |
| `governance-rigor` | Primary mandate is governance or reporting_rigor |
| `platform-modernizer` | Primary mandate is platform_modernization |
| `client-facing` | Primary mandate is client_reporting or stakeholder_enablement |
| `growth-monetization` | Primary mandate is revenue_ops or growth_monetization |

### LLM Call Specification

```
FUNCTION classifyMandate(jd_text) → MandateProfile:
  // Single LLM call with structured output
  response = LLM_CALL({
    model: "gpt-4o",
    temperature: 0.2,        // Low temp for classification consistency
    response_format: MandateProfileSchema,
    system: MANDATE_CLASSIFIER_SYSTEM_PROMPT,
    user: jd_text
  })
  RETURN response
```

**System prompt for mandate classifier:**

```
You are a job mandate classifier for analytics and data leadership roles.

Given a job description, identify the top 3 operational mandates the role
demands. Score each 0-5 (0 = not mentioned, 5 = clearly the primary focus).

MANDATE TAXONOMY:
[... full taxonomy table from above ...]

RULES:
1. Read the FULL JD. Do not over-index on the title alone.
2. Look for VERBS and ACTION PHRASES, not just nouns.
   "Establish governance frameworks" → governance_compliance_controls (5)
   "Drive revenue growth" → revenue_ops_pipeline_forecasting (4)
3. A JD may have multiple strong mandates. Capture the top 3.
4. Classify seniority from title + reporting line + scope language.
5. Determine tone_profile based on the primary mandate.
6. For summary_posture, bullet_framing, and competency_emphasis: provide
   concrete guidance specific to THIS JD, not generic advice.
7. For potential_gaps: note any JD requirements that are very specific
   (e.g., "SOX audit experience") which a generic analytics leader might lack.

Return ONLY the MandateProfile JSON. No commentary.
```

### Cost Note
This call is cheap (~500-1000 input tokens, ~300 output tokens). Classification accuracy matters more than speed, so gpt-4o is preferred over cheaper models.

---

## 6. Pipeline Stage 3: Evidence-Based Bullet Scoring

### Type: DETERMINISTIC (no LLM; optional embedding call for enhanced matching)

### Input
- `ClaimsLedger`
- `MandateProfile`

### Output
- `ScoredBulletPlan`

### Scoring Formula

```
score = (2 × mandate_alignment) + (1 × impact_magnitude) + recency_bonus
```

Where:
- `mandate_alignment` (0-5): How well this bullet serves the primary mandate
- `impact_magnitude` (0-5): Size of the achievement (regardless of mandate)
- `recency_bonus` (0-2): More recent roles get bonus

**Maximum possible score: 17** (mandate=5×2=10, impact=5, recency=2)

### Computing `mandate_alignment`

**Method A: Keyword overlap (default, no API call)**

```
FUNCTION scoreMandateAlignment(bullet_text, mandate_archetype) → 0-5:
  keywords = MANDATE_KEYWORD_MAP[mandate_archetype]
  // e.g., governance → ["governance", "compliance", "standardiz", "audit",
  //                      "control", "framework", "data quality", "lineage"]

  bullet_lower = lowercase(bullet_text)
  matches = COUNT(kw IN keywords WHERE bullet_lower CONTAINS kw)

  // Scale: 0 matches → 0, 1 → 2, 2 → 3, 3+ → 4, 4+ → 5
  IF matches == 0: RETURN 0
  IF matches == 1: RETURN 2
  IF matches == 2: RETURN 3
  IF matches == 3: RETURN 4
  RETURN 5
```

**Method B: Embedding similarity (optional, requires API call)**

```
FUNCTION scoreMandateAlignmentEmbedding(bullet_text, jd_text) → 0-5:
  bullet_embedding = EMBED(bullet_text)       // text-embedding-3-small
  jd_embedding = EMBED(jd_text)
  similarity = cosineSimilarity(bullet_embedding, jd_embedding)

  // Map 0-1 similarity to 0-5 score
  // Typical cosine similarities: 0.2 (unrelated) to 0.7 (highly related)
  RETURN clamp(0, 5, round((similarity - 0.2) × 10))
```

Use Method A by default. Method B is a quality upgrade for when you want higher precision on mandate matching, at the cost of ~$0.01 per generation for embedding calls.

### Computing `impact_magnitude`

```
FUNCTION scoreImpact(bullet_claims: Claim[]) → 0-5:
  max_score = 0
  FOR EACH claim IN bullet_claims WHERE claim.type == "metric":
    IF claim.metric_detail.unit == "$":
      IF claim.metric_detail.number >= 10_000_000: score = 5
      ELIF claim.metric_detail.number >= 1_000_000: score = 4
      ELIF claim.metric_detail.number >= 100_000: score = 3
      ELSE: score = 2
    ELIF claim.metric_detail.unit == "%":
      IF claim.metric_detail.number >= 40: score = 4
      ELIF claim.metric_detail.number >= 20: score = 3
      ELSE: score = 2
    ELIF claim.metric_detail.unit == "people":
      IF claim.metric_detail.number >= 50: score = 4
      ELIF claim.metric_detail.number >= 20: score = 3
      ELSE: score = 2
    ELSE:
      score = 2
    max_score = max(max_score, score)

  // If no metrics, score based on verb strength
  IF max_score == 0:
    IF bullet contains "built|created|launched|architected|established": RETURN 2
    IF bullet contains "managed|led|oversaw|coordinated": RETURN 1
    RETURN 0

  RETURN max_score
```

### Computing `recency_bonus`

```
FUNCTION recencyBonus(role_index, total_roles) → 0-2:
  IF role_index == 0: RETURN 2    // Most recent role
  IF role_index == 1: RETURN 1    // Second most recent
  RETURN 0                        // Older roles
```

### Anti-Revenue-Domination Rule

```
FUNCTION applyAntiRevenueDomination(scored_bullets, mandate):
  IF mandate.primary_mandate NOT IN ["revenue_ops_pipeline_forecasting", "growth_monetization"]:
    // Revenue bullets should not occupy positions 1-2 of any role
    FOR EACH role_group IN grouped_by_role(scored_bullets):
      revenue_in_top2 = COUNT(b IN role_group[0:2] WHERE isRevenueBullet(b))
      IF revenue_in_top2 >= 2:
        // Demote one revenue bullet, promote highest non-revenue
        swap(role_group[1], first_non_revenue_in(role_group))
```

### Bullet Cap Assignment

```
FUNCTION assignBulletCaps(roles) → number[]:
  caps = []
  current_year = 2026
  FOR EACH role (index i):
    end_year = parseYear(role.end_date)  // "present" → current_year
    years_ago = current_year - end_year
    IF years_ago > 15: caps.push(2)
    ELIF i == 0: caps.push(4)       // Most recent
    ELIF i <= 2: caps.push(3)       // 2nd and 3rd
    ELSE: caps.push(2)              // 4th+
  RETURN caps
```

---

## 7. Pipeline Stage 4: Constrained Rewrite

### Type: LLM (structured output)

### Input
- `ClaimsLedger`
- `MandateProfile`
- `ScoredBulletPlan`
- `job_description: string`
- `correction_directives: string[]` (empty on first attempt; populated on retry)
- `divergence_prompt: string` (empty on first attempt; populated if Stage 5 triggered)

### Output
- `DraftResume`

### Constraint Rules Enforced by Prompt

1. **Every bullet must include `claim_ids`** — an array of claim IDs from the ledger
2. **Bullets with zero `claim_ids` are invalid** and will be rejected by Stage 7
3. **No new tools/platforms/numbers**: The prompt includes the full tool allowlist and metric allowlist derived from the ledger
4. **Scope lines must cite `scope_claim_ids`**
5. **Summary must cite `summary_claim_ids`**
6. **If a JD requirement cannot be satisfied, emit a `clarification_question` instead of fabricating**

### System Prompt Structure

```
You are an executive resume rewrite engine. You produce a DraftResume JSON.

## INVIOLABLE RULES
1. You are given a Claims Ledger. Every number, tool, platform, employer,
   title, and date you emit MUST reference a claim_id from this ledger.
2. Every bullet MUST include a claim_ids array with at least one valid ID.
   A bullet with empty claim_ids will be REJECTED.
3. You may NOT introduce:
   - Any dollar amount not in the ledger
   - Any percentage not in the ledger
   - Any team size not in the ledger
   - Any tool or platform name not in the ledger
   - Any employer or title not in the ledger
4. You may REPHRASE bullets for clarity and impact. You may NOT add new facts.
5. If the JD requires something absent from the ledger:
   - Do NOT fabricate it
   - Add it to clarification_questions with a specific question
   - Use transferable framing for the nearest capability if one exists

## BULLET CONSTRAINTS
- Start every bullet with a direct action verb
- Follow Action → Scale → Outcome format
- Maximum 22 words per bullet
- No filler phrases: "responsible for", "served as", "known for",
  "played a key role", "career defined by"
- No passive: "was tasked with", "was involved in"
- No hedging: "helped", "assisted", "contributed to"
- No stacked metrics (one metric per clause)

## SUMMARY CONSTRAINTS
- Maximum 5 lines (approximately 400 characters)
- First sentence: identity + domain only. NO numbers in sentence 1.
- Every fact must have a matching claim_id in summary_claim_ids

## COMPETENCY CONSTRAINTS
- 8-12 strategic keywords (not tactical tool names)
- Each competency must be supported by at least one capability claim

## MANDATE-DRIVEN ORDERING
- The selected bullets and their order are provided in the ScoredBulletPlan
- Respect the plan's ranking: bullet at rank 1 appears first under its role
- The first 2 bullets per role MUST align with: {mandate.primary_mandate}

## OUTPUT
Return DraftResume JSON. No markdown fences. No commentary.
```

### User Prompt Structure

```
## CLAIMS LEDGER (your ONLY source of truth)
{JSON.stringify(claims_ledger)}

## JOB DESCRIPTION
{jd_text}

## MANDATE PROFILE
{JSON.stringify(mandate_profile)}

## BULLET PLAN (which bullets to use, in what order)
{JSON.stringify(scored_bullet_plan.selected_bullets)}

## BULLET CAPS PER ROLE
{JSON.stringify(scored_bullet_plan.role_bullet_caps)}

## ALLOWLISTS (derived from ledger)
Tools allowed: {claims_ledger.all_tools.join(", ")}
Metrics allowed: {claims_ledger.all_metrics_raw.join(", ")}
Employers allowed: {claims_ledger.all_employers.join(", ")}
Titles allowed: {claims_ledger.all_titles.join(", ")}

{correction_directives.length > 0 ? "## CORRECTIONS FROM PRIOR ATTEMPT\n" + correction_directives.join("\n") : ""}
{divergence_prompt ? "## DIVERGENCE CORRECTIONS\n" + divergence_prompt : ""}

Generate the DraftResume JSON now.
```

### LLM Call Parameters

```
model: "gpt-4o"
temperature: 0.3          // Low for factual consistency; not 0.0 to allow
                           // natural phrasing variation
response_format: DraftResumeSchema (Zod → JSON Schema)
timeout: 120_000           // 2 minutes — structured output can be slow
```

---

## 8. Pipeline Stage 5: Differentiation Gate

### Type: DETERMINISTIC (no LLM)

### Input
- `DraftResume`
- `prior_snapshots: ResumeSnapshot[]` (last N=3 outputs, loaded from storage)

### Output
- `DifferentiationReport`

### Algorithm

```
FUNCTION checkDifferentiation(draft, prior_snapshots) → DifferentiationReport:
  report = new DifferentiationReport()

  IF prior_snapshots.length == 0:
    report.needs_regen = false
    RETURN report

  // ── Check 1: Summary similarity ──
  FOR EACH prior IN prior_snapshots:
    sim = wordOverlap(draft.professional_summary, prior.summary_text)
    report.similarity_scores.push({
      section: "summary",
      similarity_pct: round(sim × 100),
      threshold_pct: 40,
      exceeds_threshold: sim > 0.40
    })
    IF sim > 0.40:
      report.needs_regen = true
      report.regen_reasons.push(
        "Summary {round(sim×100)}% similar to {prior.company} resume (max: 40%)"
      )

  // ── Check 2: Competencies similarity ──
  FOR EACH prior IN prior_snapshots:
    sim = setOverlap(draft.core_competencies, prior.competencies)
    report.similarity_scores.push({
      section: "competencies",
      similarity_pct: round(sim × 100),
      threshold_pct: 60,
      exceeds_threshold: sim > 0.60
    })
    IF sim > 0.60:
      report.needs_regen = true
      report.regen_reasons.push(
        "Competencies {round(sim×100)}% overlap with {prior.company} (max: 60%)"
      )

  // ── Check 3: Top-bullets similarity ──
  current_top_bullets = extractTopBullets(draft, n=3)
  FOR EACH prior IN prior_snapshots:
    sim = bulletSetSimilarity(current_top_bullets, prior.top_bullets_by_role)
    report.similarity_scores.push({
      section: "top_bullets",
      similarity_pct: round(sim × 100),
      threshold_pct: 50,
      exceeds_threshold: sim > 0.50
    })
    IF sim > 0.50:
      report.needs_regen = true
      report.regen_reasons.push(
        "Top bullets {round(sim×100)}% similar to {prior.company} (max: 50%)"
      )

  // ── Check 4: Phrase suppression ──
  all_prior_phrases = UNION(prior.key_phrases FOR prior IN prior_snapshots)
  current_phrases = extractKeyPhrases(draft)
  report.suppressed_phrases = INTERSECTION(current_phrases, all_prior_phrases)

  IF report.needs_regen:
    report.divergence_prompt_addendum = buildDivergencePrompt(report)

  RETURN report
```

### Similarity Functions

**Word overlap (for summary):**
```
FUNCTION wordOverlap(textA, textB) → 0.0-1.0:
  wordsA = SET(lowercase(textA).split(/\s+/).filter(w → w.length > 3))
  wordsB = SET(lowercase(textB).split(/\s+/).filter(w → w.length > 3))
  IF min(|wordsA|, |wordsB|) == 0: RETURN 0
  RETURN |wordsA ∩ wordsB| / min(|wordsA|, |wordsB|)
```

**Set overlap (for competencies):**
```
FUNCTION setOverlap(setA, setB) → 0.0-1.0:
  normA = SET(lowercase(trim(x)) FOR x IN setA)
  normB = SET(lowercase(trim(x)) FOR x IN setB)
  IF min(|normA|, |normB|) == 0: RETURN 0
  RETURN |normA ∩ normB| / min(|normA|, |normB|)
```

### Phrase Suppression List

Maintain a persistent list of overused phrases. Start with:
```
SUPPRESSED_PHRASES = [
  "transforming analytics into strategic growth engines",
  "bridging technical capabilities with business strategy",
  "positioned analytics as a revenue driver",
  "distinctly technical for an executive",
  "career defined by",
  "core c-suite member",
  "serving as core",
  "known for bridging",
  "passionate about data",
  "leveraging data to drive",
  "data-driven decision making",
  "actionable insights",
  "unlock the power of data"
]
```

These phrases are **hard-banned** from all outputs regardless of similarity checks. Add to this list any phrases that appear in 2+ consecutive outputs.

---

## 9. Pipeline Stage 6: Layout Governor

### Type: DETERMINISTIC (no LLM)

### Input
- `DraftResume`
- `MandateProfile`

### Output
- `DraftResume` (mutated in place)
- `LayoutReport`

### Rules (all deterministic, all enforced)

```
FUNCTION governLayout(draft, mandate) → LayoutReport:
  report = new LayoutReport()

  // ── Rule 1: Summary ≤ 5 lines (≈ 400 chars) ──
  IF characterCount(draft.professional_summary) > 400:
    draft.professional_summary = truncateAtSentenceBoundary(
      draft.professional_summary, 400
    )
    report.summary_trimmed = true

  // ── Rule 2: Competencies ≤ 12 items ──
  IF draft.core_competencies.length > 12:
    draft.core_competencies = draft.core_competencies.slice(0, 12)
    report.competencies_trimmed = true

  // ── Rule 3: Bullet caps per role ──
  caps = assignBulletCaps(draft.experience)
  FOR EACH role (index i) IN draft.experience:
    IF role.bullets.length > caps[i]:
      removed = role.bullets.splice(caps[i])
      report.bullets_removed.push(...removed)

  // ── Rule 4: Bullet word limit ≤ 22 words ──
  FOR EACH role IN draft.experience:
    FOR EACH bullet IN role.bullets:
      IF wordCount(bullet.text) > 22:
        report.over_limit_bullets.push({
          text: bullet.text,
          words: wordCount(bullet.text)
        })
        // Attempt deterministic compression
        bullet.text = compressBullet(bullet.text)

  // ── Rule 5: Reverse chronological order ──
  draft.experience = sortByEndDateDescending(draft.experience)
  // "present" sorts first (highest)
  report.chronology_enforced = true

  // ── Rule 6: Remove summary/first-bullet redundancy ──
  FOR EACH role (index i) IN draft.experience:
    IF role.bullets.length > 0:
      overlap = wordOverlap(draft.professional_summary, role.bullets[0].text)
      IF overlap > 0.60:
        report.redundancy_warnings.push(
          "Summary overlaps {round(overlap×100)}% with first bullet of {role.employer}"
        )
        // Demote: move this bullet to position 2, promote bullet at position 2
        IF role.bullets.length > 1:
          swap(role.bullets[0], role.bullets[1])

  // ── Rule 7: Filler phrase removal ──
  FILLER_PATTERNS = [
    /\bknown for\s+/gi,
    /\bcareer defined by\s+/gi,
    /\bdistinctly technical\b.*?[—–-]\s*/gi,
    /\bresponsible for\s+/gi,
    /\bserving as\s+/gi,
    /\bplayed a key role in\s+/gi,
    /\btasked with\s+/gi,
    /\bin charge of\s+/gi,
    /\bstrategically\s+/gi,
    /\bholistically\s+/gi,
    /\bcomprehensively\s+/gi,
    /\beffectively\s+/gi,
    /\bsuccessfully\s+/gi,
    /\bsignificantly\s+/gi,
    /\bhelped\s+/gi,
    /\bassisted\s+(in|with)\s+/gi,
    /\bcontributed to\s+/gi,
    /\bsupported\s+/gi,
  ]
  FOR EACH text_field IN [draft.professional_summary, ...all_bullet_texts]:
    FOR EACH pattern IN FILLER_PATTERNS:
      text_field = text_field.replace(pattern, "")
    // Re-capitalize first letter after stripping
    text_field = capitalize_first(text_field.trim())

  // ── Rule 8: Max total bullets ≤ 15 ──
  total = SUM(role.bullets.length FOR role IN draft.experience)
  IF total > 15:
    // Remove lowest-scoring bullets from oldest roles first
    removeBulletsFromOldestFirst(draft, total - 15, mandate)

  // ── Rule 9: Tools ≤ 1 compact line (≈ 90 chars) ──
  IF draft.tools_and_platforms.join(" | ").length > 90:
    draft.tools_and_platforms = fitToLength(draft.tools_and_platforms, 90)

  RETURN report
```

### Deterministic Bullet Compression

```
FUNCTION compressBullet(text) → string:
  // Remove filler first
  text = applyFillerPatterns(text)

  // Replace wordy constructions
  text = text.replace(/which resulted in/g, "—")
  text = text.replace(/in order to/g, "to")
  text = text.replace(/with the goal of/g, "to")
  text = text.replace(/that enabled/g, "enabling")
  text = text.replace(/across the organization/g, "enterprise-wide")

  // If still over 22 words, truncate at last complete clause
  IF wordCount(text) > 22:
    words = text.split(/\s+/)
    text = words.slice(0, 22).join(" ")
    // Find last natural break (comma, dash, period)
    lastBreak = max(text.lastIndexOf(","), text.lastIndexOf("—"), text.lastIndexOf("."))
    IF lastBreak > text.length * 0.6:
      text = text.substring(0, lastBreak)

  RETURN text
```

---

## 10. Pipeline Stage 7: Final Truth Audit

### Type: DETERMINISTIC (no LLM)

### Input
- `DraftResume`
- `ClaimsLedger`

### Output
- `TruthAuditReport`

### Algorithm

```
FUNCTION auditTruth(draft, ledger) → TruthAuditReport:
  violations = []

  // ── Check 1: Every bullet has claim_ids ──
  FOR EACH role IN draft.experience:
    FOR EACH bullet IN role.bullets:
      IF bullet.claim_ids.length == 0:
        violations.push({
          type: "MISSING_CLAIM_ID",
          severity: "critical",
          location: bulletPath(role, bullet),
          found_value: bullet.text,
          explanation: "Bullet has no claim IDs — cannot verify provenance"
        })

      // ── Check 1b: All claim_ids exist in ledger ──
      FOR EACH cid IN bullet.claim_ids:
        IF cid NOT IN ledger.by_id:
          violations.push({
            type: "INVALID_CLAIM_ID",
            severity: "critical",
            location: bulletPath(role, bullet),
            found_value: cid,
            explanation: "Claim ID does not exist in ledger"
          })

  // ── Check 2: No new numbers ──
  all_text = concat(draft.professional_summary, all_bullet_texts, all_scope_lines)
  found_metrics = extractAllMetrics(all_text)
  FOR EACH metric IN found_metrics:
    IF NOT metricExistsInLedger(metric, ledger):
      violations.push({
        type: "NEW_NUMBER",
        severity: "critical",
        location: findMetricLocation(metric, draft),
        found_value: metric.raw,
        explanation: "Metric not found in claims ledger"
      })

  // ── Check 3: No new tools ──
  found_tools = extractToolMentions(all_text)
  FOR EACH tool IN found_tools:
    IF tool NOT IN ledger.all_tools:
      violations.push({
        type: "NEW_TOOL",
        severity: "critical",
        location: findToolLocation(tool, draft),
        found_value: tool,
        explanation: "Tool/platform not in claims ledger"
      })

  // ── Check 4: Employer/title/date fidelity ──
  FOR EACH role IN draft.experience:
    IF role.employer NOT IN ledger.all_employers:
      violations.push({ type: "NEW_EMPLOYER", severity: "critical", ... })
    IF role.title NOT IN ledger.all_titles:
      violations.push({ type: "NEW_TITLE", severity: "critical", ... })
    IF NOT datesMatchLedger(role, ledger):
      violations.push({ type: "DATE_MISMATCH", severity: "critical", ... })

  // ── Check 5: Chronology order ──
  FOR i = 1 TO draft.experience.length - 1:
    IF endDateOf(draft.experience[i]) > endDateOf(draft.experience[i-1]):
      violations.push({ type: "CHRONOLOGY_ERROR", severity: "critical", ... })

  // ── Check 6: Placeholder/denylist scan ──
  DENYLIST = [
    /example\.com/i, /jane\s+doe/i, /john\s+doe/i, /lorem\s+ipsum/i,
    /\[.*?\]/,       // Square bracket placeholders
    /TODO/i, /FIXME/i, /placeholder/i, /your\s+name/i,
    /xxx/i, /sample/i
  ]
  FOR EACH pattern IN DENYLIST:
    IF pattern.test(all_text):
      violations.push({ type: "PLACEHOLDER", severity: "critical", ... })

  // ── Check 7: Scope line claims ──
  FOR EACH role IN draft.experience:
    IF role.scope_line:
      scope_metrics = extractAllMetrics(role.scope_line)
      FOR EACH metric IN scope_metrics:
        IF NOT metricExistsInLedger(metric, ledger):
          violations.push({
            type: "NEW_NUMBER",
            severity: "critical",
            location: "experience[{i}].scope_line",
            ...
          })

  // ── Check 8: Summary claims ──
  summary_metrics = extractAllMetrics(draft.professional_summary)
  FOR EACH metric IN summary_metrics:
    IF NOT metricExistsInLedger(metric, ledger):
      violations.push({
        type: "NEW_NUMBER",
        severity: "critical",
        location: "professional_summary",
        ...
      })

  // ── Build correction directives for retry ──
  correction_directives = []
  FOR EACH v IN violations WHERE v.severity == "critical":
    IF v.type == "NEW_NUMBER":
      correction_directives.push(
        "REMOVE or REPLACE: {v.found_value} at {v.location} — not in ledger. " +
        "Nearest ledger metrics: {findNearestMetrics(v.found_value, ledger)}"
      )
    IF v.type == "NEW_TOOL":
      correction_directives.push(
        "REMOVE: tool '{v.found_value}' at {v.location} — not in ledger. " +
        "Available tools: {ledger.all_tools.join(', ')}"
      )
    IF v.type == "MISSING_CLAIM_ID":
      correction_directives.push(
        "ADD claim_ids to bullet at {v.location} or DELETE the bullet."
      )

  critical_count = COUNT(v IN violations WHERE v.severity == "critical")
  RETURN TruthAuditReport {
    pass: critical_count == 0,
    violations,
    correction_directives,
    stats: { ... }
  }
```

### Metric Matching Logic

```
FUNCTION metricExistsInLedger(metric, ledger) → boolean:
  // Exact string match
  IF metric.raw IN ledger.all_metrics_raw: RETURN true

  // Numeric match with same unit (0.1% tolerance for float issues)
  FOR EACH claim IN ledger.by_type["metric"]:
    IF claim.metric_detail
       AND claim.metric_detail.unit == metric.unit
       AND abs(claim.metric_detail.number - metric.number) / max(claim.metric_detail.number, 1) < 0.001:
      RETURN true

  // Substring containment (e.g., "$12M" within "$12M annual revenue impact")
  FOR EACH claim IN ledger.by_type["metric"]:
    IF claim.normalized CONTAINS metric.normalized
       OR metric.normalized CONTAINS claim.normalized:
      RETURN true

  RETURN false
```

---

## 11. API Call Sequences

### Full Pipeline — 3 LLM calls minimum, 7 max

```
Call 1: Stage 2 — Mandate Classification
  Model: gpt-4o
  Temperature: 0.2
  Input tokens: ~800 (JD text)
  Output tokens: ~300 (MandateProfile JSON)
  Messages: [
    { role: "system", content: MANDATE_CLASSIFIER_SYSTEM_PROMPT },
    { role: "user", content: jd_text }
  ]
  Expected output: MandateProfile JSON

Call 2: Stage 4 — Constrained Rewrite (attempt 1)
  Model: gpt-4o
  Temperature: 0.3
  Input tokens: ~4000-8000 (ledger + JD + plan + allowlists)
  Output tokens: ~2000-3000 (DraftResume JSON)
  Messages: [
    { role: "system", content: REWRITE_SYSTEM_PROMPT },
    { role: "user", content: REWRITE_USER_PROMPT(ledger, jd, mandate, plan) }
  ]
  Expected output: DraftResume JSON

--- Stages 5, 6, 7 run deterministically ---

IF Stage 7 fails (critical violations):
  Call 3: Stage 4 — Constrained Rewrite (attempt 2)
    Model: gpt-4o
    Temperature: 0.2  // Lower temp for correction
    Messages: [
      { role: "system", content: REWRITE_SYSTEM_PROMPT },
      { role: "user", content: REWRITE_USER_PROMPT + "\n\n" + CORRECTION_DIRECTIVES }
    ]

  --- Stages 5, 6, 7 again ---

IF Stage 7 fails again:
  Call 4: Stage 4 — Constrained Rewrite (attempt 3, final)
    Model: gpt-4o
    Temperature: 0.15 // Even lower
    // Include full violation list in prompt

  --- Stages 5, 6, 7 one last time ---

IF still failing: return best attempt + violation report
```

### Cost Estimate Per Resume

| Call | Input Tokens | Output Tokens | Cost (gpt-4o) |
|------|-------------|---------------|----------------|
| Mandate Classification | ~1,000 | ~300 | ~$0.004 |
| Rewrite (attempt 1) | ~6,000 | ~2,500 | ~$0.035 |
| Rewrite (attempt 2, if needed) | ~7,000 | ~2,500 | ~$0.040 |
| Rewrite (attempt 3, if needed) | ~8,000 | ~2,500 | ~$0.045 |
| **Typical (1 retry)** | | | **~$0.08** |
| **Worst case (3 retries)** | | | **~$0.12** |

---

## 12. Deterministic vs LLM Delineation

| Stage | Name | Type | Why |
|-------|------|------|-----|
| 1 | Claims Ledger Extraction | **DETERMINISTIC** | Parsing structured text doesn't need intelligence. Regex + heuristics are more reliable and auditable than an LLM. Zero hallucination risk. |
| 2 | Mandate Classification | **LLM** | Understanding the "soul" of a JD — what it *really* needs vs. what it lists — requires reading comprehension beyond keyword matching. |
| 3 | Bullet Scoring | **DETERMINISTIC** | A formula with clear weights is transparent and debuggable. Embedding similarity (optional) is the one exception. |
| 4 | Constrained Rewrite | **LLM** | Rephrasing bullets for executive tone while maintaining factual grounding requires natural language generation. This is the one stage where LLM creativity is welcome — within strict guard rails. |
| 5 | Differentiation Gate | **DETERMINISTIC** | Similarity computation is a math problem. No LLM needed. |
| 6 | Layout Governor | **DETERMINISTIC** | Character counts, word counts, array slicing, regex substitution. These MUST be deterministic to be reliable. |
| 7 | Truth Audit | **DETERMINISTIC** | The whole point of the audit is to catch LLM errors. Using an LLM to audit itself is circular. All verification is regex + exact matching + numeric comparison. |

### Why This Split Matters

The previous single-call approach asked the LLM to simultaneously:
- Understand the JD (classification)
- Score relevance (ranking)
- Rewrite bullets (generation)
- Enforce layout (formatting)
- Avoid hallucination (truth)

This conflates tasks where the LLM excels (understanding, generation) with tasks where it's unreliable (counting words, enforcing exact constraints). The pipeline separates these concerns.

---

## 13. Model Choice Guidance

### Where Model Choice Matters

| Stage | Recommended | Why | Alternative |
|-------|------------|-----|-------------|
| Stage 2: Classification | gpt-4o | High classification accuracy matters more than speed. gpt-4o understands nuanced JD language well. | Claude Sonnet 4.5 — comparable classification accuracy at similar cost |
| Stage 4: Rewrite | gpt-4o | Best balance of instruction-following (critical for claim_id citation) and natural executive tone. | Claude Sonnet 4.5 — slightly better at long-form tone; slightly worse at strict JSON schema adherence |
| Optional embeddings (Stage 3) | text-embedding-3-small | Cheapest embedding model with sufficient quality for mandate similarity | text-embedding-3-large for marginal quality improvement |

### Where Model Choice Does NOT Matter

- **Stages 1, 3, 5, 6, 7**: No model choice — these are deterministic code.
- **Temperature**: Keep ≤ 0.3 for all LLM calls. The rewrite stage needs some variation (0.3) to avoid robotic output, but classification (0.2) and correction (0.15) should be lower.

### Model Switching Strategy

If you want to run the pipeline with different models:
- Only Stage 2 and Stage 4 need model configuration
- Both stages use the Vercel AI SDK `generateObject()` pattern with Zod schemas
- Swap the model parameter; prompts don't need changing
- Test with the truth audit (Stage 7) — if a model produces more violations, it's a worse fit

---

## 14. Test Plan

### Unit Tests (8)

**Test 1: Ledger Extraction — Metric Parsing**
```
INPUT: Baseline text containing "$12M revenue", "45-person team", "65% reduction"
ASSERT: Ledger contains exactly 3 metric claims
ASSERT: metric_detail.number for "$12M" == 12_000_000
ASSERT: metric_detail.unit for "$12M" == "$"
ASSERT: metric_detail.unit for "65%" == "%"
ASSERT: metric_detail.unit for "45-person" == "people"
```

**Test 2: No New Numbers**
```
INPUT: DraftResume with bullet containing "$15M" (not in ledger)
INPUT: ClaimsLedger with only "$12M" and "$8M"
ASSERT: Truth audit returns violation { type: "NEW_NUMBER", found_value: "$15M" }
ASSERT: report.pass == false
```

**Test 3: No New Tools**
```
INPUT: DraftResume with bullet mentioning "Databricks" (not in ledger)
INPUT: ClaimsLedger with tools = ["Snowflake", "Tableau", "Python"]
ASSERT: Truth audit returns violation { type: "NEW_TOOL", found_value: "Databricks" }
ASSERT: report.pass == false
```

**Test 4: Chronology Enforcement**
```
INPUT: DraftResume with experience[0].end_date = "2019-06", experience[1].end_date = "present"
ASSERT: After Layout Governor, experience[0].end_date == "present"
ASSERT: report.chronology_enforced == true
```

**Test 5: Bullet Caps**
```
INPUT: DraftResume with 6 bullets on most recent role, 5 on second role
ASSERT: After Layout Governor, role[0].bullets.length == 4
ASSERT: After Layout Governor, role[1].bullets.length == 3
ASSERT: report.bullets_removed.length == 4
```

**Test 6: Summary Length**
```
INPUT: DraftResume with 600-character summary
ASSERT: After Layout Governor, summary.length <= 400
ASSERT: Summary ends at a sentence boundary (period)
ASSERT: report.summary_trimmed == true
```

**Test 7: Similarity Gate**
```
INPUT: DraftResume with summary "Analytics executive who built and scaled..."
INPUT: Prior snapshot with summary "Analytics executive who built and scaled..."
ASSERT: DifferentiationReport.needs_regen == true
ASSERT: similarity_scores[0].section == "summary"
ASSERT: similarity_scores[0].exceeds_threshold == true
```

**Test 8: Truth Audit — Missing Claim IDs**
```
INPUT: DraftResume with bullet { text: "Built model...", claim_ids: [] }
ASSERT: Truth audit returns violation { type: "MISSING_CLAIM_ID" }
ASSERT: correction_directives contains instruction to add claim_ids or delete bullet
```

### Integration Tests (3)

**Integration Test 1: Governance JD**
```
INPUT: Baseline resume for a generic analytics leader (5 roles, 20 bullets)
INPUT: JD for "VP, Data Governance" emphasizing SOX, compliance, audit
PIPELINE: Run full 7-stage pipeline
ASSERT: MandateProfile.primary_mandate == "governance_compliance_controls"
ASSERT: First 2 bullets of most recent role contain governance/compliance keywords
ASSERT: Revenue bullets do NOT appear in positions 1-2 of any role
ASSERT: Core competencies include "Data Governance" or "Compliance"
ASSERT: No tools mentioned that aren't in baseline
ASSERT: No numbers that aren't in baseline
ASSERT: All bullets have non-empty claim_ids
ASSERT: Truth audit passes (0 critical violations)
ASSERT: Summary does NOT lead with revenue
ASSERT: professional_summary.length <= 400
ASSERT: Total bullets <= 15
```

**Integration Test 2: Client Reporting JD**
```
INPUT: Same baseline resume
INPUT: JD for "Director, Client Analytics" emphasizing stakeholder delivery
PIPELINE: Run full 7-stage pipeline
ASSERT: MandateProfile.primary_mandate == "client_reporting_stakeholder_enablement"
ASSERT: Competencies emphasize stakeholder/client terms
ASSERT: Summary language differs from governance test by > 60% word overlap
ASSERT: Bullets prioritize client-facing achievements
ASSERT: Truth audit passes
ASSERT: If baseline lacks "client reporting" experience specifically,
        clarification_questions is non-empty
```

**Integration Test 3: Platform Modernization JD**
```
INPUT: Same baseline resume
INPUT: JD for "VP, Data Platform Engineering" emphasizing cloud migration
PIPELINE: Run full 7-stage pipeline
ASSERT: MandateProfile.primary_mandate == "platform_modernization_data_mgmt"
ASSERT: First 2 bullets of recent role mention platform/architecture/migration
ASSERT: Revenue bullets demoted below platform bullets
ASSERT: Tools section prioritizes infrastructure tools (Snowflake, AWS, etc.)
ASSERT: Truth audit passes
ASSERT: Summary language differs from both prior tests by > 60%
```

### Edge Case Tests

**Edge 1: Baseline Missing Metrics**
```
INPUT: Baseline with qualitative bullets only ("Improved team processes")
ASSERT: Ledger has 0 metric claims
ASSERT: DraftResume bullets contain NO dollar amounts or percentages
ASSERT: Truth audit passes (no violations — nothing to violate)
ASSERT: Bullets use qualitative framing ("Redesigned process" not "$0 impact")
```

**Edge 2: Baseline Missing Tools**
```
INPUT: Baseline that never names specific tools
ASSERT: Ledger has 0 tool claims
ASSERT: DraftResume tools_and_platforms is empty
ASSERT: If JD requires "Snowflake experience", clarification_questions contains:
        "Do you have experience with Snowflake or equivalent cloud data platforms?"
ASSERT: Resume does NOT mention Snowflake
```

**Edge 3: JD Heavy on Tools Not in Baseline**
```
INPUT: JD requiring Databricks, dbt, Airflow, Kubernetes
INPUT: Baseline only mentions Snowflake and Python
ASSERT: Resume only mentions Snowflake and Python
ASSERT: clarification_questions contains questions about Databricks, dbt, Airflow, Kubernetes
ASSERT: Core competencies use strategic framing ("Data Platform Architecture")
        rather than naming tools the candidate doesn't have
ASSERT: Truth audit passes — no new tools smuggled in
```

---

## 15. Edge Cases

### Handling Ambiguous Metrics

If baseline says "grew revenue significantly" without a number:
- The claim type is `bullet_text` (not `metric`)
- The rewrite may say "Drove revenue growth" but must NOT add a number
- The truth audit checks: any number in the rewrite that wasn't in the source claim → violation

### Handling Promotional Titles

If baseline shows "Senior Analyst → Manager → Director" at the same company:
- These are 3 separate role claims with distinct date ranges
- The rewrite should list them as separate entries (or combined with "promoted to")
- Both formats are valid as long as all dates match the ledger

### Handling Gaps in Employment

If baseline shows a 2-year gap between roles:
- The ledger records only what exists (no gap claims)
- The rewrite must preserve the date ranges exactly
- The layout governor does NOT fill gaps or adjust dates

### Handling Very Short Baselines

If baseline has only 2 roles with 3 bullets each:
- Ledger will be small (~15-20 claims)
- Bullet caps: [3, 2] (most recent gets 3, not 4, since only 3 source bullets)
- The rewrite stage should not fabricate bullets to fill caps
- Under-cap is acceptable; over-cap is not

### Handling Non-English Content

If baseline contains non-English text:
- The ledger extracts it verbatim (exact string preservation)
- The rewrite stage should maintain the same language
- Metric parsing may miss non-English number formats; add locale-aware patterns if needed

---

## 16. Gap Analysis vs Current Implementation

### What Already Exists (in current codebase)

| Component | Current File | Status |
|-----------|-------------|--------|
| Claims Ledger | `claimsLedger.ts` | Exists but extracts from structured JSON inventory, not raw text. Needs raw-text parser. |
| Mandate Classifier | `mandateClassifier.ts` | Exists with 10 archetypes. Close to spec — needs tone_profile and competency_emphasis fields. |
| Bullet Scoring | `resumeCompressor.ts` (partial) | Exists as part of compression, not as standalone stage. Needs explicit scoring formula extraction. |
| Constrained Rewrite | `generateResumeTool.ts` | Single-call approach. Needs refactoring into pipeline stage with claim_id citation requirement. |
| Differentiation Gate | `resumeDivergenceEnforcer.ts` | Exists with thresholds and phrase suppression. Closely matches spec. |
| Layout Governor | `resumeCompressor.ts` | Exists with most rules. Needs to be separated from scoring logic. |
| Truth Audit | `truthfulnessVerifier.ts` | Exists with 11 check types. Strong foundation — needs claim_id validation layer. |

### What Needs to Be Built

1. **Pipeline orchestrator** (`pipeline.ts`) — Stage sequencing with retry logic
2. **Raw text parser for Claims Ledger** — Currently only handles JSON inventory; needs text-based extraction for resume-agnostic input
3. **Explicit bullet scoring module** — Extract scoring formula from compressor into standalone stage
4. **Claim ID citation in rewrite output** — Current rewrite uses `source_hash` and `evidence_quote`; needs structured `claim_ids[]` per bullet
5. **Clarification questions output** — Current system uses `gap_notes`; needs reformulation as actionable questions
6. **Plaintext ATS renderer** — Current system produces DOCX; needs plaintext output option

### Migration Path

1. Extract scoring logic from `resumeCompressor.ts` → new `stage3-bullet-scoring/scorer.ts`
2. Refactor `generateResumeTool.ts` to use pipeline orchestrator instead of single call
3. Add `claim_ids` field to `ResumeBulletSchema` (backward compatible — optional initially)
4. Add raw text parser alongside existing JSON inventory parser in `stage1-claims-ledger/`
5. Split `compressResume()` into Stage 3 (scoring) and Stage 6 (layout) functions
6. Add `clarification_questions` output alongside existing `gap_notes`

---

## Appendix A: Complete Mandate Keyword Map

```typescript
const MANDATE_KEYWORDS: Record<MandateArchetype, string[]> = {
  governance_compliance_controls: [
    "governance", "compliance", "regulatory", "sox", "audit", "controls",
    "data quality", "lineage", "catalog", "policy", "framework",
    "standardization", "metric discipline", "data steward"
  ],
  reporting_rigor_okrs_cadence: [
    "reporting", "okr", "kpi", "cadence", "dashboard", "scorecard",
    "executive reporting", "metric review", "data dictionary",
    "single source of truth", "ssot"
  ],
  operating_model_transformation: [
    "operating model", "transform", "embed", "democratiz", "coe",
    "center of excellence", "org design", "reorganiz", "change management",
    "federated", "centralized"
  ],
  insight_delivery_automation: [
    "self-service", "automated reporting", "alerting", "insight",
    "narrative", "data product", "decision support", "real-time",
    "notification", "proactive"
  ],
  revenue_ops_pipeline_forecasting: [
    "revenue", "pipeline", "pricing", "demand planning", "forecast",
    "p&l", "arr", "mrr", "ltv", "commercial", "sales analytics",
    "monetiz", "margin"
  ],
  product_analytics_experimentation: [
    "product analytics", "experiment", "a/b test", "feature",
    "adoption", "user journey", "funnel", "retention", "engagement",
    "product-led"
  ],
  platform_modernization_data_mgmt: [
    "platform", "architect", "moderniz", "migrat", "cloud",
    "lakehouse", "warehouse", "mdm", "data management", "pipeline",
    "etl", "data mesh", "infrastructure"
  ],
  client_reporting_stakeholder_enablement: [
    "client", "stakeholder", "partner", "external", "customer insight",
    "client analytics", "advisory", "enablement", "onboarding"
  ],
  distributed_team_leadership: [
    "global team", "distributed", "offshore", "multi-region", "hire",
    "scale team", "organizational design", "talent", "mentor",
    "cross-functional"
  ],
  growth_monetization: [
    "growth", "conversion", "monetiz", "experiment velocity", "funnel",
    "acquisition", "retention", "churn", "upsell", "cross-sell",
    "cac", "payback"
  ]
};
```

## Appendix B: ATS-Safe Section Headings

The plaintext renderer must use these exact headings (ALL CAPS):

```
EXECUTIVE SUMMARY
CORE COMPETENCIES
PROFESSIONAL EXPERIENCE
TOOLS & PLATFORMS
EDUCATION
CERTIFICATIONS
```

No other heading formats. No decorators (lines, stars, boxes). Standard bullet character: `•` or `-`.

## Appendix C: Ownership Inflation Patterns

These patterns indicate the rewrite may be claiming more than the baseline supports:

| Pattern | Risk | Example |
|---------|------|---------|
| "I built" when baseline says "Contributed to building" | Ownership inflation | Baseline: "Member of team that built..." → Rewrite: "Built..." |
| "Led" when baseline says "Participated in" | Role inflation | |
| "$XM total" when baseline lists individual amounts | Metric aggregation | Baseline has "$5M" and "$7M" separately → Rewrite: "$12M total" |
| "C-Suite" when baseline shows Director level | Title inflation | |

Stage 7 should flag these as `OWNERSHIP_INFLATION` warnings (not critical, since they're judgment calls), but the patterns should be checked.

---

*End of specification.*
