# Job Match Automation System

## Overview
Automated daily job-matching system built with Mastra (Agent Stack). Fetches job alert emails, parses and scores job postings against an experience inventory, generates tailored application packets (resume, cover letter, evidence maps), and verifies all content for truthfulness.

## Architecture
- **Framework**: Mastra with Inngest for workflow orchestration
- **Database**: PostgreSQL (Neon-backed via Replit)
- **LLM**: OpenAI via Replit AI Integrations
- **Email**: Gmail API for fetching job alerts and sending digest
- **Output**: DOCX files (resume, cover letter) + JSON (evidence map, verifier, job details)

## Key Files
- `src/mastra/index.ts` - Main Mastra instance registration
- `src/mastra/workflows/jobMatchWorkflow.ts` - 4-step workflow pipeline
- `src/mastra/agents/jobMatchAgent.ts` - Agent with all tools and truthfulness instructions
- `src/mastra/tools/` - 7 tools (fetch emails, parse jobs, score jobs, generate resume, generate cover letter, verify truth, build output)
- `src/mastra/tools/paths.ts` - Workspace path helper (critical for Mastra bundling)
- `experience_inventory.json` - Source of truth for all generated content
- `fixtures/emails/` - Test email fixtures
- `triggers/cronTriggers.ts` - Cron trigger registration

## Workflow Steps
1. **fetch-and-parse-emails**: Fetches from Gmail JOB_ALERTS label (or fixtures), uses agent to parse individual postings
2. **score-and-shortlist**: Deterministic scoring against experience inventory, selects top 10
3. **generate-packets**: For each job: generate resume, cover letter, verify truth (dual: LLM + deterministic), build output folder
4. **send-digest**: Builds HTML digest email with results summary

## Cron Schedule
- Expression: `30 12 * * *` (UTC) = 6:30 AM Chicago time (CST)
- Configurable via SCHEDULE_CRON_EXPRESSION env var

## Environment Variables
- `USE_FIXTURES=true` - Use test fixtures instead of Gmail
- `DIGEST_RECIPIENT` - Email address for daily digest
- `SCHEDULE_CRON_EXPRESSION` - Override default cron expression

## Important Notes
- All file paths must use `workspacePath()` helper from `src/mastra/tools/paths.ts` because Mastra bundles to `.mastra/output/`
- Tool results from multi-step agent calls have structure `{type, toolCallId, toolName, args, result}` - access actual data via `.result`
- The buildOutputTool resolves actual DB job_id by company+title lookup to handle agent-generated IDs
- Deterministic verifier checks numbers (3+ digit), tool names, dates against inventory JSON

## Recent Changes (2026-02-06)
- Fixed path resolution for Mastra bundled environment using workspacePath() helper
- Fixed Zod schemas: replaced z.any() with proper types for Inngest compatibility
- Fixed tool result extraction: unwrap .result from multi-step agent responses
- Fixed deterministic verifier: relaxed number length threshold, added cloud/leadership skills, search full inventory text
- Fixed foreign key violations: buildOutputTool now resolves actual DB job_id by company+title
- Successful end-to-end test: 6 jobs parsed, scored, 6/6 passed truth verification, 30 output files generated
