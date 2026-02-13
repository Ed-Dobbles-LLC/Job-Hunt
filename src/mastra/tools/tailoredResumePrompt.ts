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
});
export type GapNote = z.infer<typeof GapNoteSchema>;

export const ResumeBulletSchema = z.object({
  text: z
    .string()
    .describe("The tailored resume bullet text (action verb + result + metric)"),
  source_hash: z
    .string()
    .describe("Inventory bullet ID this was derived from (e.g., exp-001-b2)"),
  evidence_quote: z
    .string()
    .describe("Verbatim quote from the inventory bullet"),
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
    .max(8)
    .describe("3-8 tailored bullets per role, each with evidence. Lead with mandate/transformation bullet."),
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
      "4-6 sentence executive summary anchored to measurable enterprise impact. Must immediately answer: (1) What scale? (team size, budget, enterprise value), (2) What transformation? (AI, digital, data modernization), (3) What financial impact? (revenue, cost savings, ROI). Open with the candidate's actual scope, not generic 'accomplished executive' language. Use board-ready tone. Only use facts from inventory.",
    ),
  core_competencies: z
    .array(z.string())
    .min(8)
    .max(14)
    .optional()
    .describe(
      "8-14 enterprise-level competency keywords for ATS and AI screening. Frame strategically, not tactically. Include terms like: Enterprise Data Strategy, Data Governance, Digital Transformation, AI/ML Strategy & Deployment, Revenue & Pricing Optimization, Forecasting & Demand Planning, Commercial Analytics, Organizational Transformation, P&L Influence, Board & C-Suite Advisory, Organizational Design, Change Management. Only include competencies supported by inventory evidence.",
    ),
  experience: z
    .array(ResumeExperienceSchema)
    .min(1)
    .max(5)
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

   **Paragraph 1 — Identity + Scale:**
   Open with a specific identity claim and the candidate's largest verifiable scale facts.
   "[Domain] executive who has built and led organizations of up to [largest team size] across [sectors]."
   Then anchor with the headline financial impact from the most recent role.
   DO NOT open with generic phrases: "Accomplished executive", "Results-driven leader", "Seasoned professional."
   Instead, lead with specifics from inventory.

   **Paragraph 2 — Transformation + Operating Model:**
   Show the PATTERN across the candidate's career — not a list of jobs, but a narrative arc.
   "Career defined by [pattern: building from zero, scaling, modernizing, etc.]."
   Trace 2-3 career milestones that show a consistent theme of transformation or growth.
   This paragraph answers: "What does this person DO when they arrive at a company?"

   **Paragraph 3 — Differentiator ("Why This Leader"):**
   State what makes this candidate rare or distinctive for THIS type of role.
   Position the combination of skills that is unusual at this level.
   E.g., "Distinctly technical for an executive of this level — [specific technical achievement] — while maintaining fluency in [business skill]."
   This paragraph answers: "Why should I call THIS person instead of 50 other VPs?"

   IMPORTANT: Every fact, number, and metric in the summary MUST come from the inventory.

3. **CORE COMPETENCIES** (core_competencies field)
   8-12 enterprise-level keywords displayed in a grid. These serve double duty:
   - ATS/AI screening optimization
   - Quick executive positioning signal
   Use STRATEGIC framing:
   GOOD: "Enterprise Data Strategy", "AI/ML Strategy & Deployment", "Revenue Optimization", "Board & C-Suite Advisory", "Organizational Design"
   BAD: "Python", "SQL", "Machine Learning", "Data Analysis", "Snowflake"
   Technical tools go in the skills section, not here.
   Do NOT duplicate items that will appear in skills.tools_and_platforms.

4. **EXPERIENCE** (experience array)
   Each role must include:
   - **scope_line**: One line of enterprise context — team headcount, business unit context, budget/investment if known. Use ONLY verifiable facts from inventory. Pipe-separated. E.g., "45-person organization | 3 business units | $8M board-approved investment"
   - **Bullet discipline**:
     - Start EVERY bullet with an action verb (Architected, Launched, Established, Developed, Created, Built, Designed, Partnered)
     - Max 2 lines per bullet — tighten any that run longer
     - The first 2 bullets under each role must carry 80% of the value (biggest financial impact, most relevant transformation)
     - Do NOT repeat scope_line content in the first bullet. The scope_line handles team size and org context — bullets should focus on WHAT was accomplished, not WHO was led.
   - **Bullet caps by role recency**:
     - Most recent 2 roles: 4-5 bullets each
     - Third role back: 3 bullets
     - Fourth+ role: 2 bullets (promotion trajectory + single top-impact result)
   - **No duplication**: If a fact appears in the Executive Summary, do NOT repeat it as the first bullet of a role. Use different inventory facts for bullets.
   - Target a clean 2-page document. 15-17 total bullets across all roles.

5. **TOOLS & PLATFORMS** (skills.tools_and_platforms)
   A single compact line of technical tools from inventory, filtered to JD relevance.
   Do NOT create a separate "Enterprise Capabilities" section if core_competencies already covers strategic keywords — this creates redundancy.
   When core_competencies is present, ONLY emit tools_and_platforms (skip enterprise_capabilities).

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
   - Use standard action-verb bullets ("Architected…", "Launched…", "Established…", "Developed…", "Built…", "Designed…")

6. **EVIDENCE POINTERS ARRAY**
   Produce one evidence_pointers entry per resume bullet. The claim_text must be the exact bullet text you emitted. The source_hash is the inventory bullet ID. The evidence_quote is the verbatim inventory text. Confidence >= 0.7 for all pointers.

7. **DEFENSIBILITY**
   Every claim must withstand the interview question: "Walk me through how you calculated that."
   - Use ranges from inventory if ranges exist; don't convert ranges to point estimates
   - Avoid marketing superlatives unless inventory explicitly supports them
   - If a metric is presented as a range in inventory, keep it as a range
   - Do NOT imply ownership of capabilities not documented in inventory

8. **ANTI-REDUNDANCY**
   - Do NOT create both "Core Competencies" and "Enterprise Capabilities" sections — pick one
   - Do NOT repeat team size in both scope_line and first bullet
   - Do NOT repeat summary claims as first bullets of roles
   - If information exists in the scope_line, do not restate it in bullet form

9. **OUTPUT**
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
3. Write professional_summary as a 2-3 PARAGRAPH executive narrative (paragraphs separated by \\n\\n):
   - Paragraph 1: Identity + Scale (who is this person, what's their biggest verifiable scope)
   - Paragraph 2: Transformation pattern (what do they DO when they arrive — build, modernize, scale?)
   - Paragraph 3: Differentiator (why THIS person for THIS role — the rare combination)
   Every fact must come from inventory. No generic openers.
4. Build core_competencies with 8-12 STRATEGIC enterprise keywords (not tool names). Include ATS terms from JD.
5. For each experience entry:
   a. Add a scope_line with enterprise context (team size, business units, budget) — pipe-separated
   b. First 2 bullets must carry 80% of the value (biggest impact, most JD-relevant)
   c. Do NOT repeat scope_line info in bullets. Scope_line handles org context, bullets handle achievements.
   d. Start every bullet with an action verb. Max 2 lines per bullet.
   e. Bullet caps: 4-5 for recent roles, 3 for third role, 2 for fourth+ role. Target 15-17 total bullets.
6. Do NOT create both core_competencies and enterprise_capabilities — this creates redundancy. When core_competencies is present, only emit tools_and_platforms.
7. For each JD requirement you CANNOT support, add a gap_note — do NOT fabricate content.
8. Include ats_keywords_used listing JD keywords you intentionally wove in.
9. Return ONLY the TailoredResume JSON.`;
}
