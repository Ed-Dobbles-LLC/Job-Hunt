# Job Match Automation System

## Overview
This project is an automated daily job-matching system. Its primary purpose is to fetch job alert emails, score job postings against a user's experience inventory, and generate highly tailored and truthful application packets (resume, cover letter, evidence maps). The system aims to streamline the job application process by ensuring generated content is accurate, relevant, and consistent with the user's documented experience.

## User Preferences
I prefer iterative development with clear communication on major changes. I value detailed explanations, especially for architectural decisions and complex logic.

## System Architecture
The system is built on the Mastra framework, utilizing Inngest for robust workflow orchestration. PostgreSQL, hosted via Neon on Replit, serves as the primary database. OpenAI's `gpt-4o` with web search capabilities is integrated through Replit AI for LLM functionalities. Email interactions leverage the Gmail API for sending digests and an internal API for receiving job alerts. Outputs are generated as DOCX files for resumes and cover letters, and JSON for evidence maps, verifier reports, and job details. External enrichment services include OpenAI's web search for job descriptions and Clay for company/contact data.

The core workflow consists of five steps:
1.  **Fetch and Parse Emails**: Gathers job postings from various sources.
2.  **Enrich Jobs**: Utilizes web search and Clay for comprehensive job and company data.
3.  **Score and Shortlist**: Deterministically scores jobs against the experience inventory to select the best matches.
4.  **Generate Packets**: Follows an Extract→Tailor→Verify→Render pipeline to create application materials, ensuring truthfulness through a multi-layered verification process against a `FactRegistry`.
5.  **Send Digest**: Compiles and sends a summary of the day's matches.

Truthfulness is a critical architectural principle, enforced through:
-   A `FactRegistry` built dynamically from `experience_inventory.json`.
-   Mandatory evidence pointers (e.g., `exp-001-b2`) for every claim in generated documents, linking directly to the inventory.
-   A 6-layer verification process checking for completeness, pointer validity, quote accuracy, entity allowlisting, denylist checks, and compliance against ungrounded assertions.
-   Strict rules against inventing facts and a commitment to ATS-friendly DOCX templates.

The system also incorporates a formalized `JobPosting` schema with SimHash for near-duplicate detection, a level classifier, and keyword extraction. A sophisticated scoring system with configurable weights, a `SpecInflationPenalty`, `RoleShape` classification, and a hard flag rules engine determines job suitability.

### Tailored Resume Generator (Mini-prompt 6)
The resume generation pipeline uses a structured LLM prompt (`tailoredResumePrompt.ts`) with `generateObject` to produce a `TailoredResume` JSON. Key design decisions:
-   **Entity Allowlist Lock-down**: Every entity (employer, title, date, metric, tool) must appear in the `EntityAllowlist` built from the inventory.
-   **Evidence on Every Bullet**: Each `ResumeBullet` includes `source_hash` (inventory bullet ID) and `evidence_quote` (verbatim text).
-   **Reject Behavior**: Unsupported JD requirements produce `gap_notes` with `requirement_text`, `reason`, and optional `closest_match` — never fabricated content.
-   **ATS-Friendly**: No tables, no columns — plain sections (Summary, Experience, Skills, Education, Certifications).
-   **Schema Constraints**: 1-5 experience entries, 1-6 bullets per role, `ats_keywords_used` array for keyword tracking.

### Tailored Cover Letter Generator (Mini-prompt 7)
The cover letter pipeline uses `tailoredCoverLetterPrompt.ts` with `generateObject` to produce a `TailoredCoverLetter` JSON. Key design decisions:
-   **250-350 Word Constraint**: Enforced via schema and prompt instructions with `word_count` field.
-   **1-3 Value Claims Max**: Each `ValueClaim` includes `claim_sentence`, `source_hash`, `evidence_quote`, and optional `metric_used`.
-   **Executive Tone**: Specific, confident, forward-looking — no clichés or buzzword stuffing.
-   **Company Research Todo**: Populated when company context is missing — prevents fabricating company-specific claims.
-   **Evidence Pointers**: Required for ALL factual claims (not just value claims), with confidence ≥ 0.7.
-   **Reject Behavior**: Same `gap_notes` pattern as resume for unsupported requirements.

### Truthfulness Verifier (Mini-prompt 8)
The truthfulness verifier (`truthfulnessVerifier.ts`) is a deterministic, adversarial 6-layer verification engine that assumes the generator may hallucinate. It takes `TailoredResume`, `TailoredCoverLetter`, `EntityAllowlist`, and `ExperienceInventory` as inputs and returns a strict JSON report. Key design decisions:
-   **Pass/Fail Verdict**: `pass: true` only when zero critical violations exist.
-   **6 Violation Types**: `NEW_ENTITY` (hallucinated employer/title/cert/degree), `UNSUPPORTED_METRIC` (fabricated numbers), `PLACEHOLDER` (denylist artifacts like template vars, lorem ipsum, code artifacts), `INCONSISTENT_DATE` (dates not in allowlist or chronologically invalid), `STYLE_RULE_BROKEN` (missing evidence pointers, invalid source_hash, low confidence, clichés, word count), `ATS_RISK` (tables, special chars, missing keywords).
-   **Allowlist-Aware Placeholder Suppression**: Denylist matches that overlap with allowlisted entities (e.g., "Acme" in "Acme Financial Group") are automatically suppressed to prevent false positives.
-   **Line Item Fixes**: Actionable `line_item_fixes[]` suggestions with `location`, `current_text`, `suggested_text`, `reason`, and `violation_type`.
-   **Evidence Pointer Validation**: Cross-checks every `source_hash` against inventory bullet IDs, validates `evidence_quote` similarity (≥60% word match ratio), ensures confidence ≥ 0.7, and verifies pointer count matches bullet count.

### Automated Fail/Regenerate Loop (Mini-prompt 9)
The `generateVerifiedPacketTool` (`generateVerifiedPacketTool.ts`) orchestrates the full Generate→Verify→Correct loop. Key design decisions:
-   **Loop Structure**: Generates resume + cover letter JSON, runs 6-layer verifier, and if verification fails, re-prompts the LLM with violation details and per-type correction instructions. Repeats up to N attempts (configurable 1-5, default 3).
-   **Correction Prompts**: `buildCorrectionPrompt` constructs targeted re-prompts with the previous output, critical violations, suggested fixes, and type-specific correction instructions for all 6 violation types.
-   **Selective Re-generation**: Only re-generates the document (resume or cover letter) that had violations — keeps clean documents unchanged between attempts.
-   **Temperature Reduction**: Correction attempts use temperature 0.2 (vs 0.3/0.4 initial) for more deterministic output.
-   **Best Attempt Tracking**: Tracks the attempt with the fewest critical violations (with warning-count tie-breaker). If all attempts fail, returns the best attempt rather than the last.
-   **Human Review Packet**: On exhaustion, sets `human_review_required: true` with detailed `human_review_notes[]` listing remaining violations and suggested fixes for manual correction.
-   **Attempt History**: Records each attempt's pass/fail, violation counts, violation types, and timestamp in `attempt_history[]`.
-   **DB Persistence**: Saves `verified_packet` metadata (pass/fail, attempts_used, best_attempt, attempt_history, human_review_required) to `scores.breakdown_json`.

### Daily Digest Email (Mini-prompt 11)
The `sendDigestTool` (`sendDigestTool.ts`) aggregates daily results and sends a rich HTML digest email. Key design decisions:
-   **DB Aggregation**: Queries `jobs`, `scores`, and `artifacts` tables for today's results, computing stats (fetched, scored, shortlisted, packets, pass/fail).
-   **HTML Template**: `digestEmailTemplate.ts` renders a mobile-responsive, inline-CSS email with summary stat boxes, ranked job table (color-coded scores: green ≥80, yellow ≥60, red <60), detail cards (skills, salary, location, roleShape, gaps), and empty-state handling.
-   **Gmail API**: Uses existing `sendEmail()` from `gmailClient.ts` with OAuth credentials.
-   **Digest Metadata**: Stored in `digests` table (digest_id, run_date, stats, email_sent, sent_at, recipient_email).
-   **Dry-Run Mode**: `dryRun: true` generates HTML without sending, returns `htmlPreview`.
-   **Recipient**: Defaults to `experience_inventory.json` → `profile.email`, overridable via `recipientOverride`.

### Formatting Validator (Pre-PDF)
The `formattingValidator.ts` provides a deterministic pre-PDF validation layer that inspects rendered DOCX content before sending. `validateFormattingTool.ts` wraps it as a Mastra tool. Key design decisions:
-   **5 Check Categories**: DUPLICATE_HEADING, PLACEHOLDER, PAGE_COUNT, MISSING_CONTACT, BROKEN_LINK, plus MISSING_SECTION for resumes.
-   **DOCX XML Inspection**: Parses rendered DOCX via JSZip to extract word/document.xml, then runs pattern matching on text runs.
-   **Placeholder Denylist**: 23 patterns covering template variables ({{ }}, ${ }), [INSERT/YOUR/COMPANY] brackets, lorem ipsum, [object Object], undefined/null, TODO/FIXME/XXX markers, placeholder domains, sample@ prefixes, N/A, TBD.
-   **Allowlist-Aware**: Placeholder checks accept an allowlist to suppress false positives (e.g., profile email containing example.com).
-   **Contact Info Validation**: Checks for candidate name (critical), email/phone/location (warnings) in document content.
-   **Link Validation**: Detects localhost, 127.0.0.1, example.com, and malformed URLs.
-   **Page Count Enforcement**: Resume max 2 pages, cover letter max 1 page (critical violations).
-   **Block Sending**: Returns `blockSending: true` when any critical violation exists, preventing digest/output from proceeding.
-   **Combined Report**: `validatePacketFormatting()` runs both resume and cover letter checks in parallel, returns unified pass/fail with per-document breakdowns.

## External Dependencies
-   **Database**: PostgreSQL (via Neon)
-   **LLM**: OpenAI (gpt-4o with web search)
-   **Workflow Orchestration**: Inngest
-   **Email Services**: Gmail API, Google Apps Script
-   **Data Enrichment**: Clay (via webhook)