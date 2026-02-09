# Job Match Automation System

AI-powered job hunting automation that fetches job alerts, scores them against your experience, and generates truthful, tailored application materials.

## What It Does

1. **Fetches & parses** job alert emails from Gmail (LinkedIn)
2. **Enriches** jobs with full descriptions via web search
3. **Scores & shortlists** against your experience inventory with configurable weights
4. **Generates verified packets** — tailored resume, cover letter, and evidence maps with a 6-layer truthfulness verification loop
5. **Sends a daily brief** — ranked matches, file paths, outreach targets, and questions for review

## Tech Stack

- **Framework**: [Mastra](https://mastra.ai) + [Inngest](https://inngest.com) for workflow orchestration
- **LLM**: OpenAI gpt-4o (with web search)
- **Database**: PostgreSQL (Neon)
- **Documents**: DOCX generation + LibreOffice PDF conversion
- **Language**: TypeScript on Node.js 22

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Fill in your API keys

# Start Mastra dev server
npm run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Mastra dev server |
| `npm run build` | Build for production |
| `npm test` | Run tests (vitest) |
| `npm run check` | TypeScript type check |
| `npm run format` | Format code with Prettier |
| `npm run check:format` | Check formatting |

## Deployment

Docker and Railway configs are included:

```bash
# Local with Docker Compose (app + PostgreSQL)
docker compose up

# Or deploy to Railway
railway up
```

## Project Structure

```
src/mastra/
  agents/        # Job matching agent definitions
  workflows/     # Inngest workflow orchestration (5-step pipeline)
  tools/         # 47+ specialized tools (scoring, verification, generation)
  storage/       # PostgreSQL integration
  inngest/       # Workflow engine config
tests/           # 20 test files, 604 tests (vitest)
output/          # Generated application packages (YYYY-MM-DD/Company_Role/)
fixtures/        # Test data
docs/            # Architecture and integration docs
scripts/         # Build and setup scripts
```

## Key Design Decisions

- **Truthfulness first**: 6-layer deterministic verification engine checks every claim against `experience_inventory.json`. No hallucinations allowed.
- **Evidence-backed**: Every resume bullet and cover letter claim requires an evidence pointer back to documented experience.
- **Automated fail/regenerate**: If verification fails, the LLM is re-prompted with violation details (up to 3 attempts).
- **Scoring transparency**: Score reports include category breakdowns, matched phrases, penalties, and risk flags.
