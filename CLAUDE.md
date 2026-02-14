# CLAUDE.md — Job Match Automation System

## Project Overview

Automated job application pipeline that fetches job alerts from Gmail/imported emails, scores them against a structured experience inventory, and generates truthful, ATS-optimized application packets (resume, cover letter, evidence map). The system enforces a zero-fabrication policy through a 6-layer deterministic verification engine backed by a FactRegistry and EntityAllowlist. Every claim in generated documents must trace to a source bullet in `experience_inventory.json`. Deployed on Railway, orchestrated by Inngest, served by Mastra framework on Hono.

## Tech Stack

- **Runtime**: Node.js 22 (ES2022 modules)
- **Framework**: [Mastra](https://mastra.ai) v0.20 (Hono-based server, tool/agent/workflow primitives)
- **Orchestration**: Inngest v3.40 (step functions, cron triggers, retries)
- **Database**: PostgreSQL (Neon in production) via `pg` driver — raw SQL, no ORM
- **LLM**: OpenAI gpt-4o via `@ai-sdk/openai` + Vercel AI SDK (`generateObject`)
- **Document Generation**: `docx` library (DOCX) + LibreOffice headless (PDF conversion)
- **Email**: Gmail API via `googleapis` (OAuth2 refresh token flow)
- **Enrichment**: Clay webhooks (optional), OpenAI web search tool
- **Testing**: Vitest
- **Deployment**: Railway (Dockerfile, `node:22-slim` + LibreOffice)
- **Language**: TypeScript (strict mode, bundler module resolution)

## Architecture

```
Gmail / Import API
       │
       ▼
┌─────────────────────────────────────────────────┐
│  Mastra Server (Hono, port 5000)                │
│  ┌───────────┐  ┌────────────┐  ┌────────────┐ │
│  │ Dashboard  │  │ Profile    │  │ Settings   │ │
│  │ Routes     │  │ Builder    │  │ Routes     │ │
│  └───────────┘  └────────────┘  └────────────┘ │
│           │                                      │
│           ▼                                      │
│  ┌─────────────────────────────────────────┐    │
│  │  Inngest (workflow orchestration)        │    │
│  │  jobMatchWorkflow: 5 sequential steps    │    │
│  │  1. Fetch & parse emails                 │    │
│  │  2. Enrich via web search + Clay         │    │
│  │  3. Score & shortlist (top 10)            │    │
│  │  4. Generate packets (per job)           │    │
│  │  5. Send daily digest email              │    │
│  └─────────────────────────────────────────┘    │
│           │                                      │
│           ▼                                      │
│  ┌─────────────────────────────────────────┐    │
│  │  Tool Layer (17 tools)                   │    │
│  │  Extract → Tailor → Verify → Render      │    │
│  └─────────────────────────────────────────┘    │
│           │                                      │
│           ▼                                      │
│  PostgreSQL (Neon)     output/ filesystem        │
└─────────────────────────────────────────────────┘
```

The server runs as a single Mastra instance with one agent (`jobMatchAgent`) and one workflow (`jobMatchWorkflow`). The codebase enforces a hard limit of 1 agent and 1 workflow — runtime checks throw if more are registered.

## File Structure

```
src/mastra/
├── index.ts                    # Mastra app entrypoint, server config, API routes, middleware
├── agents/
│   └── jobMatchAgent.ts        # Single agent with 17 tools, system prompt, gpt-4o
├── workflows/
│   └── jobMatchWorkflow.ts     # 5-step Inngest workflow + runWorkflowDirectly()
├── inngest/
│   ├── client.ts               # Inngest client initialization
│   └── index.ts                # Inngest serve config, cron registration, API route forwarding
├── storage/
│   └── index.ts                # ResilientPostgresStore with retry logic for Railway startup
├── tools/
│   ├── db.ts                   # PostgreSQL pool, initDatabase() with all CREATE TABLE statements
│   ├── paths.ts                # WORKSPACE_ROOT detection (handles .mastra/output bundle path)
│   ├── profileSchemas.ts       # Zod schemas for ExperienceInventory, Bullet, Experience, etc.
│   ├── factRegistry.ts         # FactAtom extraction from inventory (truth source index)
│   ├── entityAllowlist.ts      # EntityAllowlist + EntityDenylist + placeholder scanner
│   ├── roleShapeClassifier.ts  # JD → Shape A/B/C/D classifier (strategy/engineering/analytics/IC)
│   ├── extractJDRequirementsTool.ts  # LLM-based JD decomposition (must_have, nice_to_have, etc.)
│   ├── matchScorer.ts          # Deterministic requirement↔inventory matching engine
│   ├── scoringConfig.ts        # Scoring weights (precision/recall modes), spec inflation config
│   ├── hardFlagRules.ts        # Hard flag rule engine (gate: PASS/REVIEW/NO)
│   ├── tailoredResumePrompt.ts       # TailoredResume schema + system/user prompts (8 absolute rules)
│   ├── tailoredCoverLetterPrompt.ts  # TailoredCoverLetter schema + prompts
│   ├── generateResumeTool.ts         # LLM resume generation (gpt-4o, temp 0.3)
│   ├── generateCoverLetterTool.ts    # LLM cover letter generation (gpt-4o, temp 0.4)
│   ├── generateVerifiedPacketTool.ts # Generate→Verify→Correct loop (up to 3 attempts)
│   ├── truthfulnessVerifier.ts       # 6-layer deterministic verifier (entities, metrics, dates, etc.)
│   ├── verifyTruthTool.ts            # LLM-assisted truth verification (5-layer)
│   ├── docxRenderer.ts               # DOCX template rendering + PDF conversion + pagination check
│   ├── formattingValidator.ts        # Pre-PDF formatting checks (placeholders, sections, contacts)
│   ├── buildOutputTool.ts            # Output folder creation, file writing, DB persistence
│   ├── contactDiscoveryTool.ts       # Web-search-based outreach target discovery
│   ├── linkedInMessageTool.ts        # Grounded LinkedIn message generation (<450 chars)
│   ├── dailyBriefTool.ts             # DailyBrief assembly (JSON + Questions for Ed)
│   ├── fetchEmailsTool.ts            # Gmail email fetch tool
│   ├── parseJobsTool.ts              # Job parsing + SimHash dedup + DB insert
│   ├── scoreJobsTool.ts              # Batch scoring orchestration
│   ├── enrichJobsTool.ts             # Web search enrichment for thin JDs
│   ├── clayEnrichTool.ts             # Clay webhook integration
│   ├── gmailClient.ts               # Gmail API client (OAuth2)
│   └── sendDigestTool.ts            # Digest email sending
├── dashboardRoutes.ts          # Dashboard API (jobs list, detail, preview, download, trigger)
├── profileBuilderRoutes.ts     # Profile builder API (resume upload, interview, export)
├── jobSourceRoutes.ts          # Job source management API
├── settingsRoutes.ts           # Settings API
└── public/
    ├── index.html              # Dashboard UI
    ├── profile.html            # Profile builder UI
    └── settings.html           # Settings UI

experience_inventory.json       # Single source of truth for all candidate facts
output/YYYY-MM-DD/Company/Role/ # Generated artifacts (DOCX, PDF, JSON)
fixtures/emails/                # Test email fixtures
tests/                          # Vitest test files
```

## Data Flow

**Daily automated run** (cron or manual trigger via dashboard):

1. **Fetch**: Pull emails from Gmail label "Job Alerts" (or fixtures if `USE_FIXTURES=true`), also process `imported_emails` table
2. **Parse**: Agent extracts individual job listings → `jobs` table (SimHash dedup on `jd_hash`)
3. **Enrich**: Web search fills in full JD text for thin listings; optionally sends to Clay
4. **Score**: Each job scored against `experience_inventory.json` using deterministic `matchScorer` — weighted categories: must_have (35), tech_keywords (25), nice_to_have (15), leadership_scope (15), domain_context (10). Results → `scores` table
5. **Shortlist**: Top 10 by score proceed to packet generation
6. **Generate**: For each shortlisted job:
   - Extract FactRegistry from inventory
   - Build EntityAllowlist
   - LLM generates `TailoredResume` + `TailoredCoverLetter` JSON (gpt-4o, structured output)
   - 6-layer truthfulness verification runs
   - If violations found: correction prompt with specific fixes → retry (up to 3x)
   - Best attempt selected (fewest critical violations)
   - DOCX rendered → PDF converted via LibreOffice → pagination checked
   - All artifacts written to `output/` and `artifacts` table
7. **Digest**: HTML email sent with ranked results, file paths, outreach targets, questions

## Key Design Decisions

- **Zero-fabrication architecture**: FactRegistry + EntityAllowlist + 6-layer verifier ensures no hallucinated content. Every bullet requires `source_hash` + `evidence_quote` traceable to inventory.
- **Deterministic scoring**: `matchScorer.ts` uses token overlap, phrase matching, and tech keyword lookup — no LLM in the scoring loop. Reproducible results.
- **Structured output**: All LLM calls use `generateObject` with Zod schemas (not free-form text). Schema constraints enforce structure.
- **Generate→Verify→Correct loop**: Truthfulness is enforced iteratively. Violations get fed back as correction prompts with lower temperature (0.2).
- **Best-of-N strategy**: If all attempts fail verification, the attempt with fewest critical violations is returned with `human_review_required: true`.
- **DOCX-first rendering**: Deterministic template (Calibri, fixed spacing/margins) ensures consistent output. PDF is a conversion artifact, not the primary format.
- **Resilient storage**: `ResilientPostgresStore` retries connection 5 times with 3s delay for Railway cold starts.
- **Workspace root detection**: `paths.ts` handles the fact that Mastra's bundler runs from `.mastra/output/`, not project root.
- **Single agent/workflow constraint**: Runtime checks enforce exactly 1 agent and 1 workflow. This is an intentional UI limitation.
- **Role Shape classification**: Jobs are classified into 4 shapes (Strategy-Led, Hybrid, Analytics/BI, Engineering/IC) based on JD signal counting. Used for scoring alignment.
- **Spec Inflation Penalty**: Detects JDs heavy on advanced AI buzzwords but light on business outcomes — penalizes likely "unicorn" postings.

## Database Schema

All tables created in `src/mastra/tools/db.ts:initDatabase()`. No migrations — idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`.

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `runs` | Workflow execution tracking | `run_id` (PK), `status`, `start_ts`, `end_ts` |
| `jobs` | Ingested job listings | `job_id` (serial PK), `company`, `title`, `jd_raw_text`, `jd_hash` (unique), `simhash`, `level`, `jd_requirements` (JSONB), `status`, `user_action`, `compensation` |
| `scores` | Match scores per job | `job_id` (PK, FK→jobs), `total_score`, `breakdown_json` (JSONB), `match_report` (JSONB) |
| `artifacts` | Generated document paths | `id` (serial PK), `job_id` (FK→jobs), `resume_docx_path`, `cover_docx_path`, `evidence_map_path`, `verifier_json_path`, `truth_pass`, `prompt_version`, `model_used` |
| `evidence_map` | Claim-to-source mappings | `id` (serial PK), `job_id` (FK→jobs), `claim_id`, `claim_text`, `evidence_quote`, `evidence_source_key`, `confidence` |
| `contacts` | Outreach targets per job | `id` (serial PK), `job_id` (FK→jobs), `person_name`, `title`, `linkedin_url`, `email`, `rank`, `rationale`, `message_draft` |
| `profile_sessions` | Profile builder sessions | `session_id` (PK), `status`, `current_draft` (JSONB), `gaps` (JSONB), `qa_history` (JSONB) |
| `imported_emails` | Manually imported email bodies | `id` (serial PK), `subject`, `body`, `processed` |
| `digests` | Daily digest send records | `digest_id` (serial PK), `run_date`, `jobs_fetched`, `email_sent` |

**pgvector**: Not installed or used. Vector references in code are JD keyword matching terms, not database extensions.

## Environment Variables

**Required:**
- `DATABASE_URL` — PostgreSQL connection string
- `OPENAI_API_KEY` — OpenAI API key (gpt-4o)
- `INNGEST_EVENT_KEY` — Inngest event key
- `INNGEST_SIGNING_KEY` — Inngest signing key

**Required for email features:**
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — Gmail OAuth2
- `GMAIL_LABEL` — Gmail label to fetch from (default: "Job Alerts")
- `DIGEST_EMAIL` — Recipient for daily digest

**Optional:**
- `IMPORT_API_KEY` — Auth key for `/api/import-emails` endpoint
- `PUBLIC_URL` — Production URL for Inngest webhook registration
- `SCHEDULE_CRON_EXPRESSION` — Cron schedule (default: `30 12 * * *`)
- `WORKSPACE_ROOT` — Override project root (default: auto-detected)
- `USE_FIXTURES` — Use fixture emails instead of Gmail (default: false)
- `SCORING_MODE` — `precision` (strict) or `recall` (wider net)
- `CLAY_WEBHOOK_URL` — Clay enrichment webhook
- `CLAY_INBOUND_SECRET` — Clay inbound webhook auth
- `APOLLO_API_KEY` — Apollo.io people search
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — Override OpenAI base URL
- `AI_INTEGRATIONS_OPENAI_API_KEY` — Override OpenAI API key (used by Mastra integration layer)

## Known Issues / TODOs

1. **No Layout Governor**: Resume page estimation is post-hoc only. The system checks page count after DOCX→PDF conversion but has no pre-generation content sizing. Resumes collapsing to 1 page for senior roles is an active problem.
2. **No automatic content trimming**: If resume exceeds 2 pages, the pipeline flags it but does not trim. Human intervention required.
3. **LLM-driven bullet selection**: No algorithmic bullet scoring or ranking. The LLM picks which bullets to include, with only schema constraints (1-5 roles, 1-6 bullets per role) as guardrails.
4. **PDF page counting fragility**: `countPdfPages()` uses regex on PDF binary (`/Type /Page` pattern). Can miscount on some PDF structures.
5. **No transaction safety**: DB operations use individual queries, not transactions. A failure mid-packet-generation can leave partial state.
6. **Dashboard trigger is fire-and-forget**: `POST /api/dashboard/trigger` starts the workflow but returns immediately with no run tracking handle.
7. **LibreOffice dependency**: PDF conversion requires LibreOffice headless. Works in Docker but not in all local dev environments.
8. **Cover letter word count**: Schema enforces 250-350 words but the LLM sometimes drifts. The verifier catches this but correction doesn't always converge.
9. **Duplicate `loadInventory()`**: Multiple files define their own `loadInventory()` function reading `experience_inventory.json`. Should be centralized.

## Conventions

**Naming:**
- Tools: `camelCaseTool` (e.g., `generateVerifiedPacketTool`), tool IDs use kebab-case (`generate-verified-packet`)
- Schemas: `PascalCaseSchema` (e.g., `TailoredResumeSchema`)
- Files: `camelCase.ts` for tools, `camelCaseRoutes.ts` for route modules

**Error handling:**
- Tools throw on fatal errors, log warnings on non-fatal
- `NonRetriableError` from Inngest used for validation/schema errors
- Generate→Verify→Correct loop catches per-attempt errors and continues to next attempt
- DB operations wrapped in try/catch with logger.error — failures don't crash the pipeline

**Logging:**
- Emoji-prefixed structured logging via Pino (production) or PinoLogger (dev)
- Pattern: `[toolName] Step description` with emoji indicators
- Log levels: info for normal flow, warn for degraded, error for failures

**Testing:**
- Vitest for unit tests (`tests/*.test.ts`)
- Tests cover: scoring, truth verification, formatting validation, role classification, entity allowlist
- Run: `npm test` (vitest) or `npm run test:legacy` (tsx direct execution)

**Output structure:**
- `output/YYYY-MM-DD/Company_Name/Role_Title/` per job
- Files: `Resume_*.docx`, `CoverLetter_*.docx`, `EvidenceMap_*.json`, `Verifier_*.json`, `Job_*.json`

**Build & Deploy:**
- `npm run build` → Mastra bundles to `.mastra/output/index.mjs`
- Railway: Dockerfile builds, deploys `node /app/.mastra/output/index.mjs`
- Production URL: `https://job-hunt-production-f825.up.railway.app`
