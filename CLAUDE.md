# CLAUDE.md — Asset-Manager (Job Match Automation)

## Project Overview

Automated job application system that fetches job alert emails (LinkedIn/Indeed), scores them against a professional experience inventory, generates tailored application packets (resume, cover letter, evidence map), and sends daily digest emails. Built on the Mastra AI workflow framework with a strict truthfulness guarantee — every claim in generated content must trace back to documented experience.

## Quick Reference

```bash
npm run dev            # Start Mastra dev server (port 5000)
npm run build          # Build with Mastra bundler (output: .mastra/output/)
npm run check          # TypeScript type checking (tsc)
npm run check:format   # Check formatting (Prettier)
npm run format         # Auto-format all .ts files (Prettier)
./scripts/inngest.sh   # Start Inngest dev server (port 3000)
```

**Testing:** Tests use vitest but `npm test` is not wired up. Run tests with:
```bash
npx vitest run                     # Run all tests
npx vitest run tests/<file>.test.ts  # Run specific test file
```

## Tech Stack

- **Framework:** Mastra v0.20 (AI workflow/agent framework)
- **Language:** TypeScript 5.9, ES2022 target, strict mode
- **Runtime:** Node.js >= 20.9
- **LLM:** OpenAI gpt-4o via `@ai-sdk/openai`
- **Workflow Orchestration:** Inngest (event-driven, cron-scheduled)
- **Database:** PostgreSQL 16 (local via docker-compose, Neon in production)
- **Document Generation:** `docx` (DOCX creation), `mammoth` (DOCX reading), LibreOffice (PDF conversion)
- **Validation:** Zod for all schemas
- **Logging:** Pino (structured JSON)
- **Deployment:** Docker, Railway.app, Replit

## Architecture

### Core Pipeline: Extract -> Tailor -> Verify -> Render

Every application packet follows this 4-phase sequence:

1. **Extract** — Build a FactRegistry from `experience_inventory.json` (the single source of truth)
2. **Tailor** — Generate resume/cover letter with mandatory evidence pointers back to inventory
3. **Verify** — Run 6-layer deterministic verification against FactRegistry
4. **Render** — Create DOCX files and persist artifacts to `/output/YYYY-MM-DD/Company/Role/`

### Workflow Steps (jobMatchWorkflow)

```
Step 1: fetch-and-parse-emails    -> Parse LinkedIn/Indeed alert emails
Step 2: enrich-jobs-web-search    -> Web search for full job descriptions, optional Clay enrichment
Step 3: score-and-shortlist       -> Deterministic scoring, select top 10
Step 4: generate-packets          -> Tailored resume + cover letter + verification per job
Step 5: send-digest               -> Email summary with results
```

### Directory Structure

```
src/mastra/
  index.ts                  # Mastra config, server (port 5000), API routes, middleware
  agents/
    jobMatchAgent.ts        # Primary AI agent (gpt-4o, 17+ tools, experience inventory context)
  workflows/
    jobMatchWorkflow.ts     # 5-step Inngest workflow
  tools/                    # ~37 specialized tools (one per file)
    db.ts                   # PostgreSQL schema init + query helper
    factRegistry.ts         # Fact extraction from experience inventory
    entityAllowlist.ts      # Allowlist/denylist for verification
    matchScorer.ts          # Deterministic scoring algorithm (no LLM)
    verifyTruthTool.ts      # 6-layer verification engine
    truthfulnessVerifier.ts # Fact checking logic
    generateResumeTool.ts   # LLM resume generation
    generateCoverLetterTool.ts
    generateVerifiedPacketTool.ts
    buildOutputTool.ts      # DOCX rendering + file organization
    docxRenderer.ts         # DOCX file creation
    enrichJobsTool.ts       # Web search enrichment
    fetchEmailsTool.ts      # Gmail API email fetching
    parseJobsTool.ts        # Email parsing + DB storage
    gmailClient.ts          # Gmail API client (OAuth)
    contactDiscoveryTool.ts # Public web search for outreach targets
    linkedInMessageTool.ts  # LinkedIn outreach message generation
    dailyBriefTool.ts       # Daily brief assembly
    digestEmailTemplate.ts  # HTML email template
    sendDigestTool.ts       # Email sending via Gmail
    scoringConfig.ts        # Scoring weights (precision/recall modes)
    paths.ts                # Workspace path resolution
    tailoredResumePrompt.ts
    tailoredCoverLetterPrompt.ts
    validateFormattingTool.ts
    clayEnrichTool.ts       # Clay webhook enrichment
    extractInventoryTool.ts
    extractJDRequirementsTool.ts
    scoreJobsTool.ts
    matchScorerTool.ts
  inngest/
    client.ts               # Inngest client config
    index.ts
  storage/
    index.ts                # PostgreSQL storage for Mastra
src/triggers/
  cronTriggers.ts           # Cron-based workflow scheduling
tests/                      # 22 vitest test files
fixtures/emails/            # Sample job alert emails for testing
output/                     # Generated application packets (date-organized)
scripts/
  build.sh                  # Build wrapper (memory config)
  inngest.sh                # Inngest dev server startup
  gmail-apps-script.js      # Google Apps Script for Gmail automation
experience_inventory.json   # User's professional experience (SOURCE OF TRUTH)
```

### Database Schema

PostgreSQL with auto-initialized tables via `initDatabase()` in `src/mastra/tools/db.ts`:

- **runs** — Workflow execution tracking (run_id, status, timestamps)
- **jobs** — Job postings (company, title, location, JD text, requirements, dedup hash)
- **scores** — Match scores per job (total_score, breakdown JSON, match report)
- **artifacts** — Generated documents (DOCX paths, evidence map, verifier report, truth_pass)
- **evidence_map** — Evidence pointers linking claims to inventory (claim_text, evidence_quote, confidence)
- **contacts** — Discovered outreach targets (person_name, title, linkedin_url, message_draft)
- **digests** — Daily summary records (jobs fetched/scored/shortlisted, email sent status)
- **imported_emails** — API-imported emails for processing

### API Endpoints

- `GET /dashboard` — HTML dashboard UI
- `GET /api/dashboard` — Dashboard stats JSON
- `GET /api/dashboard/jobs` — Paginated job list
- `POST /api/import-emails` — Import job emails (requires `x-api-key` header)
- `GET /api/import-emails` — List imported emails
- `ALL /api/inngest` — Inngest webhook endpoint

## Coding Conventions

### File & Naming Patterns

- **Files:** camelCase for all source files (e.g., `matchScorerTool.ts`, `dailyBriefTool.ts`)
- **Functions:** camelCase (e.g., `computeMatchReport`, `extractFactRegistry`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `PRECISION_WEIGHTS`, `DEFAULT_DENYLIST`)
- **DB tables/columns:** snake_case (e.g., `jd_raw_text`, `evidence_map`)
- **Tool IDs:** kebab-case (e.g., `"fetch-emails"`, `"verify-truth"`)
- **Inventory IDs:** kebab-case with numeric suffix (e.g., `"exp-001-b2"`, `"edu-001"`)

### Import Order

```typescript
// 1. Framework imports
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// 2. External packages
import { createOpenAI } from "@ai-sdk/openai";
import * as fs from "fs";

// 3. Internal imports
import { query } from "./db";
import { workspacePath } from "./paths";
import type { JDRequirements } from "./extractJDRequirementsTool";
```

### Tool Definition Pattern

Every tool follows the Mastra `createTool` pattern:

```typescript
export const exampleTool = createTool({
  id: "kebab-case-tool-name",
  description: "Clear description of what the tool does",
  inputSchema: z.object({ /* Zod schema */ }),
  outputSchema: z.object({ /* Zod schema */ }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("[toolName] Starting");
    // ... implementation
    return result;
  },
});
```

### Error Handling

```typescript
// Zod validation errors -> NonRetriableError (skip Inngest retries)
if (error instanceof z.ZodError) {
  throw new NonRetriableError(error.message, { cause: error });
}
// MastraError with specific IDs -> NonRetriableError
if (error instanceof MastraError && error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
  throw new NonRetriableError(error.message, { cause: error });
}
// Other errors propagate for Inngest retry logic
throw error;
```

### Logging Convention

```typescript
logger?.info("emoji [stepName] Message", { key: value });
// Examples:
logger?.info("📊 [Step 2] Scoring 15 jobs");
logger?.warn("⚠️ [enrichJobs] Missing JD for job 42");
logger?.error("❌ [Step 3] Failed for Company - Role", { error: err.message });
```

### Key Constraints

- **Single workflow + single agent:** `src/mastra/index.ts` enforces max 1 workflow and 1 agent with runtime checks. Do not add additional workflows or agents.
- **Module system:** ES modules (`"type": "module"` in package.json, `"module": "ES2022"` in tsconfig)
- **Strict TypeScript:** `strict: true` — no implicit any, null checks required
- **Zod everywhere:** All tool inputs/outputs, workflow step schemas, and data validation use Zod
- **Database connections:** Use `query()` from `src/mastra/tools/db.ts` — it handles pool connect/release. For one-off connections, release in `finally` blocks.

## Environment Setup

1. Copy `.env.example` to `.env` and fill in values
2. Required variables:
   - `DATABASE_URL` — PostgreSQL connection string
   - `OPENAI_API_KEY` (or `AI_INTEGRATIONS_OPENAI_API_KEY` on Replit)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — Gmail OAuth
   - `GMAIL_LABEL` — Gmail label for job alerts (default: "Job Alerts")
   - `DIGEST_EMAIL` — Recipient for daily digest
   - `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Inngest credentials
3. Optional: `CLAY_WEBHOOK_URL`, `IMPORT_API_KEY`, `USE_FIXTURES=true` (for testing with fixture emails)

### Local Development with Docker

```bash
docker-compose up -d db    # Start PostgreSQL
npm run dev                # Start Mastra dev server
./scripts/inngest.sh       # Start Inngest dev server (separate terminal)
```

### Build for Production

```bash
npm run build              # Outputs to .mastra/output/
# Or with Docker:
docker-compose up --build
```

Build requires ~4GB memory (`NODE_OPTIONS='--max-old-space-size=4096'`).

## Testing

22 test files in `tests/` covering core logic:

| Test File | Coverage Area |
|-----------|--------------|
| `matchScorer.test.ts` | Deterministic job scoring algorithm |
| `truthfulnessVerifier.test.ts` | 6-layer fact verification |
| `entityAllowlist.test.ts` | Allowlist/denylist management |
| `dailyBrief.test.ts` | Daily brief assembly |
| `contactDiscovery.test.ts` | Contact discovery via web search |
| `linkedInMessage.test.ts` | LinkedIn outreach message generation |
| `tailoredPrompts.test.ts` | Resume/cover letter prompt construction |
| `formattingValidator.test.ts` | DOCX formatting validation |
| `jobPostingSchema.test.ts` | Job posting schema validation |
| `generateVerifiedPacket.test.ts` | End-to-end packet generation |

Tests use vitest with mock data, describe/it/expect structure, and TypeScript interfaces for fixtures.

## Verification System (6 Layers)

The truthfulness guarantee is enforced by `verifyTruthTool.ts` + `truthfulnessVerifier.ts`:

1. **Evidence Completeness** — Every resume bullet and cover letter claim has an evidence pointer
2. **Evidence Pointer Validity** — All `evidence_id` values exist in the inventory
3. **Quote Accuracy** — Evidence quotes match inventory text (normalized comparison)
4. **Fact Allowlist** — All employers, titles, dates, tools match inventory exactly
5. **Entity Denylist** — Blocks placeholder text, fabricated domains, template variables
6. **Unknown Compliance** — Unsupported requirements marked as "unknown", never invented

A claim must have confidence >= 0.7 to pass. Failed verification produces `line_item_fixes` for correction.

## Scoring System

Deterministic scoring in `matchScorer.ts` (no LLM involved):

- **Modes:** Precision (strict fit) vs. Recall (wider net) — different weight distributions
- **Dimensions:** role_level_match, leadership_scope, domain_relevance, ai_strategy_stack, ai_engineering_stack, location_fit, compensation, transformation_mandate, company_preference, execution_mode_match, spec_inflation_penalty
- **Output:** MatchReport with sub-scores, top 10 supporting bullets, ATS coverage analysis, red flag assessment, explainability sentences

## Output Structure

Generated files organized by date and job:

```
output/
  YYYY-MM-DD/
    daily_brief.json
    Company_Name/
      Role_Name/
        Resume_Company_Role.docx
        CoverLetter_Company_Role.docx
        EvidenceMap_Company_Role.json
        Job_Company_Role.json
        Verifier_Company_Role.json
```
