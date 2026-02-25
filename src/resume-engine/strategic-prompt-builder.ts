/**
 * Strategic Prompt Builder — Phase 5: Constraint Inversion
 *
 * Replaces the 437-line constraint-heavy system prompt with a shorter,
 * strategy-driven prompt that leverages the Positioning Brief from Stage 2b.
 *
 * Architecture change:
 *   OLD: 50+ banned phrases, 11 absolute rules, rigid structural templates
 *        → LLM spends attention on compliance instead of craft
 *   NEW: Strategic guidance from positioning brief + truth boundaries
 *        → LLM writes freely, post-verification catches issues
 *
 * The truth boundaries (claims ledger, entity allowlist, no fabrication)
 * remain in the generation prompt because they are non-negotiable safety
 * rails. But stylistic constraints (word limits, bullet caps, phrase bans,
 * tone rules) move to post-verification where they can be checked
 * deterministically without burning LLM attention.
 *
 * This prompt is used when Claude is the provider. The original prompt
 * remains available as a fallback for GPT-4o.
 */

import type { PositioningBrief } from "./stage2b-positioning-strategy/strategist";
import type { CompanyResearch } from "./stage2c-company-research/researcher";
import type { MandateProfile } from "./stage2-mandate-classifier/classifier";

// ── Strategic System Prompt ─────────────────────────────────────

/**
 * Build the strategic system prompt for Claude-based generation.
 *
 * This is ~150 lines vs the original ~437 lines. The reduction comes from:
 * 1. Removing stylistic constraints that post-verification handles
 * 2. Removing banned phrase lists (deterministic check handles this)
 * 3. Removing bullet formatting rules (layout governor handles this)
 * 4. Adding the positioning brief as strategic guidance
 * 5. Trusting Claude to write at executive level without 50 guardrails
 */
export function buildStrategicResumeSystemPrompt(
  brief: PositioningBrief,
  mandate: MandateProfile,
  companyResearch?: CompanyResearch,
): string {
  const sections: string[] = [];

  // ── Identity & Purpose ──────────────────────────────────────────
  sections.push(`You are a retained executive search resume writer. You produce resumes that get C-suite candidates past the 30-second recruiter screen and into interview conversations.

Your output is a JSON object conforming to the TailoredResume schema.`);

  // ── Strategic Brief (the core innovation) ───────────────────────
  sections.push(`## POSITIONING STRATEGY (your guiding brief)

**Narrative Angle:** ${brief.narrative_angle}

**Lead With:** ${brief.lead_with.join("; ")}

**Story Arc:** ${brief.story_arc}

**What Makes This Candidate Rare:** ${brief.rare_combination}

**Summary First Sentence Thesis:** ${brief.summary_thesis}

**De-emphasize:** ${brief.de_emphasize.join("; ")}

**Cover Letter Hook:** ${brief.cover_letter_hook}

${brief.positioning_warnings.length > 0 ? `**Watch Out For:** ${brief.positioning_warnings.join("; ")}` : ""}

This brief is your North Star. Every decision — which bullets to lead with, how to frame the summary, what to emphasize in the cover letter — should serve this positioning strategy.`);

  // ── Company Context (if available) ──────────────────────────────
  if (companyResearch && companyResearch.confidence > 0.2) {
    sections.push(`## COMPANY CONTEXT
${companyResearch.industry ? `Industry: ${companyResearch.industry}` : ""}
${companyResearch.likely_challenges?.length ? `Their Likely Challenges: ${companyResearch.likely_challenges.join("; ")}` : ""}
${companyResearch.positioning_hooks?.length ? `Positioning Hooks: ${companyResearch.positioning_hooks.join("; ")}` : ""}
${brief.company_alignment ? `\nAlignment Strategy: ${brief.company_alignment}` : ""}

Use this context to make the resume and cover letter feel targeted to THIS company, not generic.`);
  }

  // ── Mandate Context ─────────────────────────────────────────────
  sections.push(`## MANDATE
Primary: ${mandate.primary_mandate.replace(/_/g, " ")}
${mandate.secondary_mandates?.length ? `Secondary: ${mandate.secondary_mandates.join(", ").replace(/_/g, " ")}` : ""}
Seniority: ${mandate.seniority_level}

The first sentence of the summary MUST reflect this mandate. Not a generic identity claim.`);

  // ── Truth Boundaries (non-negotiable — stays in generation prompt) ─
  sections.push(`## TRUTH BOUNDARIES — NON-NEGOTIABLE

1. **Entity Allowlist Lock-Down**: Every employer, title, date, metric, tool, and certification you emit MUST appear in the provided EntityAllowlist. If it's not on the list, don't use it.

2. **Evidence on Every Bullet**: Every bullet needs source_hash (inventory bullet ID) and evidence_quote (verbatim from inventory). No unsourced bullets.

3. **Claims Ledger Traceability**: Every bullet must include a populated claim_ids array referencing Claims Ledger IDs that back each factual claim.

4. **Numbers Are Sacred**: Copy every number, dollar amount, percentage exactly from inventory. No rounding, approximating, combining, or inflating.

5. **Reject, Don't Fabricate**: If a JD requirement can't be supported, add a gap_note. Never invent experience, metrics, employers, tools, or certifications.

6. **No Ownership Inflation**: Don't upgrade "contributed to" → "led" or "team member" → "owner". Use the level of ownership documented in inventory.

7. **Evidence Pointers (MANDATORY)**: Generate one entry in the evidence_pointers array per resume bullet. Each pointer must contain: claim_text (the exact bullet text you emitted), source_hash (inventory bullet ID, e.g. "exp-001-b2"), evidence_quote (verbatim from the inventory bullet), confidence (float 0.7-1.0). An empty evidence_pointers array is a schema violation.`);

  // ── Resume Architecture (streamlined) ───────────────────────────
  sections.push(`## RESUME STRUCTURE

1. **Executive Headline** — Match the target role level AND the candidate's actual level. Don't inflate.

2. **Executive Summary** — 2-3 short paragraphs, max 4 lines:
   - P1: Mandate-anchored opener (use the thesis from the brief) + scale
   - P2: Career transformation pattern (the story arc from the brief)
   - P3: What makes them rare (the rare_combination from the brief)

3. **Core Competencies** — 8-12 strategic enterprise keywords. Not tool names.

4. **Experience** — Reverse chronological. Each role: scope_line + bullets.
   - Start every bullet with a strong action verb
   - Follow Action → Scale → Outcome format
   - First 2 bullets per role should serve the positioning strategy
   - Include claim_ids for every bullet

5. **Tools & Platforms** — One compact line.

6. **Education & Certifications** — As-is from inventory.

Target: 2 full pages. 16-19 total bullets across all roles.`);

  // ── Writing Quality ─────────────────────────────────────────────
  sections.push(`## WRITING QUALITY

Write like a senior leader briefing a board. Every bullet should pass: "Could a recruiter verify this in a 30-second call?"

Prefer specific over generic. "$12M" over "significant investment." "45-person organization" over "large team." "Snowflake" over "modern data platform."

Each section should introduce new information — don't recycle claims across summary, competencies, and bullets.

Return ONLY the JSON object.`);

  return sections.join("\n\n");
}

// ── Strategic Cover Letter Prompt ───────────────────────────────

/**
 * Build the strategic system prompt for cover letter generation.
 * Much shorter than the original — trusts Claude to write well
 * with strategic guidance instead of 30 rules.
 */
export function buildStrategicCoverLetterSystemPrompt(
  brief: PositioningBrief,
  mandate: MandateProfile,
  companyResearch?: CompanyResearch,
): string {
  const sections: string[] = [];

  sections.push(`You are a precision cover-letter generator for executive-level roles. You produce a JSON object conforming to the TailoredCoverLetter schema.

Your letters convert because they are specific, concise, and demonstrate immediate value alignment. They read like a senior peer writing to another senior peer — not a job applicant pleading for consideration.`);

  sections.push(`## POSITIONING STRATEGY

**Opening Hook:** ${brief.cover_letter_hook}
**Narrative Angle:** ${brief.narrative_angle}
**What Makes Them Rare:** ${brief.rare_combination}
${brief.company_alignment ? `**Company Alignment:** ${brief.company_alignment}` : ""}`);

  if (companyResearch && companyResearch.confidence > 0.2) {
    sections.push(`## COMPANY CONTEXT
${companyResearch.likely_challenges?.length ? `Challenges: ${companyResearch.likely_challenges.join("; ")}` : ""}
${companyResearch.positioning_hooks?.length ? `Hooks: ${companyResearch.positioning_hooks.join("; ")}` : ""}

Weave company-specific context naturally. Don't force alignment language.`);
  }

  sections.push(`## STRUCTURE
- P1 (Opening): Lead with the hook from the brief. Demonstrate you understand their mandate.
- P2 (Transformation): Your strongest transformation example with a real metric.
- P3 (Scale): Enterprise scale and cross-functional impact.
- P4 (Close): Forward-looking value proposition. What you will build/deliver.
- Target: 300-400 words total.

## TRUTH RULES
- Every metric MUST come from the inventory
- Include 1-3 value_claims with source_hash and evidence_quote
- If a requirement can't be addressed, add it to gap_notes
- No supplicant language ("I hope", "thank you for considering", "I would be honored")

Return ONLY the JSON object.`);

  return sections.join("\n\n");
}

/**
 * Build the strategic user prompt that includes the positioning brief context.
 * This replaces the standard buildResumeUserPrompt when Claude + positioning brief are available.
 */
export function buildStrategicResumeUserPrompt(
  inventory: Record<string, any>,
  allowlist: Record<string, any>,
  requirements: Record<string, any>,
  targetRole: string,
  targetCompany: string,
  claimsLedgerSummary?: string,
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

${claimsLedgerSummary ? `## CLAIMS LEDGER SUMMARY\n${claimsLedgerSummary}\n` : ""}
## INSTRUCTIONS
Follow the positioning strategy in the system prompt. Every decision should serve that strategy.
1. Use the summary thesis from the brief as your first sentence starting point
2. Lead with the roles/achievements the brief identified
3. De-emphasize what the brief says to de-emphasize
4. Every bullet needs claim_ids, source_hash, evidence_quote
5. Return ONLY the TailoredResume JSON.`;
}
