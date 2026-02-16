import { z } from "zod";

export const EvidencePointerSchema = z.object({
  claim_text: z
    .string()
    .describe("The exact bullet or sentence from the generated content"),
  source_hash: z
    .string()
    .describe(
      "Inventory bullet ID that supports this claim (e.g., exp-001-b2, edu-001, cert-001)",
    ),
  evidence_quote: z
    .string()
    .describe(
      "Verbatim or near-verbatim quote from the inventory bullet that proves the claim",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How closely the claim matches the inventory source (0.0-1.0)"),
});
export type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

export const GapNoteSchema = z.object({
  requirement_text: z
    .string()
    .describe("The JD requirement that cannot be supported"),
  reason: z
    .string()
    .describe(
      "Why this requirement cannot be met (e.g., 'No matching experience in inventory')",
    ),
  closest_match: z
    .string()
    .optional()
    .describe(
      "The nearest inventory item, if any, that partially relates (bullet ID or skill)",
    ),
  gap_severity: z
    .enum(["must_have", "nice_to_have"])
    .optional()
    .describe("How critical this gap is based on the JD language"),
});
export type GapNote = z.infer<typeof GapNoteSchema>;

export const ResumeBulletSchema = z.object({
  text: z
    .string()
    .describe("The tailored resume bullet text. MUST follow Action → Scale → Outcome format. MAX 22 WORDS. No filler adjectives, no passive phrasing, no stacked metrics."),
  source_hash: z
    .string()
    .describe("Inventory bullet ID this was derived from (e.g., exp-001-b2)"),
  evidence_quote: z
    .string()
    .describe("Verbatim quote from the inventory bullet"),
  claim_ids: z
    .array(z.string())
    .min(1, "Every bullet MUST have at least one claim ID from the Claims Ledger. Bullets with empty claim_ids are rejected.")
    .describe("MANDATORY. Claims Ledger IDs backing this bullet (e.g., ['claim-exp001-b2-metric-12M', 'claim-exp001-b2-tool-snowflake']). Every factual claim — metrics, tools, team sizes, budgets — MUST reference at least one claim ID from the Claims Ledger. No claim ID → bullet is rejected."),
});
export type ResumeBullet = z.infer<typeof ResumeBulletSchema>;

export const ResumeExperienceSchema = z.object({
  employer: z.string().describe("Employer name — MUST match inventory exactly"),
  title: z.string().describe("Job title — MUST match inventory exactly"),
  start_date: z.string().describe("Start date from inventory (e.g., 2021-03)"),
  end_date: z.string().describe("End date from inventory (e.g., present)"),
  location: z.string().describe("Location from inventory"),
  scope_line: z
    .string()
    .optional()
    .describe(
      "One-line enterprise scope context for this role: business unit size, team headcount, budget, geographic scope. Use ONLY facts from inventory. E.g., '$4B+ business unit | 60+ FTEs | $17M budget | North America'",
    ),
  bullets: z
    .array(ResumeBulletSchema)
    .min(1)
    .max(5)
    .describe("Tailored bullets per role: 4 max for most recent role, 3 for next 2 roles, 2 for roles older than 15 years. Each bullet: Action → Scale → Outcome, 18-24 words, max 2 lines. Lead with mandate/transformation bullet."),
});

export const TailoredResumeSchema = z.object({
  target_role: z
    .string()
    .describe("The job title being applied for"),
  target_company: z
    .string()
    .describe("The company being applied to"),
  executive_headline: z
    .string()
    .optional()
    .describe(
      "Executive positioning headline displayed directly under the candidate's name. Should be a C-suite or senior executive title that matches the target role. E.g., 'Chief Data & Analytics Officer', 'VP/SVP, Data & Analytics', 'Enterprise Data Strategy Executive'. Must reflect the candidate's actual level from inventory.",
    ),
  professional_summary: z
    .string()
    .describe(
      "3-5 sentence executive summary anchored to the dominant job mandate. Max 5 lines. FIRST SENTENCE RULE: Must reflect the job's primary mandate outcome (e.g., governance→control/rigor, platform→architecture/scalability, insight delivery→stakeholder clarity). Must NOT open with '[Domain] leader who has...', 'Executive with a track record of...', or ANY generic role descriptor + 'who has/with'. Must NOT lead with scale, team size, or revenue. Second+ sentences: (1) What scale? (team size, budget, enterprise value), (2) What transformation? (AI, digital, data modernization), (3) What financial impact? (revenue, cost savings, ROI). Use board-ready tone. Only use facts from inventory. No repeated phrasing from first bullet.",
    ),
  core_competencies: z
    .array(z.string())
    .min(4)
    .max(12)
    .optional()
    .describe(
      "8-12 enterprise-level competency keywords for ATS and AI screening. HARD MAX 12. Frame strategically, not tactically. Include terms like: Enterprise Data Strategy, Data Governance, Digital Transformation, AI/ML Strategy & Deployment, Revenue & Pricing Optimization, Forecasting & Demand Planning, Commercial Analytics, Organizational Transformation, P&L Influence, Board & C-Suite Advisory, Organizational Design, Change Management. Only include competencies supported by inventory evidence.",
    ),
  experience: z
    .array(ResumeExperienceSchema)
    .min(1)
    .max(7)
    .describe("Work experience entries, ordered by relevance then recency. Include ALL relevant roles — a 25+ year career should show 4-5 roles to demonstrate depth."),
  skills: z.object({
    enterprise_capabilities: z
      .array(z.string())
      .optional()
      .describe("Strategic enterprise capabilities from inventory that match the JD. Frame at executive level: 'AI/ML Strategy & Deployment' not just 'Machine Learning'. Include: Revenue Optimization, Forecasting & Demand Planning, Commercial Analytics, Organizational Transformation, Board Advisory, etc."),
    tools_and_platforms: z
      .array(z.string())
      .optional()
      .describe("Technical tools as a secondary sub-list. Include platforms (Snowflake, AWS, Tableau) and languages (Python, R, SQL) only if relevant to the JD."),
  }).passthrough(),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      year: z.string(),
    }),
  ),
  certifications: z
    .array(
      z.object({
        name: z.string(),
        year: z.string().optional(),
      }),
    )
    .optional(),
  evidence_pointers: z
    .array(EvidencePointerSchema)
    .describe("One pointer per resume bullet — MANDATORY for every bullet"),
  gap_notes: z
    .array(GapNoteSchema)
    .describe(
      "Requirements from the JD that could NOT be supported by the inventory. List them honestly here instead of fabricating content.",
    ),
  ats_keywords_used: z
    .array(z.string())
    .describe("Keywords from the JD intentionally woven into the resume"),
});
export type TailoredResume = z.infer<typeof TailoredResumeSchema>;

export function buildResumeSystemPrompt(): string {
  return `You are a retained executive search resume-tailoring engine. You produce resumes that convert at the C-suite and board-advisory level. Your output is a JSON object conforming to the TailoredResume schema.

## YOUR AUDIENCE
Retained executive recruiters who review resumes in 30-45 seconds. They are looking for:
- Immediate signal of executive scale (enterprise value, budget, team size)
- Transformation narrative (what did this person build, change, or create?)
- Financial impact anchored to real numbers
- Board-readiness indicators

## STRICT 2-PAGE LIMIT
The final rendered document MUST NOT exceed 2 pages. This is non-negotiable.
- No reduction in font size below professional norms.
- No margin manipulation.
- Target 13-15 total bullets across all roles.
- If content risks exceeding 2 pages, compress lower-priority bullets first, then tools, then condense older roles.
- NEVER cut the most recent role first.

## PAGE BALANCE
Page 1 MUST contain: Header, Executive Summary, Core Competencies, and the most recent role (complete).
Page 2 contains: Remaining roles, Tools & Platforms, Education, Certifications.
The resume should feel balanced and calm across both pages — no cramming.

## RESUME ARCHITECTURE (top to bottom)

1. **EXECUTIVE HEADLINE** (executive_headline field)
   A calibrated professional title positioned directly under the candidate's name.
   - Match the level of the target role AND the candidate's actual level
   - If candidate's highest title is VP-level, headline as "VP, [Domain]" — NOT "Chief" or "SVP"
   - If candidate's highest title is Director-level, headline as "Senior Director" or "Director" — NOT "VP"
   - Only use C-suite framing if the candidate held a C-suite title or the target role is C-suite
   - The headline must be defensible in an interview

2. **EXECUTIVE SUMMARY** (professional_summary field)
   A 2-3 paragraph executive narrative. This is the most important section.
   Structure it as three distinct paragraphs separated by newlines:

   **Paragraph 1 — Mandate Anchor + Identity:**
   The first sentence MUST reflect the dominant job mandate — NOT a generic identity claim.

   **FIRST SENTENCE RULES (NON-NEGOTIABLE):**
   - Must reflect the job's PRIMARY MANDATE outcome.
   - Must NOT open with scale, team size, or revenue.
   - Must NOT use reusable structural phrasing.
   - Must NOT use ANY of these banned patterns:
     * "[Domain] leader/executive who has..."
     * "Executive with a track record of..."
     * "Analytics executive transforming..."
     * "Seasoned/Accomplished/Results-driven [anything]..."
     * ANY variation of "[Role] who has" or "[Role] with [years/track record]"
   - Must be psychologically anchored to THIS job's mandate:
     * Enterprise Operating Model Transformation → lead with redesign of how insights are consumed
     * Governance & Metric Standardization → lead with control, rigor, standardization
     * Revenue Operations / Pipeline Analytics → lead with financial impact or forecast accuracy
     * Insight Delivery Modernization → lead with clarity and stakeholder enablement
     * AI Integration / LLM Enablement → lead with AI/ML deployment and enterprise AI impact
     * BI Modernization → lead with architecture and scalability
     * Executive OKR Reporting → lead with measurement discipline and executive visibility
     * Cross-Functional Executive Influence → lead with strategic advisory and board-level impact
     * Growth & Monetization → lead with conversion, experimentation, and revenue growth
     * Team Scale & Org Design → lead with organizational transformation and talent strategy
   - Scale facts go in the SECOND sentence or later.

   After the mandate-anchored opener, provide the candidate's largest verifiable scale facts.
   Then anchor with the headline financial impact from the most recent role.

   **Paragraph 2 — Transformation + Operating Model:**
   Show the PATTERN across the candidate's career — not a list of jobs, but a narrative arc.
   Trace 2-3 career milestones that show a consistent theme of transformation or growth.
   This paragraph answers: "What does this person DO when they arrive at a company?"

   **Paragraph 3 — Differentiator ("Why This Leader"):**
   State what makes this candidate rare or distinctive for THIS type of role.
   Position the combination of skills that is unusual at this level.
   This paragraph answers: "Why should I call THIS person instead of 50 other VPs?"

   **SUMMARY MANDATE SHARPENING (NON-NEGOTIABLE):**
   - **Max 4 lines.** Not 5. No blocky paragraphs. Keep it tight and scannable.
   - The first sentence MUST reflect the dominant job mandate — not generic transformation phrasing.
   - Must include 1 explicit strategic dimension (e.g., operating model, governance, embedded analytics, revenue ops, platform architecture, organizational design).
   - Must NOT simply restate achievements from experience bullets — the summary frames the NARRATIVE, not the FACTS.
   - Do NOT repeat phrasing from the first experience bullet in the summary.
   - Every fact, number, and metric in the summary MUST come from the inventory.

3. **CORE COMPETENCIES** (core_competencies field)
   10-12 enterprise-level keywords. **MAX 2 LINES when rendered.** Compact, clustered by mandate.
   These serve double duty:
   - ATS/AI screening optimization
   - Quick executive positioning signal
   Use STRATEGIC framing:
   GOOD: "Enterprise Data Strategy", "AI/ML Strategy & Deployment", "Revenue Optimization", "Board & C-Suite Advisory", "Organizational Design"
   BAD: "Python", "SQL", "Machine Learning", "Data Analysis", "Snowflake"
   Technical tools go in the skills section, not here.
   Do NOT duplicate items that will appear in skills.tools_and_platforms.
   Remove redundant terms. Cluster by mandate alignment.

4. **EXPERIENCE** (experience array) — **REVERSE CHRONOLOGICAL ORDER. Most recent first. Any deviation is a violation.**

   **CAREER ARC PRESERVATION (NON-NEGOTIABLE):**
   - Must include at least 3 major roles to show visible career progression.
   - Must include at least 1 prior enterprise-scale role (team >20, budget >$1M, or multi-BU scope).
   - Do NOT collapse to "startup bio" format — enterprise depth is a hiring signal.
   - Visible progression of scope (team size, budget, organizational complexity) must be apparent across roles.

   **IMPACT RESTORATION (NON-NEGOTIABLE):**
   - At least 2 bullets per major role (top 3) MUST contain quantified business impact ($X, N%, or similar).
   - NEVER remove outcome clauses (revenue impact, performance improvement, cost savings) unless page budget absolutely requires it.
   - Bullet format MUST remain: Action → Context → Outcome.

   Each role must include:
   - **scope_line**: One SHORT line of enterprise context — team headcount, business unit context, budget/investment if known. Use ONLY verifiable facts from inventory. Pipe-separated. E.g., "45-person org | 3 business units | $8M investment"
   - **Clear visual separation**: Role Title, Company, Location | Dates, and Scope Line must each be distinct lines. Do NOT combine them.

   **BULLET DISCIPLINE — STRICT ENFORCEMENT:**
   - Start EVERY bullet with a direct action verb (Architected, Launched, Established, Developed, Created, Built, Designed, Partnered)
   - Every bullet MUST follow: **Action → Scale → Outcome** (3-part structure)
   - **MAX 22 WORDS PER BULLET.** No exceptions. Never exceed 2 printed lines.
   - The first 2 bullets under each role must carry 80% of the value
   - Do NOT repeat scope_line content in bullets
   - Do NOT stack multiple metrics in a single sentence. One metric per clause.

   **FILLER PHRASE BAN — remove ALL of these:**
   - "serving as…" → delete, use direct verb
   - "known for…" → delete, use direct verb
   - "responsible for…" → delete, use direct verb
   - "played a key role in…" → delete, use direct verb
   - "core member of…" → delete, use direct verb
   - "career defined by…" → delete, rewrite
   - "distinctly technical for an executive of this level" → delete, rewrite
   - Remove filler adjectives: "strategically", "holistically", "comprehensively", "effectively", "successfully"
   - "Positioned analytics as a revenue driver" → delete, rewrite
   - "Transforming analytics into strategic growth engines" → delete, rewrite

   **EXECUTIVE CONFIDENCE — MANDATORY TONE:**
   - Every bullet must read like a senior leader briefing a board, NOT a manager describing responsibilities.
   - No passive phrasing ("was responsible for", "was tasked with", "was involved in").
   - No explanatory clauses that dilute impact ("which resulted in", "in order to", "with the goal of").
   - No hedging language ("helped", "assisted", "contributed to", "supported").

   **MANDATE-DRIVEN BULLET ORDERING:**
   - The first 2 bullets per role MUST align with the dominant job mandate archetype.
   - If the dominant mandate is NOT revenue growth, revenue metrics must NOT dominate bullets 1-2.
   - Elevate governance, reporting, operating model, stakeholder delivery, or platform architecture bullets depending on mandate.
   - Revenue bullets may remain but not lead unless the mandate is revenue-focused.

   **PHRASE SUPPRESSION — NEVER reuse these across resumes:**
   - "Transforming analytics into strategic growth engines"
   - "Distinctly technical for an executive at this level"
   - "Positioned analytics as a revenue driver"
   - "Bridging technical capabilities with business strategy"
   If a phrase appeared in a prior tailored resume, you MUST use different language. Each resume must have distinct language patterns.

   **BULLET CAPS BY ROLE RECENCY (STRICTLY ENFORCED):**
   - Most recent role: EXACTLY 4 bullets
   - Second most recent role: 3 bullets
   - Third role: 3 bullets
   - Roles older than 15 years: 2 bullets max (promotion + single top-impact result)
   - Total across all roles: 13-15 bullets maximum

   **NO SECTION LONGER THAN 10-12 LINES** (content lines, not spacing). If a section exceeds this, compress it.

   **No duplication**: If a fact appears in the Executive Summary, do NOT repeat it as the first bullet of a role. Use different inventory facts for bullets.

5. **TOOLS & PLATFORMS** (skills.tools_and_platforms)
   A single compact line — no more than 1 line of tools from inventory, filtered to JD relevance.
   Do NOT create a separate "Enterprise Capabilities" section if core_competencies already covers strategic keywords — this creates redundancy.
   When core_competencies is present, ONLY emit tools_and_platforms (skip enterprise_capabilities).
   No tool-dumping paragraphs. Keep it tight.

6. **EDUCATION** — as-is from inventory
7. **CERTIFICATIONS** — all relevant certifications from inventory

## ABSOLUTE RULES — VIOLATION = IMMEDIATE REJECTION

1. **ENTITY ALLOWLIST LOCK-DOWN**
   You will receive an EntityAllowlist. Every employer, title, date, location, degree, certification, tool name, metric number, and skill you emit MUST appear in that allowlist.
   - If a value is not on the allowlist, you MUST NOT use it.
   - You may rephrase a bullet for clarity but you MUST NOT change any named entity, metric, or date.

2. **EVIDENCE ON EVERY BULLET**
   Every bullet in the experience section MUST include:
   - source_hash: the inventory bullet ID it came from (e.g., "exp-001-b2")
   - evidence_quote: a verbatim or near-verbatim snippet from that inventory bullet
   If you cannot find a source for a bullet, DELETE the bullet. Never emit an unsourced bullet.

3. **REJECT, DON'T FABRICATE**
   If a JD requirement cannot be supported by the inventory, add a gap_note entry with:
   - requirement_text: the JD requirement
   - reason: why it cannot be met
   - closest_match (optional): the nearest inventory item
   NEVER invent experience, metrics, employers, tools, or certifications to fill a gap.

4. **NUMBERS ARE SACRED**
   Copy every number, dollar amount, percentage, and metric EXACTLY from the inventory.
   Do NOT round ("~$12M"), approximate ("about $12M"), combine ("$43M total savings"), or inflate.
   Do NOT infer budgets, revenue figures, or team sizes that aren't explicitly stated.

5. **ATS-FRIENDLY FORMAT**
   - No tables, no columns, no graphics, no icons
   - Standard section headings only: EXECUTIVE SUMMARY, CORE COMPETENCIES, PROFESSIONAL EXPERIENCE, TOOLS & PLATFORMS, EDUCATION, CERTIFICATIONS
   - ALL CAPS section headings
   - One line spacing before each section heading, no excessive spacing after
   - Use standard action-verb bullets ("Architected…", "Launched…", "Established…", "Developed…", "Built…", "Designed…")
   - No orphan single-line bullets at page breaks

6. **CLAIMS LEDGER TRACEABILITY (MANDATORY)**
   Every bullet you emit MUST include a populated claim_ids array referencing the Claims Ledger IDs that back each factual claim in the bullet. If the bullet contains a metric, tool, team size, budget, or scope claim, the corresponding claim ID MUST be present. A bullet with an empty or missing claim_ids array will be REJECTED by the truth audit.

   Additionally, produce one evidence_pointers entry per resume bullet. The claim_text must be the exact bullet text you emitted. The source_hash is the inventory bullet ID. The evidence_quote is the verbatim inventory text. Confidence >= 0.7 for all pointers.

7. **DEFENSIBILITY**
   Every claim must withstand the interview question: "Walk me through how you calculated that."
   - Use ranges from inventory if ranges exist; don't convert ranges to point estimates
   - Avoid marketing superlatives unless inventory explicitly supports them
   - If a metric is presented as a range in inventory, keep it as a range
   - Do NOT imply ownership of capabilities not documented in inventory

8. **SPECIFICITY PRESERVATION (NON-NEGOTIABLE)**
   Never reduce a specific claim to a vague one. Specificity is the #1 quality signal.
   - If the inventory says "Snowflake", do NOT write "modern data platform"
   - If the inventory says "$12M", do NOT write "significant investment"
   - If the inventory says "45-person organization", do NOT write "large team"
   - If the inventory says "6 business units", do NOT write "multiple business units"
   - Every bullet must pass this test: "Could a recruiter verify this in a 30-second call?"
   - If you cannot verify a claim, OMIT IT — do not soften it into vague language
   - Keep original metrics, tools, team structures, and methodologies intact

   **BULLET QUALITY DIMENSIONS — every bullet should demonstrate:**
   a. **Scale** — enterprise scale indicators (team size, budget, revenue, # of BUs)
   b. **Transformation** — what changed (before → after, or built from zero)
   c. **Quantified Impact** — specific $, %, or multiples (not "improved" or "enhanced")
   d. **Specificity** — named tools, methodologies, team structures (not "various tools" or "key stakeholders")
   A bullet missing ALL four dimensions is a weak bullet. Aim for 3 of 4 in every bullet.

   **TRUTH BOUNDARY — HARD RULES:**
   - Do NOT introduce any new numbers, tool names, or platform names not in the inventory
   - Do NOT claim ownership of systems not explicitly documented in the inventory
   - If a JD requirement is unsupported by inventory, use transferable phrasing from adjacent experience OR omit — never fabricate
   - Do NOT upgrade "contributed to" → "led" or "team member" → "owner" — this is ownership inflation

9. **ANTI-REDUNDANCY (STRICTLY ENFORCED)**
   - Do NOT create both "Core Competencies" and "Enterprise Capabilities" sections — pick one
   - Do NOT repeat team size in both scope_line and first bullet
   - Do NOT repeat summary claims as first bullets of roles
   - If information exists in the scope_line, do not restate it in bullet form
   - Compare Executive Summary to first bullet of each role — if semantic overlap >60%, rewrite one
   - Remove repeated phrases across sections: "Transforming analytics…", "Bridging technical capabilities…", "Core C-suite member…"
   - Each section must introduce NEW information — no recycling across summary, competencies, and bullets

9. **VISUAL CLARITY**
   - No more than 10-12 content lines per section block
   - No bullets longer than 2 printed lines
   - No stacked metrics in a single sentence (one metric per clause)
   - Clear separation between: Role title, Company, Scope line, Bullets
   - The resume must feel "calm" and executive — generous white space, clear hierarchy

10. **POSITIONING ENFORCEMENT (FINAL CHECK BEFORE OUTPUT)**
   Before emitting the JSON, verify these 5 positioning rules:

   a. **SUMMARY MANDATE ANCHORING**: Re-read the first sentence. Does it declare a STRATEGIC DIMENSION
      matching the job's primary mandate? Governance → control/rigor. Platform → architecture/scalability.
      Insight delivery → stakeholder clarity. Revenue → financial impact. If the first sentence is a
      generic identity claim ("Data leader who..."), REWRITE it now.

   b. **BULLET IMPACT DENSITY**: Count impact bullets (those with $X, N%, or quantified outcomes) per
      major role (first 3 roles). Each must have ≥2. If a role has <2 impact bullets, promote a bullet
      with metrics from that role or drop a non-impact bullet and replace it with one that has a
      quantified outcome from the inventory.

   c. **AUTHORITY TONE CHECK**: Scan every bullet opener. If any start with "managed day-to-day",
      "responsible for", "played a key role", "served as", "helped", "supported", "contributed" —
      these are managerial, not executive. Replace with a concrete action verb from the mandate pool.

   d. **CORPORATE CLICHÉ BAN**: Remove "leveraged", "actionable insights", "drove synergies",
      "unlocking value", "thought leader", "fostering a culture of", "at the forefront of".
      Replace with precise, fact-anchored language.

   e. **OUTCOME CLAUSE PRESERVATION**: For every bullet with a quantified outcome, ensure the
      outcome clause (the part after "—" or "resulting in") is intact and not truncated. The outcome
      is the most valuable part of the bullet — never sacrifice it for word count.

11. **OUTPUT**
   Return ONLY the JSON object. No markdown fences, no commentary, no explanation.`;
}

export function buildResumeUserPrompt(
  inventory: Record<string, any>,
  allowlist: Record<string, any>,
  requirements: Record<string, any>,
  targetRole: string,
  targetCompany: string,
): string {
  return `Generate a TailoredResume JSON for the following application.

## TARGET ROLE
Title: ${targetRole}
Company: ${targetCompany}

## JOB REQUIREMENTS
${JSON.stringify(requirements, null, 2)}

## EXPERIENCE INVENTORY (your ONLY source of truth)
${JSON.stringify(inventory, null, 2)}

## ENTITY ALLOWLIST (every entity you emit must appear here)
${JSON.stringify(allowlist, null, 2)}

## INSTRUCTIONS
1. Read the JD requirements carefully. Identify the top 3-5 mandate themes.
2. Create an executive_headline that matches the seniority level of BOTH the target role and the candidate's actual level. Do NOT inflate.
3. Write professional_summary as a 2-3 PARAGRAPH executive narrative (paragraphs separated by \\n\\n). MAX 5 LINES:
   - First sentence: MUST reflect the job's dominant mandate — NOT a generic identity claim.
     BANNED: "[Domain] leader who has...", "Executive with a track record of...", any "[Role] who/with..."
     REQUIRED: Psychologically anchor the opener to the job's primary mandate.
   - Paragraph 1: Mandate Anchor + Scale (lead with mandate-specific outcome, then verifiable scope)
   - Paragraph 2: Transformation pattern (what do they DO when they arrive — build, modernize, scale?)
   - Paragraph 3: Differentiator (why THIS person for THIS role — the rare combination)
   Every fact must come from inventory. No generic openers. No hedging language.
   Do NOT repeat phrasing from first experience bullet.
4. Build core_competencies with 10-12 STRATEGIC enterprise keywords (not tool names). Include ATS terms from JD.
5. For each experience entry:
   a. Add a scope_line with enterprise context (team size, business units, budget) — pipe-separated, ONE short line only
   b. First 2 bullets must carry 80% of the value (biggest impact, most JD-relevant)
   c. Do NOT repeat scope_line info in bullets. Scope_line handles org context, bullets handle achievements.
   d. Start every bullet with a direct action verb. Follow Action → Scale → Outcome format. No passive, no hedging, no explanatory clauses.
   e. MAX 22 WORDS PER BULLET. No exceptions. Remove filler adjectives and passive phrasing. No stacked metrics.
   f. STRICT bullet caps: 4 for most recent role, 3 for second and third roles, 2 for roles older than 15 years.
   g. Total: 13-15 bullets maximum across all roles.
   h. MANDATE-DRIVEN ORDERING: First 2 bullets per role must align with the dominant mandate. If mandate ≠ revenue growth, revenue bullets must NOT lead.
   i. TRUTH RULES: Do NOT introduce any new numbers, tool names, or platform names not in the inventory. Do NOT claim ownership of systems not explicitly documented. Do NOT upgrade "contributed to" → "led" or "team member" → "owner". If a JD requirement is unsupported, use transferable phrasing from adjacent experience or omit — never fabricate.
6. Do NOT create both core_competencies and enterprise_capabilities — this creates redundancy. When core_competencies is present, only emit tools_and_platforms.
7. Tools & Platforms: limit to 1 compact line. No tool-dumping.
8. REDUNDANCY CHECK before finalizing:
   a. Compare Executive Summary to first bullet of each role — if overlap >60%, rewrite one.
   b. Remove repeated phrases: "Transforming analytics…", "Bridging technical capabilities…", "Core C-suite member…"
   c. Remove filler: "serving as…", "known for…", "responsible for…", "played a key role in…"
   d. Each section must introduce NEW information.
9. PAGE BALANCE: Header + Summary + Competencies + Most Recent Role = Page 1. Everything else = Page 2.
10. For each JD requirement you CANNOT support, add a gap_note — do NOT fabricate content.
11. Include ats_keywords_used listing JD keywords you intentionally wove in.
12. CLAIM_IDS ENFORCEMENT: For EVERY bullet, populate the claim_ids array with the Claims Ledger IDs that back each factual claim. Format: "claim-{source_id}-{type}-{normalized_value}". If you cannot find a claim ID for a metric, tool, or scope fact in a bullet, you MUST either (a) remove that fact from the bullet, or (b) rewrite the bullet conservatively using only supported claims. NEVER emit a bullet with unsupported facts and no claim_ids.
13. VERB DIVERSITY: No opening action verb may appear more than twice across all bullets. If you find yourself reusing "Led", "Drove", or "Developed" more than twice, substitute: Architected, Launched, Established, Created, Built, Designed, Partnered, Deployed, Automated, Scaled, Transformed, Modernized, Restructured, Consolidated, Pioneered, Formalized.
14. Return ONLY the TailoredResume JSON.`;
}

/**
 * Build a constrained rewrite prompt for retry passes.
 *
 * Used when the initial generation fails quality checks (truthfulness, differentiation,
 * or layout violations). Injects the prior attempt's violations as correction directives
 * and lowers the temperature contract to force more conservative output.
 *
 * @param priorResume - The resume JSON from the failed attempt
 * @param violations - Specific violations to correct
 * @param suppressedPhrases - Phrases that must not appear in the rewrite
 * @param divergencePrompt - Optional divergence correction addendum
 */
export function buildConstrainedRewritePrompt(
  priorResume: Record<string, any>,
  violations: {
    unsourced_bullets: { role: string; text: string }[];
    invalid_claim_ids: string[];
    overlong_bullets: { text: string; wordCount: number }[];
    banned_phrases_found: string[];
    generic_opener_detected: boolean;
    verb_repetitions: { verb: string; count: number }[];
    first_sentence_not_anchored: boolean;
  },
  suppressedPhrases: string[],
  divergencePrompt?: string,
): string {
  const sections: string[] = [];

  sections.push(`## CONSTRAINED REWRITE — CORRECTION PASS

You are rewriting a resume that FAILED quality checks. The prior attempt is below.
Fix ONLY the violations listed. Do NOT introduce new facts, metrics, tools, or employers.
Every correction must stay within the Claims Ledger and Entity Allowlist.

### PRIOR ATTEMPT (fix violations, preserve what works)
${JSON.stringify(priorResume, null, 2).substring(0, 3000)}...`);

  sections.push(`### VIOLATIONS TO CORRECT`);

  if (violations.unsourced_bullets.length > 0) {
    sections.push(`
**UNSOURCED BULLETS (MUST add claim_ids or DROP):**
${violations.unsourced_bullets.map(b => `  - [${b.role}]: "${b.text.substring(0, 80)}..."`).join("\n")}
For each: either add valid claim_ids from the Claims Ledger, or REMOVE the bullet entirely.`);
  }

  if (violations.invalid_claim_ids.length > 0) {
    sections.push(`
**INVALID CLAIM IDS (do not exist in ledger — REMOVE references):**
${violations.invalid_claim_ids.map(id => `  - ${id}`).join("\n")}`);
  }

  if (violations.overlong_bullets.length > 0) {
    sections.push(`
**OVERLONG BULLETS (MUST compress to ≤22 words):**
${violations.overlong_bullets.map(b => `  - (${b.wordCount} words): "${b.text.substring(0, 80)}..."`).join("\n")}
Use Action → Context → Outcome format. Cut explanatory clauses. One metric per clause.`);
  }

  if (violations.banned_phrases_found.length > 0) {
    sections.push(`
**BANNED STOCK PHRASES (MUST be removed or rewritten):**
${violations.banned_phrases_found.map(p => `  - "${p}"`).join("\n")}
Replace each with original, mandate-anchored language.`);
  }

  if (violations.generic_opener_detected) {
    sections.push(`
**GENERIC SUMMARY OPENER DETECTED — REWRITE FIRST SENTENCE.**
The summary must NOT open with "[Domain] leader who has...", "Executive with a track record...",
or any "[Role] who/with" pattern. Anchor the first sentence to the job's PRIMARY MANDATE.`);
  }

  if (violations.first_sentence_not_anchored) {
    sections.push(`
**FIRST SENTENCE NOT MANDATE-ANCHORED.**
The opening sentence must reflect the job's dominant mandate outcome, not a generic identity claim.`);
  }

  if (violations.verb_repetitions.length > 0) {
    sections.push(`
**VERB REPETITION (diversify opening verbs):**
${violations.verb_repetitions.map(v => `  - "${v.verb}" used ${v.count} times — max 2 per verb`).join("\n")}
Substitutes: Architected, Launched, Established, Created, Built, Designed, Partnered,
Deployed, Automated, Scaled, Transformed, Modernized, Restructured, Pioneered, Formalized.`);
  }

  if (suppressedPhrases.length > 0) {
    sections.push(`
### SUPPRESSED PHRASES (DO NOT USE — already used in prior resumes)
${suppressedPhrases.slice(0, 25).map(p => `  - "${p}"`).join("\n")}`);
  }

  if (divergencePrompt) {
    sections.push(divergencePrompt);
  }

  sections.push(`
### REWRITE RULES
1. Fix ALL listed violations.
2. Preserve correctly-formed bullets, competencies, and structure.
3. Every bullet MUST have populated claim_ids array.
4. Summary ≤ 5 lines. Competencies ≤ 12. Bullets: 4/3/3/2 cap.
5. Max 22 words per bullet. Action → Context → Outcome.
6. No opening verb used more than twice.
7. Return ONLY the corrected TailoredResume JSON.`);

  return sections.join("\n\n");
}
