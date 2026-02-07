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
  bullets: z
    .array(ResumeBulletSchema)
    .min(1)
    .max(6)
    .describe("3-6 tailored bullets per role, each with evidence"),
});

export const TailoredResumeSchema = z.object({
  target_role: z
    .string()
    .describe("The job title being applied for"),
  target_company: z
    .string()
    .describe("The company being applied to"),
  professional_summary: z
    .string()
    .describe(
      "3-4 sentence summary tailored to the target role. Only use facts from inventory.",
    ),
  experience: z
    .array(ResumeExperienceSchema)
    .min(1)
    .max(5)
    .describe("Work experience entries, ordered by relevance then recency"),
  skills: z.object({
    technical: z
      .array(z.string())
      .describe("Technical skills from inventory that match the JD"),
    leadership: z
      .array(z.string())
      .describe("Leadership skills from inventory that match the JD"),
    data_science: z
      .array(z.string())
      .optional()
      .describe("Data science skills from inventory that match the JD"),
  }),
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
  return `You are a precision resume-tailoring engine. You produce a JSON object conforming to the TailoredResume schema.

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

5. **ATS-FRIENDLY FORMAT**
   - No tables, no columns, no graphics, no icons
   - Plain sections: Summary, Experience, Skills, Education, Certifications
   - Use standard action-verb bullets ("Led…", "Drove…", "Built…")

6. **SECTION ORDERING**
   - professional_summary: 3-4 sentences tailored to the target role
   - experience: ordered by RELEVANCE to the JD first, then by recency. Include 3-6 bullets per role.
   - skills: split into technical, leadership, data_science — only include skills that appear in BOTH the inventory AND the JD requirements
   - education: as-is from inventory
   - certifications: as-is from inventory (only if relevant to JD)

7. **EVIDENCE POINTERS ARRAY**
   Produce one evidence_pointers entry per resume bullet. The claim_text must be the exact bullet text you emitted. The source_hash is the inventory bullet ID. The evidence_quote is the verbatim inventory text. Confidence ≥ 0.7 for all pointers.

8. **OUTPUT**
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
1. Read the JD requirements carefully.
2. Select the most relevant experience bullets from the inventory.
3. Tailor bullet wording to emphasize JD-relevant impact, but keep ALL entities and metrics verbatim from inventory.
4. For each requirement you CANNOT support, add a gap_note — do NOT fabricate content.
5. Include ats_keywords_used listing JD keywords you intentionally wove in.
6. Return ONLY the TailoredResume JSON.`;
}
