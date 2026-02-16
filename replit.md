# Job Match Automation System

## Overview
This project automates the daily job application process. It fetches job alerts, scores them against a user's experience, and generates highly tailored, truthful application materials (resume, cover letter, evidence maps). The system's core purpose is to streamline job applications by producing accurate, relevant content grounded in documented experience, aiming to maximize application effectiveness and user efficiency.

## User Preferences
I prefer iterative development with clear communication on major changes. I value detailed explanations, especially for architectural decisions and complex logic.

## System Architecture
The system is built on the Mastra framework, using Inngest for workflow orchestration and PostgreSQL (Neon on Replit) as the primary database. OpenAI's `gpt-4o` with web search (via Replit AI) provides LLM capabilities. The architecture prioritizes truthfulness, enforced by a `FactRegistry` built from the user's `experience_inventory.json`, mandatory evidence pointers for all claims, and a 6-layer verification process.

Key components and their design:

*   **Core Workflow**: A five-step process: fetch/parse emails, enrich jobs (web search, Clay), score/shortlist, generate packets (Extract→Tailor→Verify→Render), and send a daily digest.
*   **Job Processing**: Utilizes a formalized `JobPosting` schema with SimHash for duplicate detection, a level classifier, and keyword extraction. A sophisticated scoring system incorporates configurable weights, `SpecInflationPenalty`, `RoleShape` classification, and hard flag rules.
*   **Tailored Resume Generator**: Produces `TailoredResume` JSON via `gpt-4o`. Design principles include entity allowlist lock-down, evidence on every bullet, `gap_notes` for unsupported requirements (never fabrication), ATS-friendly formatting (no tables/columns), and schema constraints for structure.
*   **Tailored Cover Letter Generator**: Creates `TailoredCoverLetter` JSON via `gpt-4o`. Enforces a 300-400 word count, 1-3 value claims with evidence, an executive tone, `company_research_todo` for missing context, and `gap_notes` for unsupported requirements. All factual claims require evidence pointers.
*   **Truthfulness Verifier**: A deterministic, adversarial 6-layer engine that checks `TailoredResume` and `TailoredCoverLetter` against the `ExperienceInventory`. It returns a pass/fail verdict with detailed `line_item_fixes` for critical violations, including checks for new entities, unsupported metrics, placeholders, inconsistent dates, style rules, and ATS risks.
*   **Automated Fail/Regenerate Loop**: The `generateVerifiedPacketTool` orchestrates a Generate→Verify→Correct loop. If verification fails, the LLM is re-prompted with violation details and specific correction instructions (up to N attempts). It tracks the best attempt and flags `human_review_required` if all attempts fail.
*   **Daily Brief & Digest Email**: The `assembleDailyBriefTool` produces a comprehensive `DailyBrief` JSON with top matches, scores, file paths (in `/YYYY-MM-DD/Company_Role/` layout), outreach targets with LinkedIn messages, and auto-generated "Questions for Ed" (categorized by type: `missing_company_info`, `ambiguous_requirement`, `salary_unknown`, `contact_not_found`, `gap_in_experience`, `application_decision`, `other`; prioritized high/medium/low). The `renderDailyBriefEmail` template renders the full brief as HTML email with ranked table (includes Files/Contacts columns), expandable job detail cards with FILES READY and OUTREACH TARGETS sections, priority-sorted questions section, and monospace storage layout tree. Legacy `renderDigestEmail` remains for backward compatibility. Brief JSON saved to `/output/YYYY-MM-DD/daily_brief.json`.
*   **Formatting Validator**: A pre-PDF validation layer that inspects rendered DOCX content for issues like duplicate headings, placeholders, page count, missing contact info, and broken links, blocking sending if critical violations exist.
*   **Contact Discovery**: Identifies outreach targets using publicly available web searches (never LinkedIn). It structures results into `OutreachTargets` with 7 role categories, infers target departments, builds hiring chains, and provides confidence scores, fallbacks for unfound contacts, and specific search queries.
*   **LinkedIn Message Generator**: Creates grounded warm and cold LinkedIn outreach messages (max 450 characters). Messages are grounded in the user's experience inventory, include JD requirement hooks, and undergo a validation and correction loop if necessary.

## External Dependencies
*   **Database**: PostgreSQL (Neon)
*   **LLM**: OpenAI (gpt-4o with web search)
*   **Workflow Orchestration**: Inngest
*   **Email Services**: Gmail API, Google Apps Script
*   **Data Enrichment**: Clay (via webhook)