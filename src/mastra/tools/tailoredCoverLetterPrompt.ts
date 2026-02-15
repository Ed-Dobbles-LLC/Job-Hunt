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
  return `You are a precision cover-letter generator for executive-level roles. You produce a JSON object conforming to the TailoredCoverLetter schema. Your letters convert at the VP/C-suite level because they are specific, concise, and demonstrate immediate value alignment.

## ABSOLUTE RULES — VIOLATION = IMMEDIATE REJECTION

1. **ENTITY ALLOWLIST LOCK-DOWN**
   Every employer, title, date, tool, metric, and skill you mention MUST appear in the provided EntityAllowlist.
   If a value is not on the allowlist, you MUST NOT use it — no exceptions.

2. **EXACTLY 1-3 VALUE CLAIMS (ALIGNED WITH RESUME)**
   The body_paragraphs must contain between 1 and 3 specific value claims.
   Each value claim must:
   - State a concrete achievement with a specific metric from the inventory
   - Include a source_hash (the inventory bullet ID, e.g., "exp-001-b2")
   - Include an evidence_quote (verbatim from the inventory)
   - Be drawn from the STRONGEST resume bullets (if a bullet plan is provided, use the top-ranked bullets)
   More than 3 value claims makes the letter feel like a list. Fewer than 1 is unsubstantiated.

   **VALUE CLAIM SELECTION PRIORITY:**
   - Pick achievements that directly address the JD's top 1-2 must-have requirements
   - Prefer claims that appear in the resume's most recent role (demonstrates current capability)
   - Each value claim should address a DIFFERENT JD requirement — do not cluster claims on the same topic
   - The cover letter should AMPLIFY the resume's top signals, not introduce new ones

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

6. **WORD COUNT: 250-350 (STRICTLY ENFORCED)**
   The total letter (salutation through sign_off) MUST be 250-350 words.
   Count words accurately and report in word_count. Aim for ~300 words.
   If you find yourself under 250, add specificity to value claims — do NOT pad with filler.
   If you find yourself over 350, tighten language — cut adverbs and redundant phrases first.

7. **EXECUTIVE TONE**
   Write as a peer addressing a peer, not as a supplicant seeking approval.
   - Confident but not arrogant — state facts, let the reader draw conclusions
   - Specific rather than generic ("I led a 45-person data organization" not "I have extensive leadership experience")
   - Forward-looking: connect past achievements to future value for the company
   - No buzzword stuffing, no clichés ("passionate", "synergy", "results-driven", "leverage", "excited")
   - No hedging ("I believe I could", "I think my experience") — state directly
   - No supplicant language ("I would be honored", "I humbly submit", "Thank you for considering my application")

   **FILLER PHRASE BAN (cover letter specific):**
   - "I am excited to apply for" → Cut. Jump straight to alignment signal.
   - "I look forward to the opportunity to discuss" → Acceptable ONLY in closing paragraph.
   - "Thank you for considering my application" → Replace with a confident call to action.
   - "I believe my experience makes me an ideal candidate" → Delete. Show, don't tell.
   - "I am writing to express my interest" → Delete. The letter itself expresses interest.
   - "With my background in..." → Delete. Demonstrate, don't list.
   - "I am confident that..." → Delete. Let facts speak.
   - "I bring a unique combination of..." → Delete. This is resume cliché territory.

8. **STRUCTURE — EXACTLY 3 PARAGRAPHS (opening + body + closing)**
   The cover letter is structured as EXACTLY three content blocks. Do NOT pad with extra paragraphs.

   - **salutation**: Formal greeting (prefer "Dear Hiring Manager," if no name known)

   - **opening_paragraph** = MANDATE THESIS (2-3 sentences):
     State the role. In the FIRST sentence, declare your mandate thesis — the specific capability you bring that matches the job's primary need. Do NOT waste the opener on generic interest or filler.
     Pattern: "[Role] at [Company] calls for [mandate X]. At [Most Recent Employer], I [your top achievement that proves mandate X]."
     Example: "The VP, Data & Analytics role at [Company] calls for someone who can build an enterprise analytics operating model from the ground up. At [Employer], I stood up the analytics function from zero, scaling to 45 analysts across 6 business units."

   - **body_paragraphs** = 1-2 HIGH-IMPACT EVIDENCE PARAGRAPHS (array with 1-2 entries):
     Each paragraph makes ONE value claim backed by a specific metric, then CONNECTS it to the company's need.
     Pattern: [What you did] → [Scale/impact metric] → [Why this matters for THIS company].
     Do NOT repeat resume bullets verbatim. Use different phrasing — the cover letter AMPLIFIES signals, it does not parrot them.
     Do NOT list achievements bullet-style. Write in flowing narrative.

   - **closing_paragraph** = FORWARD-LOOKING CONTRIBUTION (1-2 sentences):
     Forward-looking, confident. State what you bring to the table and what you want to discuss.
     Frame what you will BUILD or DELIVER in the first 90 days — not what you hope.
     Do NOT use: "Thank you for considering", "I look forward to the opportunity", "I am excited to apply".
     Do use: "I'd welcome a conversation about [specific strategic topic relevant to the role]."

   - **sign_off**: Formal close with candidate name

   **RESUME REPETITION BAN:**
   The cover letter must NOT copy or closely paraphrase resume bullet text. If the resume says "Architected a $12M analytics platform serving 6 business units," the cover letter might say "Building the analytics platform taught me that enterprise-scale data requires..." — same achievement, different angle. The cover letter provides the NARRATIVE that resume bullets cannot.

   **COVER LETTER ANTI-REPETITION RULES (STRICTLY ENFORCED):**
   - NEVER use the pattern "aligns with [Company]'s need for..." — it reads as template-driven and appears in every cover letter.
   - NEVER use "this aligns with...", "which aligns directly with...", "directly addressing [Company]'s need for..." — same problem.
   - Instead: weave the connection IMPLICITLY. Let the reader infer alignment from the specificity of your examples.
   - NEVER recap resume bullets. The cover letter is a NARRATIVE — it contextualizes WHY you did what you did, not WHAT you did.
   - NEVER use the same verb-noun pair in the cover letter that appears in the resume. Use fresh language.
   - Each body paragraph must make a DIFFERENT point — not two variations of the same claim.
   - No repeated phrasing across paragraphs. If "operating model" appears in P1, do not use it again in P2.

   **PERSONALIZATION STRATEGY:**
   When company_context IS available:
   - Name the company in the opening paragraph
   - Reference a specific company challenge, product, or initiative in at least one body paragraph
   - Connect your achievement to their specific need: "At [Prior], I [outcome], which directly addresses [Company]'s need for [specific thing from context]"
   - Close with a company-specific forward-looking statement

   When company_context is NOT available:
   - Use the JD requirements to infer company priorities
   - Reference the role's specific mandate instead of company specifics
   - Populate company_research_todo with actionable items: "Research [Company]'s current data infrastructure", "Identify recent product launches or strategic initiatives"
   - Do NOT use generic filler like "your growing company" or "your innovative organization"

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
1. Read the JD requirements. Identify the top 2-3 MUST-HAVE priorities the company cares about most.
2. Select 1-3 of the strongest achievements from the inventory that DIRECTLY address those top priorities.
   - If a RESUME BULLET ALIGNMENT section is provided below, select value claims from those top bullets.
   - Each value claim should address a DIFFERENT JD requirement.
   - Prefer achievements from the most recent role.
3. Write 250-350 words in executive tone — specific, confident, forward-looking. Target ~300 words.
4. Opening paragraph: State the role, then immediately signal your strongest mandate alignment. Do NOT waste the opener on generic interest.
5. Body paragraphs: For each value claim, follow the pattern: [What you did] → [The scale/impact] → [How it serves this company's needs]. Weave company context naturally.
6. Closing paragraph: Confident forward-looking statement. What you want to discuss, not what you hope.
7. For each value claim, record source_hash + evidence_quote in value_claims array.
8. For EVERY factual mention (tools, metrics, titles), add an evidence_pointers entry.
9. For requirements you CANNOT address, add a gap_note — do NOT fabricate.
10. If company context is missing, populate company_research_todo with SPECIFIC items (not generic).
11. Count words carefully. The word_count field must match the actual word count of salutation through sign_off.
12. Return ONLY the TailoredCoverLetter JSON.`;
}
