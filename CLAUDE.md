# CLAUDE.md — Job Match Automation System

## Project Overview

Automated job application pipeline that fetches job alerts from Gmail/imported emails, scores them against a structured experience inventory, and generates truthful, ATS-optimized application packets (resume, cover letter, evidence map). The system enforces a zero-fabrication policy through a 6-layer deterministic verification engine backed by a FactRegistry and EntityAllowlist. Every claim in generated documents must trace to a source bullet in `experience_inventory.json`. Deployed on Railway, orchestrated by Inngest, served by Mastra framework on Hono.

The codebase has two generation paths:
1. **Agent-driven pipeline** — The `jobMatchAgent` orchestrates 19 tools via LLM tool-calling through the Inngest workflow.
2. **Resume Engine pipeline** — An 8-stage + post-processing deterministic-first pipeline (`src/resume-engine/`) that separates LLM calls (stages 2, 4, 8) from deterministic processing (stages 1, 3, 5, 6, 7, post-processing) for reproducibility. Two architecture versions available via `PIPELINE_ARCH` feature flag (v1 legacy, v2 consolidated).

## Tech Stack

- **Runtime**: Node.js 22 (ES2022 modules)
- **Framework**: [Mastra](https://mastra.ai) v0.20 (Hono-based server, tool/agent/workflow primitives)
- **Orchestration**: Inngest v3.40 (step functions, cron triggers, retries); falls back to in-process scheduler if Inngest keys not configured
- **Database**: PostgreSQL (Neon in production) via `pg` driver — raw SQL, no ORM
- **LLM**: OpenAI gpt-4o via `@ai-sdk/openai` + Vercel AI SDK (`generateObject`)
- **Document Generation**: `docx` library (DOCX) + LibreOffice headless (PDF conversion)
- **Email**: Gmail API via `googleapis` (OAuth2 refresh token flow)
- **Resume Parsing**: `mammoth` (DOCX), `pdf-parse` (PDF)
- **Enrichment**: 2-phase (URL scraping → LLM web search fallback), Clay webhooks (optional), Apollo.io job search (optional)
- **Testing**: Vitest v4 (26 test files)
- **Deployment**: Railway (Dockerfile, `node:22-slim` + LibreOffice)
- **Language**: TypeScript (strict mode, bundler module resolution)
- **Formatting**: Prettier

## Architecture

```
Gmail / Import API / Apollo / Clay
       │
       ▼
┌──────────────────────────────────────────────────────┐
│  Mastra Server (Hono, port 5000)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │Dashboard │ │Profile   │ │Settings  │ │Setup   │ │
│  │Routes    │ │Builder   │ │Routes    │ │Routes  │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│           │                                          │
│           ▼                                          │
│  ┌──────────────────────────────────────────┐       │
│  │  Inngest (or in-process cron fallback)    │       │
│  │  jobMatchWorkflow: 5 sequential steps     │       │
│  │  1. Fetch & parse emails                  │       │
│  │  2. Enrich via web search + Clay          │       │
│  │  3. Score & shortlist (top 10)            │       │
│  │  4. Generate packets (per job)            │       │
│  │  5. Send daily digest email               │       │
│  └──────────────────────────────────────────┘       │
│           │                                          │
│     ┌─────┴──────┐                                   │
│     ▼            ▼                                   │
│  ┌────────┐  ┌────────────────────────────────────┐ │
│  │ Tool   │  │ Resume Engine (7-stage pipeline)    │ │
│  │ Layer  │  │ Claims→Mandate→Score→Rewrite→       │ │
│  │(49 ts) │  │ Diverge→Layout→Truth                │ │
│  └────────┘  └────────────────────────────────────┘ │
│           │                                          │
│           ▼                                          │
│  PostgreSQL (Neon)     output/ filesystem             │
└──────────────────────────────────────────────────────┘
```

The server runs as a single Mastra instance with one active agent (`jobMatchAgent`) and one active workflow (`jobMatchWorkflow`). Runtime checks enforce exactly 1 registered agent and 1 registered workflow. Example files (`exampleAgent.ts`, `exampleWorkflow.ts`, `exampleTool.ts`) exist as templates but are not registered.

## File Structure

```
src/mastra/
├── index.ts                    # Mastra app entrypoint, server config, API routes, middleware, cron scheduler
├── agents/
│   ├── jobMatchAgent.ts        # Single agent with 19 tools, system prompt, gpt-4o
│   └── exampleAgent.ts         # Template (not registered)
├── workflows/
│   ├── jobMatchWorkflow.ts     # 5-step Inngest workflow + runWorkflowDirectly()
│   └── exampleWorkflow.ts      # Template (not registered)
├── inngest/
│   ├── client.ts               # Inngest client initialization
│   └── index.ts                # Inngest serve config, cron registration, API route forwarding
├── storage/
│   └── index.ts                # ResilientPostgresStore with retry logic for Railway startup
├── tools/                      # 49 tool files (see Tool Layer section below)
├── dashboardRoutes.ts          # Dashboard API (jobs list, detail, preview, download, trigger)
├── profileBuilderRoutes.ts     # Profile builder API (resume upload, interview, export)
├── jobSourceRoutes.ts          # Job source management API (Apollo, Clay)
├── settingsRoutes.ts           # Settings API (DB-backed with env fallback)
├── setupRoutes.ts              # Setup wizard API (OAuth flow, initial config)
└── public/
    ├── index.html              # Dashboard UI
    ├── profile.html            # Profile builder UI
    └── settings.html           # Settings UI

src/resume-engine/              # 8-stage + post-processing deterministic-first resume pipeline
├── candidate-identity.ts       # CandidateIdentity type, MissingBaselineError, identity resolution + output validation guards
├── inventory-loader.ts         # Centralized inventory loader (replaces 11 duplicates). Throws MissingBaselineError, never stubs.
├── types.ts                    # TypeScript interfaces + Zod schemas (Claim, ClaimsLedger, MandateProfile, etc.)
├── pipeline.ts                 # Feature-flag router: dispatches to v1, v2, or dry-run based on PIPELINE_ARCH
├── pipeline-v1.ts              # v1 (legacy) orchestrator — original 7-stage pipeline preserved
├── pipeline-v2.ts              # v2 (consolidated) orchestrator — budget enforcement, detection-only QA, transaction safety
├── pipeline-dry-run.ts         # Dry-run mode: validates contracts, budget, immutability using fixtures (no LLM/DB)
├── pipeline-budget.ts          # Budget enforcer: LLM call caps, cost ceiling, repair loop limits, timeout
├── pipeline-transaction.ts     # Transaction safety: atomic BEGIN/COMMIT/ROLLBACK for DB writes
├── stage-contracts.ts          # Stage Contract Matrix: allowed/forbidden mutations, failure modes, retry policies
├── post-processing-controller.ts # Consolidated detection-only QA (replaces QA Gate + Refinement Layer in v2)
├── repair-controller.ts        # Safe deterministic patches + budget-counted LLM repair
├── auto-generate.ts            # Entry point for batch packet generation (minScore/topN filtering)
├── stage1-claims-ledger/
│   └── extractor.ts            # Deterministic: parse resume → Claims with unique IDs (cl-{role}-{type}-{seq})
├── stage2-mandate-classifier/
│   └── classifier.ts           # LLM: classify JD → MandateProfile (archetypes, seniority, tone)
├── stage3-bullet-scoring/
│   └── scorer.ts               # Deterministic: score bullets by (mandate×2 + impact + recency)
├── stage4-constrained-rewrite/
│   └── rewriter.ts             # LLM: generate resume + cover letter (structured output, claim_ids required)
├── stage5-differentiation/
│   └── gate.ts                 # Deterministic: mandate-scoped compare vs last 3 resumes in resume_history
├── stage6-layout-governor/
│   └── governor.ts             # Deterministic: enforce bullet caps, word limits, filler removal
├── stage7-truth-audit/
│   └── auditor.ts              # Deterministic: verify all claims, detect ownership inflation
├── stage8-recruiter-review/
│   └── reviewer.ts             # LLM: structured recruiter feedback (detection-only, no rewrite loops in v2)
├── qa/
│   └── verbIntegrityGuard.ts   # Verb integrity check (detection-only by default in v2)
└── output/
    ├── plaintext-renderer.ts   # ATS-safe plaintext resume rendering
    └── clarification-builder.ts # Build gap-closure questions for human review

src/triggers/                   # Event-driven workflow invocation
├── cronTriggers.ts             # Time-based scheduled execution
├── slackTriggers.ts            # Slack message events → workflow (OAuth + webhook)
├── telegramTriggers.ts         # Telegram bot messages → workflow
└── exampleConnectorTrigger.ts  # Template for webhook integrations (Linear example)

experience_inventory.json       # Single source of truth for all candidate facts
output/YYYY-MM-DD/Company/Role/ # Generated artifacts (DOCX, PDF, JSON)
fixtures/emails/                # Test email fixtures (Indeed, LinkedIn)
tests/                          # 26 Vitest test files
scripts/                        # Build + dev helper scripts
spec/                           # Technical specifications
.github/workflows/              # CI/CD (auto-merge for claude/* branches)
```

## Tool Layer (49 files in `src/mastra/tools/`)

### Core Infrastructure
| File | Purpose |
|------|---------|
| `db.ts` | PostgreSQL pool, `initDatabase()` with all CREATE TABLE + ALTER TABLE statements |
| `paths.ts` | WORKSPACE_ROOT detection (handles `.mastra/output/` bundle path) |
| `gmailClient.ts` | Gmail OAuth2 client (direct + Replit connector) |
| `digestEmailTemplate.ts` | HTML email template rendering for digest emails |

### Profile Management
| File | Purpose |
|------|---------|
| `profileSchemas.ts` | Zod schemas for ExperienceInventory, Bullet, Experience, etc. |
| `profileInterviewTool.ts` | Generates follow-up interview questions for profile builder |
| `resumeParserTool.ts` | Extracts raw text from resume files (PDF, DOCX, TXT) |
| `extractInventoryTool.ts` | Extracts FactRegistry from experience inventory |
| `resumeStructurerTool.ts` | LLM-based structured ExperienceInventory draft from raw text |
| `jobPostingSchema.ts` | JobPosting Zod schema + dedup helpers (SimHash, normalize, classifyLevel) |

### Fact & Entity Verification
| File | Purpose |
|------|---------|
| `factRegistry.ts` | FactAtom extraction from inventory (indexed truth source) |
| `entityAllowlist.ts` | EntityAllowlist + EntityDenylist + placeholder scanner |
| `truthfulnessVerifier.ts` | 6-layer deterministic verifier (entities, metrics, dates, style, ATS) |
| `verifyTruthTool.ts` | LLM-assisted truth verification (5-layer) |
| `verifyTruthfulnessTool.ts` | Mastra tool wrapper for truthfulnessVerifier |
| `claimsLedger.ts` | Claim ID extraction from inventory (hard gate for resume generation) |

### Job Scoring & Matching
| File | Purpose |
|------|---------|
| `roleShapeClassifier.ts` | JD → Shape A/B/C/D classifier (strategy/engineering/analytics/IC) |
| `extractJDRequirementsTool.ts` | LLM-based JD decomposition (must_have, nice_to_have, etc.) |
| `matchScorer.ts` | Deterministic requirement↔inventory matching engine |
| `matchScorerTool.ts` | Mastra tool wrapper for matchScorer |
| `scoringConfig.ts` | Scoring weights (precision/recall modes), spec inflation config |
| `scoreJobsTool.ts` | Batch scoring orchestration |
| `mandateClassifier.ts` | Classifies JD against 10 weighted executive mandate archetypes |
| `hardFlagRules.ts` | Hard flag rule definitions (RuleCondition, gate: PASS/REVIEW/NO) |
| `hardFlagEngine.ts` | Hard flag rule evaluation engine |
| `qualityScorer.ts` | Post-generation quality metrics (truthfulness, mandate alignment, readability) |

### Resume & Cover Letter Generation
| File | Purpose |
|------|---------|
| `tailoredResumePrompt.ts` | TailoredResume Zod schema + system/user prompts |
| `tailoredCoverLetterPrompt.ts` | TailoredCoverLetter Zod schema + prompts |
| `generateResumeTool.ts` | LLM resume generation (gpt-4o, temp 0.3) |
| `generateCoverLetterTool.ts` | LLM cover letter generation (gpt-4o, temp 0.4) |
| `generateVerifiedPacketTool.ts` | Generate→Verify→Correct loop (up to 3 attempts) |
| `resumeCompressor.ts` | Enforces 2-page resume rules (bullet caps, word limits, filler removal) |
| `resumeDivergenceEnforcer.ts` | Ensures each resume differs from last 3 via `resume_history` table |
| `finalPolishLayer.ts` | 6-stage post-generation orchestrator (truth, mandate, tone, divergence, layout, quality) |

### Document Rendering & Validation
| File | Purpose |
|------|---------|
| `docxRenderer.ts` | DOCX template rendering (Calibri, fixed spacing) + PDF conversion via LibreOffice |
| `formattingValidator.ts` | Pre-PDF formatting checks (placeholders, sections, contacts, page limits) |
| `validateFormattingTool.ts` | Mastra tool wrapper for formattingValidator |
| `buildOutputTool.ts` | Output folder creation, file writing, DB persistence |

### Outreach & Engagement
| File | Purpose |
|------|---------|
| `contactDiscoveryTool.ts` | Web-search-based outreach target discovery |
| `linkedInMessageTool.ts` | Grounded LinkedIn message generation (<450 chars) |
| `dailyBriefTool.ts` | DailyBrief assembly (JSON + Questions for Ed) |
| `sendDigestTool.ts` | Digest email sending via Gmail API |

### Email & Job Fetching
| File | Purpose |
|------|---------|
| `fetchEmailsTool.ts` | Gmail email fetch + fixture fallback + imported_emails processing |
| `parseJobsTool.ts` | Job parsing + SimHash dedup + DB insert |
| `enrichJobsTool.ts` | LLM web search enrichment for thin JDs (Phase 2 fallback) |
| `urlScrapeEnricher.ts` | Deterministic URL scraping enrichment (Phase 1 — fast, free, no LLM) |
| `clayEnrichTool.ts` | Clay webhook integration |
| `apolloJobSearchTool.ts` | Apollo.io job search integration |

## Resume Engine (8-Stage + Post-Processing Pipeline)

The resume engine at `src/resume-engine/` is a deterministic-first pipeline with two architecture versions controlled by `PIPELINE_ARCH` env var.

### Pipeline Architecture Selection

| `PIPELINE_ARCH` | Implementation | Default |
|-----------------|----------------|---------|
| `v1` | Legacy pipeline (`pipeline-v1.ts`) — original 7-stage + Stage 8 repair loops | **Yes** |
| `v2` | Consolidated pipeline (`pipeline-v2.ts`) — budget enforcement, detection-only QA, no Stage 8 repair loops, transaction safety | No |

Set `PIPELINE_ARCH=v2` to enable the consolidated pipeline. The `dry_run: true` input flag validates contracts without LLM calls.

### Stage Contract Matrix

Each stage declares what it may and may not mutate, enforced by `stage-contracts.ts`:

| Stage | Name | Type | Allowed Mutations | Failure Mode |
|-------|------|------|-------------------|--------------|
| 0 | Identity Validation | **Deterministic** | `inventory`, `identity` | abort (MissingBaselineError) |
| 1 | Claims Ledger | **Deterministic** | `claims_ledger` | abort |
| 2 | Mandate Classifier | **LLM** | `mandate_profile` | abort |
| 3 | Bullet Scoring | **Deterministic** | `bullet_plan` | abort |
| 4 | Constrained Rewrite | **LLM** | `resume.full`, `cover_letter.full` | retry (max 3) |
| 5 | Differentiation Gate | **Deterministic** | `none` (detection-only) | degrade |
| 6 | Layout Governor | **Deterministic** | `resume.experience.bullets`, `resume.experience.order`, `resume.professional_summary`, `resume.core_competencies` | degrade |
| 7 | Truth Audit | **Deterministic** | `none` (detection-only) | degrade |
| 8 | Recruiter Review | **LLM** | `none` (feedback-only) | degrade |
| PP | Post-Processing | **Deterministic** | `none` (detection-only) | skip |

### Budget Enforcement (v2 only)

Configured via `pipeline-budget.ts`, overridable per-run:

| Limit | Default | Env Override |
|-------|---------|--------------|
| Max LLM calls | 12 | `PIPELINE_MAX_LLM_CALLS` |
| Max repair loops | 3 | `PIPELINE_MAX_REPAIR_LOOPS` |
| Max tokens | 500,000 | `PIPELINE_MAX_TOKENS` |
| Max cost (USD) | $2.00 | `PIPELINE_MAX_COST_USD` |
| Timeout | 600s | `PIPELINE_TIMEOUT_MS` |

Budget exceeded → `BudgetExceededError` with structured violation, graceful degradation to best-of-N.

### v2 Key Differences from v1

- **Detection-only QA passes**: Verb integrity, hype suppression, corruption detection produce flags but never mutate resume text.
- **No Stage 8 repair loops**: Recruiter Review runs once, produces structured feedback for human review only.
- **Consolidated Post-Processing**: 10 detection-only sub-passes replace scattered QA Gate + Refinement Layer. Returns composite score (A–F grade).
- **Transaction safety**: All finalize DB writes (snapshot + metadata + cost) go through a single `BEGIN/COMMIT/ROLLBACK` transaction.
- **Mandate-scoped differentiation**: Compares against resumes with the same primary mandate first, falling back to any recent resumes.
- **Global budget cap**: LLM calls, cost, tokens, and time are tracked and enforced across the entire pipeline run.

### Retry Architecture

- **v1**: Stages 4→5→6→7 repeat up to 3 times. Stage 8 runs repair loops. On stage 7 failure, stage 4 receives previous resume + violation report for correction.
- **v2**: Stages 4→5→6→7 repeat up to `min(max_attempts, max_repair_loops)` times. Stage 8 runs ONCE (no repair). Budget enforced between attempts.
- Both: Best-of-N selection if all attempts fail.

### Entry Points

- `pipeline.ts:runPipeline()` — Routes to v1/v2/dry-run based on `PIPELINE_ARCH` and `dry_run` flag
- `auto-generate.ts:autoGeneratePackets()` — Batch generation for top-N scored jobs (default: score ≥ 60, top 20)
- Dry-run: `runPipeline({ job_id: 0, dry_run: true, logger: console })` — validates contracts using fixtures

## Data Flow

**Daily automated run** (dual cron: 12:30 UTC + 00:00 UTC, or manual trigger via dashboard):

1. **Fetch**: Pull emails from Gmail label "Job Alerts" (or fixtures if `USE_FIXTURES=true`), process `imported_emails` table, track in `processed_gmail_ids` table to avoid re-processing
2. **Parse**: Agent extracts individual job listings → `jobs` table (SimHash dedup on `jd_hash`, audit trail in `dedup_log`)
3. **Enrich**: 2-phase enrichment for jobs missing JD text — Phase 1: deterministic URL scraping via `urlScrapeEnricher` (fast, free, no LLM); Phase 2: LLM web search via agent for remaining jobs (batches of 3, maxSteps 15, 2s inter-batch delay). Optionally sends to Clay; Apollo.io job search available
4. **Score**: Each job scored against `experience_inventory.json` using deterministic `matchScorer` — weighted categories: must_have (35), tech_keywords (25), nice_to_have (15), leadership_scope (15), domain_context (10). Results → `scores` table
5. **Shortlist**: Top 10 by score proceed to packet generation
6. **Generate**: For each shortlisted job:
   - Extract FactRegistry + ClaimsLedger from inventory
   - Build EntityAllowlist
   - Classify mandate (10 archetypes)
   - LLM generates `TailoredResume` + `TailoredCoverLetter` JSON (gpt-4o, structured output)
   - 6-layer truthfulness verification runs
   - If violations found: correction prompt with specific fixes → retry (up to 3x)
   - Best attempt selected (fewest critical violations)
   - Divergence check against last 3 resumes
   - Layout governor enforces formatting rules
   - DOCX rendered → PDF converted via LibreOffice → pagination checked
   - All artifacts written to `output/` and `artifacts` table (including BYTEA blobs for Railway persistence)
7. **Digest**: HTML email sent with ranked results, file paths, outreach targets, questions

## Key Design Decisions

- **Candidate Identity Locking**: Every pipeline run is bound to a single verified candidate via `CandidateIdentity` (candidate_id, candidate_name, inventory_hash, source). Stage 0 validates identity before any generation. Output guards verify the resume's employers match the claims ledger and the cover letter signature matches the candidate name. `MissingBaselineError` throws hard on missing inventory — no fallback to test fixtures or stub objects. All 11 duplicate `loadInventory()` functions now delegate to the centralized `inventory-loader.ts`. The `resume_history` table is scoped by `candidate_id` to prevent cross-candidate divergence comparisons.
- **Zero-fabrication architecture**: FactRegistry + EntityAllowlist + ClaimsLedger + 6-layer verifier ensures no hallucinated content. Every bullet requires `source_hash` + `evidence_quote` + `claim_ids[]` traceable to inventory.
- **Deterministic scoring**: `matchScorer.ts` uses token overlap, phrase matching, and tech keyword lookup — no LLM in the scoring loop. Reproducible results.
- **Structured output**: All LLM calls use `generateObject` with Zod schemas (not free-form text). Schema constraints enforce structure.
- **Generate→Verify→Correct loop**: Truthfulness is enforced iteratively. Violations get fed back as correction prompts with lower temperature (0.2).
- **Best-of-N strategy**: If all attempts fail verification, the attempt with fewest critical violations is returned with `human_review_required: true`.
- **DOCX-first rendering**: Deterministic template (Calibri, fixed spacing/margins) ensures consistent output. PDF is a conversion artifact, not the primary format.
- **Resilient storage**: `ResilientPostgresStore` retries connection 8 times with 5s delay for Railway cold starts.
- **Workspace root detection**: `paths.ts` handles the fact that Mastra's bundler runs from `.mastra/output/`, not project root.
- **Single agent/workflow constraint**: Runtime checks enforce exactly 1 agent and 1 workflow. This is an intentional UI limitation.
- **Role Shape classification**: Jobs are classified into 4 shapes (Strategy-Led, Hybrid, Analytics/BI, Engineering/IC) based on JD signal counting. Used for scoring alignment.
- **Spec Inflation Penalty**: Detects JDs heavy on advanced AI buzzwords but light on business outcomes — penalizes likely "unicorn" postings.
- **Mandate classification**: JDs classified against 10 weighted executive mandate archetypes to drive summary/bullet reordering and tone.
- **Resume divergence enforcement**: Each generated resume compared against last 3 via `resume_history` table. Prevents formulaic repetition across applications.
- **Ownership inflation detection**: 3 escalation patterns (contributor→owner, team→sole, helper→transformer) flagged during truth audit.
- **Conditional Inngest**: Falls back to in-process cron scheduler if Inngest keys not configured. Enables local dev without Inngest.
- **Settings persistence**: Dual source — database `app_settings` table (primary) with environment variable fallback.
- **Claim ID linkage**: 4-strategy matching (direct ID, substring, reverse substring, source span overlap) links every resume bullet to its source claim.
- **2-phase JD enrichment**: Phase 1 tries deterministic URL scraping (fast, free, 10s timeout per URL). Phase 2 uses LLM agent web search for remaining jobs (batches of 3, maxSteps 15, 2s inter-batch delay to avoid rate limiting). Runs as fire-and-forget background task with outer try/catch to prevent silent death.
- **Background enrichment resilience**: The enrichment IIFE is wrapped in outer try/catch so individual batch failures don't kill the entire process. Frontend polls every 15s for up to 30 minutes.
- **Pipeline feature flag**: `PIPELINE_ARCH=v1|v2` routes to different implementations via dynamic import. v1 is preserved exactly from the legacy codebase; v2 adds budget enforcement, detection-only QA, and transaction safety. Default is v1 for safe rollout.
- **Stage Contract Matrix**: Each pipeline stage declares `allowed_mutations`, `forbidden_mutations`, `failure_mode`, and `max_attempts`. Enforced at runtime via `validateStageContract()` and validated in dry-run mode.
- **Detection-only post-processing**: v2's Post-Processing Controller consolidates 10 sub-passes (corruption, verb integrity, hype, phrase quality, mandate alignment, differentiation, layout, exec depth, ownership inflation, cover letter QA) into a single detection-only pass that never mutates input.
- **Budget enforcement**: v2 pipeline tracks LLM calls, repair loops, tokens, cost, and elapsed time. `BudgetExceededError` triggers graceful degradation to best-of-N rather than hard failure.
- **Transaction safety (v2)**: Finalize DB writes (resume snapshot, pipeline metadata, cost flush) wrapped in `BEGIN/COMMIT/ROLLBACK` via `pipeline-transaction.ts`. On failure, all writes roll back atomically.
- **Mandate-scoped divergence**: Differentiation gate and divergence enforcer prioritize comparison against resumes with the same primary mandate cluster. Falls back to any recent resumes when insufficient same-mandate history exists.
- **Dry-run mode**: `runPipeline({ dry_run: true })` validates stage contracts, budget enforcement, and post-processing immutability using fixture data — no LLM calls or DB writes required.

## Database Schema

All tables created in `src/mastra/tools/db.ts:initDatabase()` + `settingsRoutes.ts`. No migrations — idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`. All `job_id` columns use BIGINT.

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `runs` | Workflow execution tracking | `run_id` (TEXT PK), `status`, `start_ts`, `end_ts`, `errors_json` (JSONB) |
| `jobs` | Ingested job listings | `job_id` (BIGSERIAL PK), `source`, `source_message_id`, `company`, `title`, `location`, `remote_hybrid`, `level`, `posting_url`, `date_posted`, `date_ingested`, `jd_raw_text`, `jd_hash` (unique index), `simhash`, `keywords` (JSONB), `url_canonical`, `jd_requirements` (JSONB), `status`, `compensation`, `user_action` |
| `scores` | Match scores per job | `job_id` (BIGINT PK, FK→jobs), `total_score` (REAL), `breakdown_json` (JSONB), `match_report` (JSONB) |
| `artifacts` | Generated document paths + blobs | `id` (SERIAL PK), `job_id` (BIGINT FK→jobs), `resume_docx_path`, `cover_docx_path`, `evidence_map_path`, `verifier_json_path`, `truth_pass` (BOOLEAN), `prompt_version`, `model_used`, `created_ts`, `resume_docx` (BYTEA), `cover_docx` (BYTEA), `evidence_map_json` (TEXT), `verifier_json` (TEXT) |
| `evidence_map` | Claim-to-source mappings | `id` (SERIAL PK), `job_id` (BIGINT FK→jobs), `claim_id`, `claim_text`, `evidence_quote`, `evidence_source_key`, `confidence` (REAL) |
| `contacts` | Outreach targets per job | `id` (SERIAL PK), `job_id` (BIGINT FK→jobs), `person_name`, `title`, `linkedin_url`, `email`, `rank` (INTEGER), `rationale`, `message_draft` |
| `profile_sessions` | Profile builder sessions | `session_id` (TEXT PK), `status`, `raw_resume_text`, `resume_filename`, `resume_format`, `target_role`, `interview_focus`, `current_draft` (JSONB), `gaps` (JSONB), `qa_history` (JSONB), `interview_round` (INTEGER), `created_at`, `updated_at`, `finalized_at` |
| `imported_emails` | Manually imported email bodies | `id` (SERIAL PK), `subject`, `from_address`, `date_received`, `body`, `processed` (BOOLEAN), `created_at` |
| `digests` | Daily digest send records | `digest_id` (SERIAL PK), `run_date` (DATE), `jobs_fetched`, `jobs_scored`, `jobs_shortlisted`, `packets_generated`, `truth_pass_count`, `truth_fail_count`, `email_sent` (BOOLEAN), `sent_at`, `recipient_email` |
| `resume_history` | Prior resume snapshots for divergence tracking | `id` (SERIAL PK), `job_id` (BIGINT FK→jobs), `target_company`, `target_role`, `summary_text`, `competencies` (JSONB), `top_bullets_by_role` (JSONB), `archetype_primary`, `key_phrases` (JSONB), `created_at` |
| `processed_gmail_ids` | Gmail message dedup tracking | `gmail_id` (TEXT PK), `processed_at`, `jobs_found` (INTEGER) |
| `dedup_log` | Deduplication audit trail | `id` (SERIAL PK), `company`, `title`, `location`, `posting_url`, `reason`, `matched_job_id` (BIGINT), `created_at` |
| `app_settings` | Configuration key-value store | `key` (TEXT PK), `value` (TEXT), `updated_at` (TIMESTAMPTZ) |

**pgvector**: Not installed or used. Vector references in code are JD keyword matching terms, not database extensions.

## API Routes

### Dashboard (`dashboardRoutes.ts`)
- `GET /dashboard` — Serves dashboard HTML (redirects to /setup if not configured)
- `GET /api/dashboard` — Dashboard stats (total jobs, scored, packets, recent runs)
- `GET /api/dashboard/jobs` — Paginated job list (500 per page)
- `GET /api/dashboard/jobs/:id` — Job detail + scores + artifacts + contacts + evidence
- `GET /api/dashboard/runs` — Last 20 runs
- `POST /api/dashboard/trigger` — Fire-and-forget workflow trigger
- `POST /api/dashboard/jobs/:id/action` — Set job user_action (applied/deleted/null)
- `GET /api/dashboard/preview/:jobId/:type` — Preview resume/cover/evidence/verifier
- `GET /api/dashboard/download/:jobId/:type` — Download DOCX/PDF
- `GET /api/dashboard/download/:jobId/:type/pdf` — Download as PDF (LibreOffice conversion)
- `POST /api/dashboard/generate-packet/:jobId` — Async single-job packet generation
- `GET /api/dashboard/generate-packet/:jobId/status` — Check single-job generation status
- `GET /api/dashboard/generation-log` — Last 100 generation log entries
- `POST /api/dashboard/purge-stale-artifacts` — Remove artifacts for jobs with no JD
- `POST /api/dashboard/purge-all-packets` — Delete all artifacts and reset scores
- `POST /api/dashboard/rescore` — Re-score all jobs with JD text
- `POST /api/dashboard/auto-generate-packets` — Batch packet generation (top-N by score)
- `POST /api/dashboard/quick-add` — Quick-add a job by URL or manual entry
- `GET /api/dashboard/needs-enrichment` — List jobs missing JD text
- `POST /api/dashboard/enrich-jobs` — 2-phase enrichment (URL scrape → LLM web search)
- `POST /api/dashboard/enrich-urls` — URL-only scrape enrichment (no LLM)
- `PUT /api/dashboard/jobs/:id/jd` — Manually set JD text for a job
- `GET /api/dashboard/dedup-log` — View deduplication audit trail
- `POST /api/dashboard/import-excel` — Import jobs from Excel/CSV upload

### Profile Builder (`profileBuilderRoutes.ts`)
- `GET /profile` — Serves profile builder HTML
- `GET /api/profile/debug-paths` — Debug workspace path resolution
- `POST /api/profile/upload` — Resume upload + background parsing (DOCX, PDF, TXT; 10MB max)
- `GET /api/profile/session/:id` — Session status + draft inventory
- `POST /api/profile/interview/:id` — Generate interview questions (max 4 rounds, focus: leadership/technical/growth)
- `POST /api/profile/skip-interview/:id` — Skip interview and finalize with current draft
- `POST /api/profile/finalize/:id` — Finalize session and export inventory
- `GET /api/profile/current` — Get most recent active session
- `DELETE /api/profile/session/:id` — Delete a profile session
- `GET /api/profile/recent` — List recent profile sessions

### Job Sources (`jobSourceRoutes.ts`)
- `POST /api/sources/apollo/search` — Manual Apollo.io job search
- `POST /api/sources/clay/webhook` — Receive Clay enriched leads
- `GET /api/sources/status` — Integration status dashboard
- `POST /api/sources/email/scan` — Scan Gmail for job alert emails

### Settings (`settingsRoutes.ts`)
- `GET /api/settings` — All settings (secrets masked)
- `GET /api/settings/list` — List all setting definitions with groups
- `POST /api/settings` — Update settings (persisted to DB)

### Setup Wizard (`setupRoutes.ts`)
- `GET /setup` — Serves setup wizard HTML
- `GET /api/setup/status` — Setup progress (database, OpenAI, Gmail)
- `POST /api/setup/save` — Save setting from setup wizard (allowlist enforced)
- `POST /api/setup/gmail/auth-url` — Generate Google OAuth URL
- `POST /api/setup/gmail/exchange-code` — Exchange auth code for refresh token
- `POST /api/setup/gmail/test` — Test Gmail connection with current credentials

### Core (`index.ts`)
- `GET /` — Root redirect (→ /dashboard or /setup)
- `GET /api/health` — Health check endpoint
- `POST /api/import-emails` — Import email bodies (auth via `IMPORT_API_KEY`)
- `GET /api/import-emails` — List imported emails

## Environment Variables

**Required:**
- `DATABASE_URL` — PostgreSQL connection string
- `OPENAI_API_KEY` — OpenAI API key (gpt-4o); aliased to `AI_INTEGRATIONS_OPENAI_API_KEY` at startup

**Optional (Inngest):**
- `INNGEST_EVENT_KEY` — Inngest event key (if omitted, uses in-process scheduler)
- `INNGEST_SIGNING_KEY` — Inngest signing key

**Optional (Gmail):**
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — Gmail OAuth2
- `GMAIL_LABEL` — Gmail label to fetch from (default: "Job Alerts")
- `DIGEST_EMAIL` — Recipient for daily digest

**Optional (Scheduling):**
- `SCHEDULE_CRON_EXPRESSION` — Primary cron schedule (default: `30 12 * * *` / 12:30 UTC)
- `SCHEDULE_CRON_EXPRESSION_2` — Secondary cron schedule (default: `0 0 * * *` / 00:00 UTC)

**Optional (Integrations):**
- `CLAY_WEBHOOK_URL` — Clay enrichment webhook
- `CLAY_INBOUND_SECRET` — Clay inbound webhook auth
- `APOLLO_API_KEY` — Apollo.io job/people search

**Optional (Infrastructure):**
- `IMPORT_API_KEY` — Auth key for `/api/import-emails` endpoint
- `PUBLIC_URL` — Production URL for Inngest webhook registration (falls back to `RAILWAY_PUBLIC_DOMAIN` → `RENDER_EXTERNAL_URL`)
- `WORKSPACE_ROOT` — Override project root (default: auto-detected)
- `USE_FIXTURES` — Use fixture emails instead of Gmail (default: false)
- `SCORING_MODE` — `precision` (strict) or `recall` (wider net)
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — Override OpenAI base URL (e.g., Azure)
- `PORT` — HTTP server port (default: 5000)
- `NODE_ENV` — `production` or `development`
- `USER_EMAIL` — Fallback email if `DIGEST_EMAIL` not set

**Optional (Debug / Feature Flags):**
- `DEBUG_GENERATION` — Enable verbose logging during packet generation
- `USE_LEGACY_PIPELINE` — Use legacy agent-driven pipeline instead of resume engine (default: false)
- `AUTO_GENERATE_AFTER_SCORE` — Auto-generate packets after scoring (default: true)
- `PIPELINE_ARCH` — Resume engine architecture: `v1` (legacy, default) or `v2` (consolidated with budget enforcement)
- `PIPELINE_MAX_LLM_CALLS` — v2 budget: max LLM calls per pipeline run (default: 12)
- `PIPELINE_MAX_REPAIR_LOOPS` — v2 budget: max repair loop iterations (default: 3)
- `PIPELINE_MAX_TOKENS` — v2 budget: max tokens per pipeline run (default: 500000)
- `PIPELINE_MAX_COST_USD` — v2 budget: max cost in USD per pipeline run (default: 2.00)
- `PIPELINE_TIMEOUT_MS` — v2 budget: pipeline timeout in milliseconds (default: 600000)

**Optional (Messaging):**
- `TELEGRAM_BOT_TOKEN` — Telegram bot token for workflow triggers

## Known Issues / TODOs

1. **PDF page counting fragility**: `countPdfPages()` uses regex on PDF binary (`/Type /Page` pattern). Can miscount on some PDF structures.
2. **No transaction safety (v1 only)**: v1 pipeline uses individual queries, not transactions. v2 pipeline wraps finalize DB writes in a single transaction (`pipeline-transaction.ts`).
3. **Dashboard trigger is fire-and-forget**: `POST /api/dashboard/trigger` starts the workflow but returns immediately with no run tracking handle.
4. **LibreOffice dependency**: PDF conversion requires LibreOffice headless. Works in Docker but not in all local dev environments.
5. **Cover letter word count**: Schema enforces 300-400 words but the LLM sometimes drifts. The verifier catches this but correction doesn't always converge.
6. **~~Duplicate `loadInventory()`~~**: RESOLVED — All 11 duplicate `loadInventory()` functions now delegate to the centralized `inventory-loader.ts`. Silent stub fallbacks (returning `{ profile: { name: "Candidate" } }`) have been eliminated. All paths throw `MissingBaselineError` on failure.
7. **Dual verification tools**: Both `verifyTruthTool.ts` and `verifyTruthfulnessTool.ts` exist with overlapping purpose. Should be consolidated.
8. **Enrichment is fire-and-forget**: Background enrichment has no persistent progress tracking. If the server restarts mid-enrichment, partially processed batches are lost. A DB-based job queue would be more resilient.

## Conventions

**Naming:**
- Tools: `camelCaseTool` (e.g., `generateVerifiedPacketTool`), tool IDs use kebab-case (`generate-verified-packet`)
- Schemas: `PascalCaseSchema` (e.g., `TailoredResumeSchema`)
- Files: `camelCase.ts` for tools, `camelCaseRoutes.ts` for route modules
- Resume engine stages: `stageN-kebab-name/` directories

**Error handling:**
- Tools throw on fatal errors, log warnings on non-fatal
- `NonRetriableError` from Inngest used for validation/schema errors
- Generate→Verify→Correct loop catches per-attempt errors and continues to next attempt
- DB operations wrapped in try/catch with logger.error — failures don't crash the pipeline
- LLM calls use retry with exponential backoff (2s → 8s, 2 attempts on rate-limit/schema failure)

**Logging:**
- `ProductionPinoLogger` (extends Mastra logger) for structured JSON logging in production
- `PinoLogger` for development
- Pattern: `[toolName] Step description` with emoji indicators
- Log levels: info for normal flow, warn for degraded, error for failures

**Testing:**
- Vitest v4 for unit tests (`tests/*.test.ts`)
- 26 test files covering: scoring, truth verification, formatting validation, role classification, entity allowlist, claims ledger, mandate classification, resume engine E2E, DOCX rendering, digest email, contact discovery, LinkedIn messages, profile builder, tailored prompts, URL scrape enrichment
- Run: `npm test` (vitest run) or `npm run test:watch` (vitest watch mode)
- Legacy runner: `npm run test:legacy` (tsx direct execution for specific tests)
- Test timeout: 30s (configured in `vitest.config.ts`)

**Output structure:**
- `output/YYYY-MM-DD/Company_Name/Role_Title/` per job
- Files: `Resume_*.docx`, `CoverLetter_*.docx`, `EvidenceMap_*.json`, `Verifier_*.json`, `Job_*.json`
- Download filenames: "Ed Dobbles Resume - {Company}.docx"

**Build & Deploy:**
- `npm run build` → Mastra bundles to `.mastra/output/index.mjs` (4GB max-old-space-size)
- `npm run dev` → `mastra dev` for local development
- `npm run check` → `tsc` type checking
- `npm run check:format` → Prettier format check (CI-friendly, no writes)
- `npm run format` → Prettier formatting
- Railway: Dockerfile builds on `node:22-slim` + LibreOffice + Poppler, deploys `node /app/.mastra/output/index.mjs`
- Production URL: `https://job-hunt-production-f825.up.railway.app`
- Local Docker: `docker-compose.yml` with PostgreSQL 16 + app services

**CI/CD:**
- `.github/workflows/auto-merge-claude.yml` — Auto-merges `claude/**` branches to main on push
