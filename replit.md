# Job Match Automation System

## Overview
Automated daily job-matching system built with Mastra (Agent Stack). Fetches job alert emails, parses and scores job postings against an experience inventory, generates tailored application packets (resume, cover letter, evidence maps), and verifies all content for truthfulness.

## Architecture
- **Framework**: Mastra with Inngest for workflow orchestration
- **Database**: PostgreSQL (Neon-backed via Replit)
- **LLM**: OpenAI via Replit AI Integrations (gpt-4o with web search)
- **Email**: Gmail API for fetching job alerts and sending digest
- **Output**: DOCX files (resume, cover letter) + JSON (evidence map, verifier, job details)
- **Enrichment**: Web search (OpenAI) for job descriptions + optional Clay webhook for company/contact data

## Key Files
- `src/mastra/index.ts` - Main Mastra instance registration
- `src/mastra/workflows/jobMatchWorkflow.ts` - 5-step workflow pipeline
- `src/mastra/agents/jobMatchAgent.ts` - Agent with all tools, web search, and truthfulness instructions
- `src/mastra/tools/` - 9 tools (fetch emails, parse jobs, enrich jobs, clay enrich, score jobs, generate resume, generate cover letter, verify truth, build output)
- `src/mastra/tools/paths.ts` - Workspace path helper (critical for Mastra bundling)
- `src/mastra/tools/enrichJobsTool.ts` - Saves web search enrichment results to DB
- `src/mastra/tools/clayEnrichTool.ts` - Optional Clay webhook for company/contact enrichment
- `experience_inventory.json` - Source of truth for all generated content
- `fixtures/emails/` - Test email fixtures (LinkedIn job alert format)
- `triggers/cronTriggers.ts` - Cron trigger registration

## Workflow Steps
1. **fetch-and-parse-emails**: Fetches from Gmail JOB_ALERTS label (or fixtures), uses agent to parse individual postings from LinkedIn job alerts (title, company, location, URL only)
2. **enrich-jobs-web-search**: For each parsed job lacking a full description, uses OpenAI web search to look up the role and saves enriched JD text to the DB. Optionally sends to Clay webhook if CLAY_WEBHOOK_URL is configured.
3. **score-and-shortlist**: Deterministic scoring against experience inventory using enriched JD text, selects top 10
4. **generate-packets**: For each job: generate resume, cover letter, verify truth (dual: LLM + deterministic), build output folder
5. **send-digest**: Builds HTML digest email with results summary

## Cron Schedule
- Expression: `30 12 * * *` (UTC) = 6:30 AM Chicago time (CST)
- Configurable via SCHEDULE_CRON_EXPRESSION env var

## Environment Variables
- `USE_FIXTURES=true` - Use test fixtures instead of Gmail
- `DIGEST_RECIPIENT` - Email address for daily digest
- `SCHEDULE_CRON_EXPRESSION` - Override default cron expression
- `CLAY_WEBHOOK_URL` - (Optional) Clay webhook URL for company/contact enrichment

## Important Notes
- All file paths must use `workspacePath()` helper from `src/mastra/tools/paths.ts` because Mastra bundles to `.mastra/output/`
- Tool results from multi-step agent calls have structure `{type, toolCallId, toolName, args, result}` - access actual data via `.result`
- The buildOutputTool resolves actual DB job_id by company+title lookup to handle agent-generated IDs
- Deterministic verifier checks numbers (3+ digit), tool names, dates against inventory JSON
- LinkedIn job alerts only contain title, company, location, URL — no full JD. Web search enrichment fills in the details.
- Enrichment step processes jobs in batches of 3 to prevent token limits
- Agent instructions explicitly restrict tool usage during enrichment to webSearch + enrich-jobs only

## Recent Changes (2026-02-06)
- Updated fixture emails to match real LinkedIn job alert format (title, company, location, URL only)
- Added web search enrichment step: agent uses OpenAI webSearchPreview to look up full job descriptions
- Added Clay webhook enrichment tool (optional, activated by CLAY_WEBHOOK_URL env var)
- Updated parseJobsTool: jd_text is now optional for LinkedIn alerts
- Updated generateResumeTool: certifications accept both strings and objects
- Added compensation column to jobs table
- Enrichment batching (3 jobs per batch) with explicit tool restrictions
- Improved deduplication hash to include posting_url for alert-only inputs
- Successful end-to-end test: 14 jobs parsed from LinkedIn format, enriched via web search (592-1420 chars JD text), scored 39-70/100, packets generated with truth verification
