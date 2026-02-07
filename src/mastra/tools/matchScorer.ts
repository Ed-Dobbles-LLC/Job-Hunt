import type { JDRequirements, RequirementItem } from "./extractJDRequirementsTool";

export interface InventoryBullet {
  id: string;
  text: string;
  metrics?: string[];
  tools?: string[];
}

export interface InventoryExperience {
  id: string;
  employer: string;
  title: string;
  start_date: string;
  end_date: string;
  location: string;
  bullets: InventoryBullet[];
}

export interface ExperienceInventory {
  profile: {
    name: string;
    current_title: string;
    location: string;
    summary: string;
  };
  experience: InventoryExperience[];
  education: { id: string; institution: string; degree: string; year: string }[];
  skills: {
    leadership: string[];
    technical: string[];
    data_science: string[];
    domains: string[];
  };
  certifications: { id: string; name: string; year: string }[];
}

export interface MatchedRequirement {
  requirement: string;
  confidence: number;
  matched: boolean;
  match_strength: number;
  evidence_id: string;
  evidence_quote: string;
  evidence_source: string;
}

export interface UnmatchedRequirement {
  requirement: string;
  confidence: number;
  gap_severity: "critical" | "moderate" | "minor";
}

export interface CategoryScore {
  score: number;
  max_score: number;
  pct: number;
  matched: MatchedRequirement[];
  unmatched: UnmatchedRequirement[];
}

export interface SupportingBullet {
  bullet_id: string;
  text: string;
  employer: string;
  title: string;
  matched_requirements: string[];
  relevance_score: number;
}

export interface MatchExplanation {
  sentence: string;
  evidence_id: string;
  evidence_quote: string;
  category: string;
}

export interface ATSCoverage {
  covered: string[];
  uncovered: string[];
  coverage_pct: number;
}

export interface MatchReport {
  total_score: number;
  sub_scores: {
    must_have: CategoryScore;
    nice_to_have: CategoryScore;
    leadership_scope: CategoryScore;
    domain_context: CategoryScore;
    tech_keywords: CategoryScore;
  };
  top_bullets: SupportingBullet[];
  match_explanations: MatchExplanation[];
  ats_coverage: ATSCoverage;
  red_flag_assessment: {
    flags: { text: string; severity: "high" | "medium" | "low" }[];
    total_risk_score: number;
  };
  meta: {
    requirements_total: number;
    requirements_matched: number;
    match_rate: number;
    weighted_confidence: number;
  };
}

const CATEGORY_WEIGHTS = {
  must_have: 35,
  nice_to_have: 15,
  leadership_scope: 15,
  domain_context: 10,
  tech_keywords: 25,
} as const;

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((w) => w.length > 2),
  );
}

function tokenOverlap(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }
  return overlap / Math.min(tokensA.size, tokensB.size);
}

function containsPhrase(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

function extractYears(text: string): number | null {
  const match = text.match(/(\d+)\+?\s*(?:years?|yrs?)/i);
  return match ? parseInt(match[1]) : null;
}

function computeExperienceYears(inventory: ExperienceInventory): number {
  if (inventory.experience.length === 0) return 0;
  const sorted = [...inventory.experience].sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime(),
  );
  const earliest = new Date(sorted[0].start_date);
  const latest = sorted[sorted.length - 1].end_date === "present"
    ? new Date()
    : new Date(sorted[sorted.length - 1].end_date);
  return Math.round((latest.getTime() - earliest.getTime()) / (365.25 * 24 * 3600 * 1000));
}

function getAllBullets(inventory: ExperienceInventory): {
  bullet: InventoryBullet;
  employer: string;
  title: string;
  sourcePath: string;
}[] {
  const results: { bullet: InventoryBullet; employer: string; title: string; sourcePath: string }[] = [];
  for (let i = 0; i < inventory.experience.length; i++) {
    const exp = inventory.experience[i];
    for (let j = 0; j < exp.bullets.length; j++) {
      results.push({
        bullet: exp.bullets[j],
        employer: exp.employer,
        title: exp.title,
        sourcePath: `experience[${i}].bullets[${j}]`,
      });
    }
  }
  return results;
}

function getAllSkills(inventory: ExperienceInventory): string[] {
  const skills: string[] = [];
  if (inventory.skills) {
    if (inventory.skills.technical) skills.push(...inventory.skills.technical);
    if (inventory.skills.data_science) skills.push(...inventory.skills.data_science);
    if (inventory.skills.leadership) skills.push(...inventory.skills.leadership);
    if (inventory.skills.domains) skills.push(...inventory.skills.domains);
  }
  return skills;
}

function getAllTools(inventory: ExperienceInventory): Set<string> {
  const tools = new Set<string>();
  for (const exp of inventory.experience) {
    for (const bullet of exp.bullets) {
      if (bullet.tools) {
        for (const tool of bullet.tools) {
          tools.add(tool.toLowerCase());
        }
      }
    }
  }
  if (inventory.skills?.technical) {
    for (const skill of inventory.skills.technical) {
      tools.add(skill.toLowerCase());
    }
  }
  return tools;
}

interface BulletMatch {
  bullet: InventoryBullet;
  employer: string;
  title: string;
  sourcePath: string;
  score: number;
}

function findBestBulletMatch(
  requirementText: string,
  allBullets: ReturnType<typeof getAllBullets>,
  allSkills: string[],
  allTools: Set<string>,
): BulletMatch | null {
  let bestMatch: BulletMatch | null = null;
  let bestScore = 0;

  const reqNorm = normalizeText(requirementText);
  const reqTokens = tokenize(requirementText);

  for (const { bullet, employer, title, sourcePath } of allBullets) {
    let score = 0;
    const bulletNorm = normalizeText(bullet.text);
    const bulletTools = (bullet.tools || []).map((t) => t.toLowerCase());
    const bulletMetrics = (bullet.metrics || []).map((m) => m.toLowerCase());

    const overlap = tokenOverlap(requirementText, bullet.text);
    score += overlap * 50;

    for (const tool of bulletTools) {
      if (reqNorm.includes(tool)) score += 15;
    }

    for (const metric of bulletMetrics) {
      const metricTokens = tokenize(metric);
      for (const t of metricTokens) {
        if (reqTokens.has(t)) {
          score += 5;
          break;
        }
      }
    }

    if (containsPhrase(bullet.text, requirementText)) score += 30;
    if (containsPhrase(requirementText, bullet.text.substring(0, 40))) score += 10;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { bullet, employer, title, sourcePath, score };
    }
  }

  return bestMatch;
}

function matchTechKeyword(
  keyword: string,
  allTools: Set<string>,
  allSkills: string[],
  inventory: ExperienceInventory,
): { matched: boolean; evidence_id: string; evidence_quote: string; evidence_source: string; strength: number } {
  const kwLower = keyword.toLowerCase().trim();

  if (allTools.has(kwLower)) {
    const skillList = inventory.skills?.technical || [];
    const idx = skillList.findIndex((s) => s.toLowerCase() === kwLower);
    if (idx >= 0) {
      return {
        matched: true,
        evidence_id: `skills-technical-${idx}`,
        evidence_quote: skillList[idx],
        evidence_source: `skills.technical[${idx}]`,
        strength: 1.0,
      };
    }
  }

  for (const skill of allSkills) {
    if (normalizeText(skill).includes(normalizeText(keyword)) ||
        normalizeText(keyword).includes(normalizeText(skill))) {
      const category = Object.entries(inventory.skills).find(([, arr]) =>
        arr.some((s: string) => s === skill)
      );
      return {
        matched: true,
        evidence_id: category ? `skills-${category[0]}` : "skills",
        evidence_quote: skill,
        evidence_source: category ? `skills.${category[0]}` : "skills",
        strength: 0.9,
      };
    }
  }

  for (const tool of allTools) {
    if (tool.includes(kwLower) || kwLower.includes(tool)) {
      return {
        matched: true,
        evidence_id: "tools-match",
        evidence_quote: tool,
        evidence_source: "experience.tools",
        strength: 0.8,
      };
    }
  }

  for (const cert of (inventory.certifications || [])) {
    if (normalizeText(cert.name).includes(kwLower)) {
      return {
        matched: true,
        evidence_id: cert.id,
        evidence_quote: cert.name,
        evidence_source: `certifications`,
        strength: 0.9,
      };
    }
  }

  return { matched: false, evidence_id: "", evidence_quote: "", evidence_source: "", strength: 0 };
}

function matchRequirementItem(
  item: RequirementItem,
  inventory: ExperienceInventory,
  allBullets: ReturnType<typeof getAllBullets>,
  allSkills: string[],
  allTools: Set<string>,
  category: string,
): MatchedRequirement | UnmatchedRequirement {
  const reqText = item.text;

  if (category === "tech_keywords") {
    const techMatch = matchTechKeyword(reqText, allTools, allSkills, inventory);
    if (techMatch.matched) {
      return {
        requirement: reqText,
        confidence: item.confidence,
        matched: true,
        match_strength: techMatch.strength,
        evidence_id: techMatch.evidence_id,
        evidence_quote: techMatch.evidence_quote,
        evidence_source: techMatch.evidence_source,
      };
    }
    return {
      requirement: reqText,
      confidence: item.confidence,
      gap_severity: item.confidence >= 0.9 ? "critical" : item.confidence >= 0.7 ? "moderate" : "minor",
    };
  }

  const yearsRequired = extractYears(reqText);
  if (yearsRequired !== null) {
    const yearsHave = computeExperienceYears(inventory);
    if (yearsHave >= yearsRequired) {
      return {
        requirement: reqText,
        confidence: item.confidence,
        matched: true,
        match_strength: Math.min(1, yearsHave / yearsRequired),
        evidence_id: inventory.experience[0]?.id || "exp-001",
        evidence_quote: `${yearsHave} years of experience (${inventory.experience[0]?.start_date} to present)`,
        evidence_source: "experience",
      };
    }
  }

  const bulletMatch = findBestBulletMatch(reqText, allBullets, allSkills, allTools);
  if (bulletMatch && bulletMatch.score >= 15) {
    const strength = Math.min(1, bulletMatch.score / 60);
    return {
      requirement: reqText,
      confidence: item.confidence,
      matched: true,
      match_strength: strength,
      evidence_id: bulletMatch.bullet.id,
      evidence_quote: bulletMatch.bullet.text,
      evidence_source: bulletMatch.sourcePath,
    };
  }

  const skillMatch = allSkills.find((s) =>
    containsPhrase(reqText, s) || containsPhrase(s, reqText),
  );
  if (skillMatch) {
    const category = Object.entries(inventory.skills).find(([, arr]) =>
      arr.some((s: string) => s === skillMatch),
    );
    return {
      requirement: reqText,
      confidence: item.confidence,
      matched: true,
      match_strength: 0.7,
      evidence_id: category ? `skills-${category[0]}` : "skills",
      evidence_quote: skillMatch,
      evidence_source: category ? `skills.${category[0]}` : "skills",
    };
  }

  if (category === "domain_context") {
    const domains = inventory.skills?.domains || [];
    const domainMatch = domains.find((d) =>
      normalizeText(reqText).includes(normalizeText(d)) ||
      normalizeText(d).includes(normalizeText(reqText)),
    );
    if (domainMatch) {
      return {
        requirement: reqText,
        confidence: item.confidence,
        matched: true,
        match_strength: 0.85,
        evidence_id: "skills-domains",
        evidence_quote: domainMatch,
        evidence_source: "skills.domains",
      };
    }
  }

  if (category === "leadership_scope") {
    const leadershipSkills = inventory.skills?.leadership || [];
    const leaderMatch = leadershipSkills.find((s) =>
      tokenOverlap(reqText, s) > 0.3,
    );
    if (leaderMatch) {
      return {
        requirement: reqText,
        confidence: item.confidence,
        matched: true,
        match_strength: 0.7,
        evidence_id: "skills-leadership",
        evidence_quote: leaderMatch,
        evidence_source: "skills.leadership",
      };
    }
  }

  for (const edu of (inventory.education || [])) {
    if (containsPhrase(reqText, "degree") || containsPhrase(reqText, "bachelor") ||
        containsPhrase(reqText, "master") || containsPhrase(reqText, "mba") ||
        containsPhrase(reqText, "phd")) {
      if (tokenOverlap(reqText, edu.degree) > 0.2) {
        return {
          requirement: reqText,
          confidence: item.confidence,
          matched: true,
          match_strength: 0.8,
          evidence_id: edu.id,
          evidence_quote: `${edu.degree} — ${edu.institution} (${edu.year})`,
          evidence_source: "education",
        };
      }
    }
  }

  for (const cert of (inventory.certifications || [])) {
    if (tokenOverlap(reqText, cert.name) > 0.3) {
      return {
        requirement: reqText,
        confidence: item.confidence,
        matched: true,
        match_strength: 0.85,
        evidence_id: cert.id,
        evidence_quote: cert.name,
        evidence_source: "certifications",
      };
    }
  }

  const gapSeverity =
    category === "must_have" && item.confidence >= 0.9
      ? "critical"
      : category === "must_have" && item.confidence >= 0.7
        ? "moderate"
        : category === "nice_to_have"
          ? "minor"
          : item.confidence >= 0.8
            ? "moderate"
            : "minor";

  return {
    requirement: reqText,
    confidence: item.confidence,
    gap_severity: gapSeverity,
  };
}

function isMatched(result: MatchedRequirement | UnmatchedRequirement): result is MatchedRequirement {
  return "matched" in result && result.matched === true;
}

function scoreCategory(
  items: RequirementItem[],
  inventory: ExperienceInventory,
  allBullets: ReturnType<typeof getAllBullets>,
  allSkills: string[],
  allTools: Set<string>,
  categoryKey: string,
  maxScore: number,
): CategoryScore {
  if (items.length === 0) {
    return { score: maxScore, max_score: maxScore, pct: 100, matched: [], unmatched: [] };
  }

  const matched: MatchedRequirement[] = [];
  const unmatched: UnmatchedRequirement[] = [];

  for (const item of items) {
    const result = matchRequirementItem(item, inventory, allBullets, allSkills, allTools, categoryKey);
    if (isMatched(result)) {
      matched.push(result);
    } else {
      unmatched.push(result);
    }
  }

  let weightedMatch = 0;
  let weightedTotal = 0;
  for (const item of items) {
    const weight = item.confidence;
    weightedTotal += weight;
    const m = matched.find((mr) => mr.requirement === item.text);
    if (m) {
      weightedMatch += weight * m.match_strength;
    }
  }

  const pct = weightedTotal > 0 ? Math.round((weightedMatch / weightedTotal) * 100) : 0;
  const score = Math.round((pct / 100) * maxScore);

  return { score, max_score: maxScore, pct, matched, unmatched };
}

function buildTopBullets(
  subScores: Record<string, CategoryScore>,
  inventory: ExperienceInventory,
): SupportingBullet[] {
  const bulletScoreMap = new Map<
    string,
    { bullet: InventoryBullet; employer: string; title: string; requirements: string[]; totalRelevance: number }
  >();

  for (const [, catScore] of Object.entries(subScores)) {
    for (const m of catScore.matched) {
      if (!m.evidence_id || !m.evidence_id.startsWith("exp-")) continue;

      const existing = bulletScoreMap.get(m.evidence_id);
      if (existing) {
        existing.requirements.push(m.requirement);
        existing.totalRelevance += m.match_strength;
      } else {
        let bulletData: InventoryBullet | undefined;
        let employer = "";
        let title = "";
        for (const exp of inventory.experience) {
          const found = exp.bullets.find((b) => b.id === m.evidence_id);
          if (found) {
            bulletData = found;
            employer = exp.employer;
            title = exp.title;
            break;
          }
        }
        if (bulletData) {
          bulletScoreMap.set(m.evidence_id, {
            bullet: bulletData,
            employer,
            title,
            requirements: [m.requirement],
            totalRelevance: m.match_strength,
          });
        }
      }
    }
  }

  const bullets: SupportingBullet[] = [];
  for (const [bulletId, data] of bulletScoreMap) {
    bullets.push({
      bullet_id: bulletId,
      text: data.bullet.text,
      employer: data.employer,
      title: data.title,
      matched_requirements: data.requirements,
      relevance_score: Math.round((data.totalRelevance / data.requirements.length) * 100) / 100,
    });
  }

  bullets.sort((a, b) => {
    const byReqs = b.matched_requirements.length - a.matched_requirements.length;
    if (byReqs !== 0) return byReqs;
    return b.relevance_score - a.relevance_score;
  });

  return bullets.slice(0, 10);
}

function buildExplanations(
  subScores: Record<string, CategoryScore>,
  inventory: ExperienceInventory,
): MatchExplanation[] {
  const explanations: MatchExplanation[] = [];

  const topMatches: { m: MatchedRequirement; cat: string }[] = [];
  for (const [cat, catScore] of Object.entries(subScores)) {
    for (const m of catScore.matched) {
      topMatches.push({ m, cat });
    }
  }
  topMatches.sort((a, b) => b.m.match_strength - a.m.match_strength);

  for (const { m, cat } of topMatches.slice(0, 10)) {
    let sentence: string;
    switch (cat) {
      case "must_have":
        sentence = `Meets the requirement "${m.requirement}" — demonstrated through: "${m.evidence_quote}" [${m.evidence_id}]`;
        break;
      case "nice_to_have":
        sentence = `Has preferred qualification "${m.requirement}" — evidenced by: "${m.evidence_quote}" [${m.evidence_id}]`;
        break;
      case "leadership_scope":
        sentence = `Leadership experience aligns: "${m.requirement}" — supported by: "${m.evidence_quote}" [${m.evidence_id}]`;
        break;
      case "domain_context":
        sentence = `Domain relevance: "${m.requirement}" — backed by experience in: "${m.evidence_quote}" [${m.evidence_id}]`;
        break;
      case "tech_keywords":
        sentence = `Technical match: "${m.requirement}" — confirmed in: "${m.evidence_quote}" [${m.evidence_id}]`;
        break;
      default:
        sentence = `Matches "${m.requirement}" via "${m.evidence_quote}" [${m.evidence_id}]`;
    }
    explanations.push({
      sentence,
      evidence_id: m.evidence_id,
      evidence_quote: m.evidence_quote,
      category: cat,
    });
  }

  return explanations;
}

function assessATSCoverage(
  atsKeywords: RequirementItem[],
  inventory: ExperienceInventory,
): ATSCoverage {
  const allText = [
    inventory.profile?.summary || "",
    ...inventory.experience.flatMap((e) => [e.title, ...e.bullets.map((b) => b.text)]),
    ...(inventory.skills?.technical || []),
    ...(inventory.skills?.data_science || []),
    ...(inventory.skills?.leadership || []),
    ...(inventory.skills?.domains || []),
    ...(inventory.certifications || []).map((c) => c.name),
    ...(inventory.education || []).map((e) => e.degree),
  ]
    .join(" ")
    .toLowerCase();

  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const kw of atsKeywords) {
    if (containsPhrase(allText, kw.text)) {
      covered.push(kw.text);
    } else {
      uncovered.push(kw.text);
    }
  }

  const total = atsKeywords.length;
  const coverage_pct = total > 0 ? Math.round((covered.length / total) * 100) : 100;

  return { covered, uncovered, coverage_pct };
}

function assessRedFlags(
  redFlags: RequirementItem[],
): { flags: { text: string; severity: "high" | "medium" | "low" }[]; total_risk_score: number } {
  const flags: { text: string; severity: "high" | "medium" | "low" }[] = [];
  let totalRisk = 0;

  for (const rf of redFlags) {
    const severity: "high" | "medium" | "low" =
      rf.confidence >= 0.8 ? "high" : rf.confidence >= 0.6 ? "medium" : "low";
    flags.push({ text: rf.text, severity });
    totalRisk += rf.confidence * (severity === "high" ? 3 : severity === "medium" ? 2 : 1);
  }

  return { flags, total_risk_score: Math.round(totalRisk * 10) / 10 };
}

export function computeMatchReport(
  requirements: JDRequirements,
  inventory: ExperienceInventory,
): MatchReport {
  const allBullets = getAllBullets(inventory);
  const allSkills = getAllSkills(inventory);
  const allTools = getAllTools(inventory);

  const mustHaveScore = scoreCategory(
    requirements.must_have, inventory, allBullets, allSkills, allTools,
    "must_have", CATEGORY_WEIGHTS.must_have,
  );

  const niceToHaveScore = scoreCategory(
    requirements.nice_to_have, inventory, allBullets, allSkills, allTools,
    "nice_to_have", CATEGORY_WEIGHTS.nice_to_have,
  );

  const leadershipScore = scoreCategory(
    requirements.leadership_scope, inventory, allBullets, allSkills, allTools,
    "leadership_scope", CATEGORY_WEIGHTS.leadership_scope,
  );

  const domainScore = scoreCategory(
    requirements.domain_context, inventory, allBullets, allSkills, allTools,
    "domain_context", CATEGORY_WEIGHTS.domain_context,
  );

  const techScore = scoreCategory(
    requirements.tech_keywords, inventory, allBullets, allSkills, allTools,
    "tech_keywords", CATEGORY_WEIGHTS.tech_keywords,
  );

  const subScores = {
    must_have: mustHaveScore,
    nice_to_have: niceToHaveScore,
    leadership_scope: leadershipScore,
    domain_context: domainScore,
    tech_keywords: techScore,
  };

  const totalScore = mustHaveScore.score + niceToHaveScore.score +
    leadershipScore.score + domainScore.score + techScore.score;

  const topBullets = buildTopBullets(subScores, inventory);
  const matchExplanations = buildExplanations(subScores, inventory);
  const atsCoverage = assessATSCoverage(requirements.keywords_for_ats, inventory);
  const redFlagAssessment = assessRedFlags(requirements.red_flags);

  let totalReqs = 0;
  let totalMatched = 0;
  let weightedConf = 0;
  let weightedConfTotal = 0;

  for (const [, catScore] of Object.entries(subScores)) {
    totalReqs += catScore.matched.length + catScore.unmatched.length;
    totalMatched += catScore.matched.length;
    for (const m of catScore.matched) {
      weightedConf += m.match_strength * m.confidence;
      weightedConfTotal += m.confidence;
    }
  }

  return {
    total_score: totalScore,
    sub_scores: subScores,
    top_bullets: topBullets,
    match_explanations: matchExplanations,
    ats_coverage: atsCoverage,
    red_flag_assessment: redFlagAssessment,
    meta: {
      requirements_total: totalReqs,
      requirements_matched: totalMatched,
      match_rate: totalReqs > 0 ? Math.round((totalMatched / totalReqs) * 100) : 0,
      weighted_confidence: weightedConfTotal > 0
        ? Math.round((weightedConf / weightedConfTotal) * 1000) / 1000
        : 0,
    },
  };
}

export function prettyPrintMatchReport(report: MatchReport, jobLabel?: string): string {
  const lines: string[] = [];
  const divider = "═".repeat(70);
  const thinDiv = "─".repeat(70);

  lines.push(divider);
  lines.push(`MATCH REPORT${jobLabel ? `: ${jobLabel}` : ""}`);
  lines.push(divider);
  lines.push(`Total Score: ${report.total_score}/100`);
  lines.push(`Match Rate: ${report.meta.match_rate}% (${report.meta.requirements_matched}/${report.meta.requirements_total} requirements)`);
  lines.push(`ATS Coverage: ${report.ats_coverage.coverage_pct}%`);
  lines.push("");

  lines.push("SUB-SCORES");
  lines.push(thinDiv);
  for (const [key, cs] of Object.entries(report.sub_scores)) {
    const bar = `${cs.score}/${cs.max_score} (${cs.pct}%)`;
    const matched = cs.matched.length;
    const total = matched + cs.unmatched.length;
    lines.push(`  ${key.padEnd(22)} ${bar.padStart(16)}  [${matched}/${total} matched]`);
  }

  if (report.top_bullets.length > 0) {
    lines.push("");
    lines.push("TOP SUPPORTING BULLETS");
    lines.push(thinDiv);
    for (const b of report.top_bullets) {
      lines.push(`  [${b.bullet_id}] ${b.text.substring(0, 80)}...`);
      lines.push(`    ↳ ${b.employer} | Matches ${b.matched_requirements.length} requirement(s)`);
    }
  }

  if (report.match_explanations.length > 0) {
    lines.push("");
    lines.push("WHY THIS MATCHES");
    lines.push(thinDiv);
    for (const ex of report.match_explanations) {
      lines.push(`  • ${ex.sentence}`);
    }
  }

  if (report.ats_coverage.uncovered.length > 0) {
    lines.push("");
    lines.push("ATS GAPS (keywords NOT in inventory)");
    lines.push(thinDiv);
    for (const kw of report.ats_coverage.uncovered) {
      lines.push(`  ✗ ${kw}`);
    }
  }

  if (report.red_flag_assessment.flags.length > 0) {
    lines.push("");
    lines.push(`RED FLAGS (risk score: ${report.red_flag_assessment.total_risk_score})`);
    lines.push(thinDiv);
    for (const rf of report.red_flag_assessment.flags) {
      const icon = rf.severity === "high" ? "🔴" : rf.severity === "medium" ? "🟡" : "🟢";
      lines.push(`  ${icon} [${rf.severity}] ${rf.text}`);
    }
  }

  lines.push(divider);
  return lines.join("\n");
}
