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

## External Dependencies
-   **Database**: PostgreSQL (via Neon)
-   **LLM**: OpenAI (gpt-4o with web search)
-   **Workflow Orchestration**: Inngest
-   **Email Services**: Gmail API, Google Apps Script
-   **Data Enrichment**: Clay (via webhook)