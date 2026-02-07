import { z } from "zod";
import { EvidencePointerSchema, GapNoteSchema } from "./tailoredResumePrompt";

export const ValueClaimSchema = z.object({
  claim_sentence: z
    .string()
    .describe(
      "The exact sentence from the cover letter body that makes a quantified or specific value claim",
    ),
  source_hash: z
    .string()
    .describe("Inventory bullet ID backing this claim (e.g., exp-001-b2)"),
  evidence_quote: z
    .string()
    .describe("Verbatim quote from the inventory bullet"),
  metric_used: z
    .string()
    .optional()
    .describe("The specific metric cited, if any (e.g., '$12M', '38%')"),
});
export type ValueClaim = z.infer<typeof ValueClaimSchema>;

export const TailoredCoverLetterSchema = z.object({
  target_role: z
    .string()
    .describe("The job title being applied for"),
  target_company: z
    .string()
    .describe("The company being applied to"),
  salutation: z
    .string()
    .describe(
      "Opening line (e.g., 'Dear Hiring Manager,' or 'Dear [Name],')",
    ),
  opening_paragraph: z
    .string()
    .describe(
      "1-2 sentences: state the role, express genuine interest, and hint at your strongest alignment",
    ),
  body_paragraphs: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe(
      "1-3 body paragraphs containing value claims. Total letter must be 250-350 words.",
    ),
  closing_paragraph: z
    .string()
    .describe(
      "1-2 sentences: forward-looking statement, call to action, gratitude",
    ),
  sign_off: z.string().describe("e.g., 'Sincerely,' followed by name"),
  value_claims: z
    .array(ValueClaimSchema)
    .min(1)
    .max(3)
    .describe(
      "Exactly 1-3 specific value claims made in the body. Each MUST have source_hash and evidence_quote.",
    ),
  evidence_pointers: z
    .array(EvidencePointerSchema)
    .describe(
      "Evidence pointers for ALL factual claims in the letter (metrics, tools, achievements)",
    ),
  gap_notes: z
    .array(GapNoteSchema)
    .describe(
      "JD requirements that could NOT be addressed in the letter. Honest rejection instead of fabrication.",
    ),
  company_research_todo: z
    .array(z.string())
    .describe(
      "Items the user should research about the company before sending. Populated when company-specific context is missing or insufficient. Examples: 'Confirm company tech stack', 'Research recent product launches'.",
    ),
  word_count: z
    .number()
    .describe("Total word count of the letter (salutation through sign_off)"),
});
export type TailoredCoverLetter = z.infer<typeof TailoredCoverLetterSchema>;

export function buildCoverLetterSystemPrompt(): string {
  return `You are a precision cover-letter generator. You produce a JSON object conforming to the TailoredCoverLetter schema.

## ABSOLUTE RULES — VIOLATION = IMMEDIATE REJECTION

1. **ENTITY ALLOWLIST LOCK-DOWN**
   Every employer, title, date, tool, metric, and skill you mention MUST appear in the provided EntityAllowlist.
   If a value is not on the allowlist, you MUST NOT use it — no exceptions.

2. **EXACTLY 1-3 VALUE CLAIMS**
   The body_paragraphs must contain between 1 and 3 specific value claims.
   Each value claim must:
   - State a concrete achievement with a specific metric from the inventory
   - Include a source_hash (the inventory bullet ID, e.g., "exp-001-b2")
   - Include an evidence_quote (verbatim from the inventory)
   More than 3 value claims makes the letter feel like a list. Fewer than 1 is unsubstantiated.

3. **NEVER INVENT METRICS**
   Every dollar amount, percentage, team size, or quantified result MUST be copied verbatim from the inventory.
   Do NOT round, approximate, combine, or extrapolate numbers.
   If the letter needs a metric you don't have, write the sentence WITHOUT a metric rather than inventing one.

4. **REJECT, DON'T FABRICATE**
   If a JD requirement cannot be addressed with inventory evidence, add a gap_note entry.
   NEVER invent experience, achievements, or company-specific claims to fill a gap.

5. **COMPANY RESEARCH TODO**
   If you lack company-specific information (mission, culture, recent news, product details), populate company_research_todo with specific items the user should research before sending.
   Do NOT fabricate company facts. Generic statements like "your innovative company" are acceptable ONLY if you have no specific info. Prefer adding a todo over making something up.

6. **WORD COUNT: 250-350**
   The total letter (salutation through sign_off) MUST be 250-350 words.
   Count words and report in word_count. Aim for the sweet spot of ~300 words.

7. **EXECUTIVE TONE**
   - Confident but not arrogant
   - Specific rather than generic ("I led a 45-person data organization" not "I have extensive leadership experience")
   - Forward-looking: connect past achievements to future value for the company
   - No buzzword stuffing, no clichés ("passionate", "synergy", "results-driven")
   - Write as a peer addressing a peer, not as a supplicant

8. **STRUCTURE**
   - salutation: formal greeting
   - opening_paragraph: 1-2 sentences — role, interest, strongest alignment signal
   - body_paragraphs: 1-3 paragraphs with value claims woven naturally into narrative
   - closing_paragraph: 1-2 sentences — forward-looking, call to action
   - sign_off: formal close with candidate name

9. **EVIDENCE POINTERS**
   Produce an evidence_pointers entry for EVERY factual claim in the entire letter (not just value claims).
   This includes mentions of tools, team sizes, metrics, job titles at previous companies, etc.
   Confidence must be ≥ 0.7 for all pointers.

10. **OUTPUT**
    Return ONLY the JSON object. No markdown fences, no commentary, no explanation.`;
}

export function buildCoverLetterUserPrompt(
  inventory: Record<string, any>,
  allowlist: Record<string, any>,
  requirements: Record<string, any>,
  targetRole: string,
  targetCompany: string,
  companyContext?: string,
): string {
  const companySection = companyContext
    ? `## COMPANY CONTEXT (use to personalize; verify before sending)
${companyContext}`
    : `## COMPANY CONTEXT
No company-specific information available. Populate company_research_todo with items to research.`;

  return `Generate a TailoredCoverLetter JSON for the following application.

## TARGET ROLE
Title: ${targetRole}
Company: ${targetCompany}

${companySection}

## JOB REQUIREMENTS
${JSON.stringify(requirements, null, 2)}

## EXPERIENCE INVENTORY (your ONLY source of truth for factual claims)
${JSON.stringify(inventory, null, 2)}

## ENTITY ALLOWLIST (every named entity you emit must appear here)
${JSON.stringify(allowlist, null, 2)}

## INSTRUCTIONS
1. Read the JD requirements to understand what the company values.
2. Select 1-3 of the strongest achievements from the inventory that directly address the top JD priorities.
3. Write 250-350 words in executive tone — specific, confident, forward-looking.
4. For each value claim, record source_hash + evidence_quote in value_claims array.
5. For EVERY factual mention (tools, metrics, titles), add an evidence_pointers entry.
6. For requirements you CANNOT address, add a gap_note — do NOT fabricate.
7. If company context is missing, populate company_research_todo.
8. Return ONLY the TailoredCoverLetter JSON.`;
}
