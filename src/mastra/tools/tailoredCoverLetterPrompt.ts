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
      "P1 — Mandate Understanding: 2-3 sentences. Open with understanding of the role's mandate, then immediately demonstrate alignment with your strongest proof point. Do NOT open with generic interest.",
    ),
  body_paragraphs: z
    .array(z.string())
    .describe(
      "P2-P3 (or P2-P4): 2-3 body paragraphs (min 2, max 3). P2 = relevant transformation example with metric. P3 = enterprise scale and cross-functional leadership. Optional P4 = additional differentiation. Total letter must be 300-400 words.",
    ),
  closing_paragraph: z
    .string()
    .describe(
      "Final paragraph — Forward-Looking Value Proposition: 1-2 sentences. State what you will build/deliver, confident call to action. No supplicant language.",
    ),
  sign_off: z.string().describe("e.g., 'Sincerely,' followed by name"),
  value_claims: z
    .array(ValueClaimSchema)
    .describe(
      "1-3 specific value claims made in the body (min 1, max 3). Each MUST have source_hash and evidence_quote.",
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
    .describe("Total word count of the letter (salutation through sign_off). Target 300-400 words."),
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

6. **WORD COUNT: 300-400 (STRICTLY ENFORCED)**
   The total letter (salutation through sign_off) MUST be 300-400 words.
   Count words accurately and report in word_count. Aim for ~350 words.
   If you find yourself under 300, add specificity to value claims — do NOT pad with filler.
   If you find yourself over 400, tighten language — cut adverbs and redundant phrases first.

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

8. **STRUCTURE — 4-5 PARAGRAPHS (opening + 2-3 body + closing)**
   The cover letter is structured as 4-5 content blocks. Each paragraph has a distinct role.

   - **salutation**: Formal greeting (prefer "Dear Hiring Manager," if no name known)

   - **opening_paragraph** = P1: MANDATE UNDERSTANDING (2-3 sentences):
     Open with understanding of the role's mandate — demonstrate you grasp what the company actually needs.
     In the FIRST sentence, declare the mandate thesis — the specific capability this role requires.
     Then immediately prove alignment with your strongest proof point.
     Do NOT waste the opener on generic interest or filler ("I am excited to apply").
     Pattern: "[Role] at [Company] calls for [mandate X]. At [Most Recent Employer], I [proof of mandate X]."
     Example: "The VP, Data & Analytics role at [Company] calls for someone who can build an enterprise analytics operating model from the ground up. At [Employer], I stood up the analytics function from zero, scaling to 45 analysts across 6 business units."

   - **body_paragraphs[0]** = P2: RELEVANT TRANSFORMATION EXAMPLE (3-4 sentences):
     Present your most relevant transformation achievement — what you changed, at what scale, with what result.
     ONE value claim backed by a specific metric from the inventory.
     Pattern: [Context of the challenge] → [What you built/changed] → [Quantified impact].
     This paragraph proves you have DONE what they need — not that you COULD do it.
     Do NOT repeat resume bullets verbatim. Provide narrative context the resume cannot.

   - **body_paragraphs[1]** = P3: ENTERPRISE SCALE & CROSS-FUNCTIONAL LEADERSHIP (3-4 sentences):
     Demonstrate enterprise-scale impact and cross-functional leadership.
     Focus on: team size, organizational scope, stakeholder breadth, budget responsibility.
     ONE additional value claim backed by a different metric from the inventory.
     This paragraph proves you operate at the right LEVEL — not just the right domain.
     Pattern: [Scale of responsibility] → [Cross-functional impact] → [Why this translates to their need].

   - **body_paragraphs[2]** = P4 (OPTIONAL): ADDITIONAL DIFFERENTIATION:
     Only include if there is a third strong differentiator that addresses a distinct JD requirement.
     Do NOT include just to add length. Better to have 4 tight paragraphs than 5 padded ones.

   - **closing_paragraph** = FORWARD-LOOKING VALUE PROPOSITION (1-2 sentences):
     Forward-looking, confident. State what you will BUILD or DELIVER — not what you hope.
     Frame the first 90 days or the strategic initiative you want to discuss.
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

10. **POSITIONING ENFORCEMENT (FINAL CHECK BEFORE OUTPUT)**
    Before emitting the JSON, verify these 4 positioning rules:

    a. **MANDATE THESIS IN OPENING**: The opening_paragraph FIRST SENTENCE must declare the strategic
       capability matching the job's primary mandate. NOT "I am excited to apply" — that is generic
       interest. Pattern: "[Role] at [Company] calls for [mandate X]. At [Employer], I [proof]."

    b. **NO SUPPLICANT CLOSING**: The closing_paragraph must NOT use "Thank you for considering",
       "I look forward to the opportunity", "I hope to hear from you", or "I humbly submit".
       Instead: state what strategic conversation you want to have. Frame what you will BUILD.

    c. **VALUE CLAIMS MUST DIFFER FROM RESUME**: Each value claim must use DIFFERENT phrasing
       from the resume bullets. Same achievement, different angle. The cover letter provides
       NARRATIVE CONTEXT that resume bullets cannot.

    d. **NO CORPORATE CLICHÉS**: Remove "leveraged", "actionable insights", "unique combination",
       "thought leader", "fostering a culture of", "at the forefront of", "drove synergies".

11. **OUTPUT**
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
2. Select 2-3 of the strongest achievements from the inventory that DIRECTLY address those top priorities.
   - If a RESUME BULLET ALIGNMENT section is provided below, select value claims from those top bullets.
   - Each value claim should address a DIFFERENT JD requirement.
   - Prefer achievements from the most recent role.
3. Write 300-400 words in executive tone — specific, confident, forward-looking. Target ~350 words.
4. P1 (opening_paragraph): Open with understanding of the mandate. State the role, then immediately prove alignment with your strongest proof point. No generic interest openers.
5. P2 (body_paragraphs[0]): Present your most relevant TRANSFORMATION example — what you changed, at what scale, with what quantified result. Provide narrative context, not resume bullet repetition.
6. P3 (body_paragraphs[1]): Demonstrate ENTERPRISE SCALE and cross-functional leadership — team size, organizational scope, stakeholder breadth. Different metric from P2.
7. P4 (closing_paragraph): Forward-looking value proposition. What you will BUILD in the first 90 days. Confident call to action — no supplicant language.
8. Optionally include body_paragraphs[2] ONLY if there is a third strong differentiator addressing a distinct JD requirement.
9. For each value claim, record source_hash + evidence_quote in value_claims array.
10. For EVERY factual mention (tools, metrics, titles), add an evidence_pointers entry.
11. For requirements you CANNOT address, add a gap_note — do NOT fabricate.
12. If company context is missing, populate company_research_todo with SPECIFIC items (not generic).
13. Count words carefully. The word_count field must match the actual word count of salutation through sign_off.
14. Return ONLY the TailoredCoverLetter JSON.`;
}
