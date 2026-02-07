# Job Match Automation System

## Overview
Automated daily job-matching system built with Mastra (Agent Stack). Fetches job alert emails, parses and scores job postings against an experience inventory, generates tailored application packets (resume, cover letter, evidence maps), and verifies all content for truthfulness.

## Architecture
- **Framework**: Mastra with Inngest for workflow orchestration
- **Database**: PostgreSQL (Neon-backed via Replit)
- **LLM**: OpenAI via Replit AI Integrations (gpt-4o with web search)
- **Email**: Gmail API for sending digest + email import API for receiving job alerts
- **Output**: DOCX files (resume, cover letter) + JSON (evidence map, verifier, job details)
- **Enrichment**: Web search (OpenAI) for job descriptions + Clay webhook for company/contact data

## Key Files
- `src/mastra/index.ts` - Main Mastra instance registration + import-emails API routes
- `src/mastra/workflows/jobMatchWorkflow.ts` - 5-step workflow pipeline
- `src/mastra/agents/jobMatchAgent.ts` - Agent with all tools, web search, and truthfulness instructions
- `src/mastra/tools/` - 9 tools (fetch emails, parse jobs, enrich jobs, clay enrich, score jobs, generate resume, generate cover letter, verify truth, build output)
- `src/mastra/tools/paths.ts` - Workspace path helper (critical for Mastra bundling)
- `src/mastra/tools/enrichJobsTool.ts` - Saves web search enrichment results to DB
- `src/mastra/tools/clayEnrichTool.ts` - Clay webhook for company/contact enrichment
- `scripts/gmail-apps-script.js` - Google Apps Script for auto-forwarding emails from Gmail
- `experience_inventory.json` - Source of truth for all generated content
- `fixtures/emails/` - Test email fixtures (LinkedIn job alert format)
- `triggers/cronTriggers.ts` - Cron trigger registration

## Email Sources (priority order)
1. **Imported emails** (imported_emails DB table) - via POST /api/import-emails endpoint
2. **Gmail** - fetches from GMAIL_LABEL label (default: "Job Alerts"), falls back to search if label not found
3. **Fixtures** - fallback test data if no other source available
- Google Apps Script (scripts/gmail-apps-script.js) forwards emails from Gmail to the import endpoint
- Gmail connection has addon-only scopes (can send but not read) - import endpoint is the primary path for real emails
- IMPORT_API_KEY environment variable protects the import endpoint

## Workflow Steps
1. **fetch-and-parse-emails**: Checks imported_emails DB, then Gmail label, then fixtures; uses agent to parse individual postings from LinkedIn job alerts (title, company, location, URL only)
2. **enrich-jobs-web-search**: For each parsed job lacking a full description, uses OpenAI web search to look up the role and saves enriched JD text to the DB. Sends to Clay webhook for company/contact enrichment.
3. **score-and-shortlist**: Deterministic scoring against experience inventory using enriched JD text, selects top 10
4. **generate-packets**: For each job: generate resume, cover letter, verify truth (dual: LLM + deterministic), build output folder
5. **send-digest**: Builds HTML digest email with results summary

## Cron Schedule
- Expression: `30 12 * * *` (UTC) = 6:30 AM Chicago time (CST)
- Configurable via SCHEDULE_CRON_EXPRESSION env var

## Environment Variables
- `USE_FIXTURES=true` - Use test fixtures instead of Gmail (currently false)
- `GMAIL_LABEL` - Gmail label to fetch from (default: "Job Alerts")
- `DIGEST_RECIPIENT` - Email address for daily digest
- `SCHEDULE_CRON_EXPRESSION` - Override default cron expression
- `CLAY_WEBHOOK_URL` - Clay webhook URL for company/contact enrichment
- `IMPORT_API_KEY` - API key to protect the import-emails endpoint

## Important Notes
- All file paths must use `workspacePath()` helper from `src/mastra/tools/paths.ts` because Mastra bundles to `.mastra/output/`
- Tool results from multi-step agent calls have structure `{type, toolCallId, toolName, args, result}` - access actual data via `.result`
- The buildOutputTool resolves actual DB job_id by company+title lookup to handle agent-generated IDs
- Deterministic verifier checks numbers (3+ digit), tool names, dates against inventory JSON
- LinkedIn job alerts only contain title, company, location, URL — no full JD. Web search enrichment fills in the details.
- Enrichment step processes jobs in batches of 3 to prevent token limits
- Agent instructions explicitly restrict tool usage during enrichment to webSearch + enrich-jobs only
- Import endpoint has API key auth and duplicate detection

## Recent Changes (2026-02-07)
- Refactored scoring system with configurable weights and dual-mode support
  - Split `data_ai_stack_match` into `ai_strategy_stack` (0-8) and `ai_engineering_stack` (0-7)
  - Added dominance check: if eng > strat AND VP+ title, applies -5 adjustment (precision mode only)
  - Weights loaded from `src/mastra/tools/scoringConfig.ts` with precision and recall profiles
  - Scores normalized to 0-100 scale with raw total and max possible preserved in breakdown
  - `SCORING_MODE` env var toggles between "precision" (default, strict fit) and "recall" (wider net)
  - Recall mode: softens penalties (execution_mode_match clamped to -10/+5, dominance adj disabled)
  - Dashboard shows scoring mode badge and raw-to-normalized mapping
  - 18 unit tests in `tests/scoringWeights.test.ts`
- Added SpecInflationPenalty (0 to -10): penalizes JDs with high AI buzzword density but low business outcome grounding
  - Config in `src/mastra/tools/scoringConfig.ts` with adjustable thresholds and term lists
  - Integrated into scoreSingleJob breakdown and dashboard display
  - 7 unit tests in `tests/specInflationPenalty.test.ts`
- Enhanced scoring output with structured ScoreReport
  - `scoreSingleJob` now returns `report: ScoreReport` with categories, penalties, riskFlags
  - Each category includes score, maxPoints, and up to 5 sorted matchedPhrases
  - Penalties array lists all negative adjustments with reasons
  - Risk flags auto-generated for dominance issues, engineering-heavy roles, buzzword inflation, location mismatches
  - `prettyPrintReport()` produces human-readable output with aligned columns
  - Deterministic ordering via DISPLAY_ORDER constant and sorted phrases/flags
  - 44 snapshot tests in `tests/scoreReport.test.ts`

## Recent Changes (2026-02-06)
- Added email import system: POST /api/import-emails (authenticated) for receiving emails from external sources
- Created Google Apps Script (scripts/gmail-apps-script.js) for forwarding Gmail emails to import endpoint
- Added imported_emails database table with processed flag and duplicate detection
- Updated fetchEmailsTool: checks imported_emails first, then Gmail, then fixtures
- Gmail label configurable via GMAIL_LABEL env var (default: "Job Alerts")
- Clay webhook URL configured and integrated
- Web search enrichment step with batching and tool restrictions
- Successful end-to-end test: 14 jobs parsed, enriched, scored 39-70/100, packets generated
