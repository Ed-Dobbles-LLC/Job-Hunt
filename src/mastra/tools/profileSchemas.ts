import { z } from "zod";

/* ── Bullet ─────────────────────────────────────────────────────── */
export const BulletSchema = z.object({
  id: z.string().describe('Sequential ID like "exp-001-b1"'),
  text: z.string().describe("Achievement or responsibility statement"),
  metrics: z.array(z.string()).optional().describe("Quantified metrics pulled from the bullet"),
  tools: z.array(z.string()).optional().describe("Technologies / tools mentioned"),
});

/* ── Experience entry ───────────────────────────────────────────── */
export const ExperienceEntrySchema = z.object({
  id: z.string().describe('Sequential ID like "exp-001"'),
  employer: z.string(),
  title: z.string(),
  start_date: z.string().describe('YYYY-MM format, e.g. "2021-03"'),
  end_date: z.string().describe('"present" or YYYY-MM'),
  location: z.string(),
  bullets: z.array(BulletSchema),
});

/* ── Education entry ────────────────────────────────────────────── */
export const EducationEntrySchema = z.object({
  id: z.string().describe('Sequential ID like "edu-001"'),
  institution: z.string(),
  degree: z.string(),
  year: z.string(),
});

/* ── Certification entry ────────────────────────────────────────── */
export const CertificationSchema = z.object({
  id: z.string().describe('Sequential ID like "cert-001"'),
  name: z.string(),
  year: z.string(),
});

/* ── Skills ─────────────────────────────────────────────────────── */
export const SkillsSchema = z.object({
  leadership: z.array(z.string()),
  technical: z.array(z.string()),
  data_science: z.array(z.string()),
  domains: z.array(z.string()),
});

/* ── Profile header ─────────────────────────────────────────────── */
export const ProfileSchema = z.object({
  name: z.string(),
  current_title: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  linkedin: z.string(),
  summary: z.string().describe("1-3 sentence professional summary"),
});

/* ── Full experience inventory (= experience_inventory.json) ───── */
export const ExperienceInventorySchema = z.object({
  profile: ProfileSchema,
  experience: z.array(ExperienceEntrySchema),
  education: z.array(EducationEntrySchema),
  skills: SkillsSchema,
  certifications: z.array(CertificationSchema),
});

export type ExperienceInventory = z.infer<typeof ExperienceInventorySchema>;

/* ── Gap tracking ───────────────────────────────────────────────── */
export const GapSchema = z.object({
  field: z.string().describe("Dotted path to the incomplete field, e.g. experience[0].bullets[2].metrics"),
  description: z.string().describe("Human-readable description of what is missing"),
  priority: z.enum(["high", "medium", "low"]),
});

export type Gap = z.infer<typeof GapSchema>;

/* ── Interview question ─────────────────────────────────────────── */
export const InterviewQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  targetField: z.string().describe("Which gap or field this question addresses"),
  priority: z.enum(["high", "medium", "low"]),
});

/* ── Q&A pair ───────────────────────────────────────────────────── */
export const QAPairSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  answer: z.string(),
});

/* ── Session status ─────────────────────────────────────────────── */
export const SessionStatus = z.enum([
  "parsing",
  "interviewing",
  "review",
  "finalized",
]);
