import * as fs from "fs";
import { workspacePath } from "./paths";

export interface FactAtom {
  id: string;
  type: "employer" | "title" | "date" | "metric" | "tool" | "degree" | "certification" | "bullet" | "skill" | "location";
  value: string;
  normalized: string;
  parentId?: string;
  sourceQuote?: string;
}

export interface FactRegistry {
  version: string;
  extractedAt: string;
  atoms: FactAtom[];
  employers: Set<string>;
  titles: Set<string>;
  dates: Set<string>;
  metrics: Set<string>;
  tools: Set<string>;
  degrees: Set<string>;
  certifications: Set<string>;
  bulletIds: Set<string>;
  bulletTexts: Map<string, string>;
  allText: string;
}

export interface SerializableFactRegistry {
  version: string;
  extractedAt: string;
  atoms: FactAtom[];
  employers: string[];
  titles: string[];
  dates: string[];
  metrics: string[];
  tools: string[];
  degrees: string[];
  certifications: string[];
  bulletIds: string[];
  bulletTexts: Record<string, string>;
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

export function extractFactRegistry(inventory?: any): FactRegistry {
  if (!inventory) {
    const inventoryPath = workspacePath("experience_inventory.json");
    inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf-8"));
  }

  const atoms: FactAtom[] = [];
  const employers = new Set<string>();
  const titles = new Set<string>();
  const dates = new Set<string>();
  const metrics = new Set<string>();
  const tools = new Set<string>();
  const degrees = new Set<string>();
  const certifications = new Set<string>();
  const bulletIds = new Set<string>();
  const bulletTexts = new Map<string, string>();

  if (inventory.profile) {
    const p = inventory.profile;
    if (p.current_title) {
      titles.add(normalize(p.current_title));
      atoms.push({ id: "profile-title", type: "title", value: p.current_title, normalized: normalize(p.current_title) });
    }
    if (p.location) {
      atoms.push({ id: "profile-location", type: "location", value: p.location, normalized: normalize(p.location) });
    }
  }

  for (const exp of inventory.experience || []) {
    employers.add(normalize(exp.employer));
    atoms.push({ id: exp.id, type: "employer", value: exp.employer, normalized: normalize(exp.employer) });

    titles.add(normalize(exp.title));
    atoms.push({ id: `${exp.id}-title`, type: "title", value: exp.title, normalized: normalize(exp.title), parentId: exp.id });

    if (exp.start_date) {
      dates.add(exp.start_date);
      atoms.push({ id: `${exp.id}-start`, type: "date", value: exp.start_date, normalized: exp.start_date, parentId: exp.id });
    }
    if (exp.end_date) {
      dates.add(exp.end_date);
      atoms.push({ id: `${exp.id}-end`, type: "date", value: exp.end_date, normalized: exp.end_date, parentId: exp.id });
    }

    if (exp.location) {
      atoms.push({ id: `${exp.id}-loc`, type: "location", value: exp.location, normalized: normalize(exp.location), parentId: exp.id });
    }

    for (const bullet of exp.bullets || []) {
      bulletIds.add(bullet.id);
      bulletTexts.set(bullet.id, bullet.text);
      atoms.push({ id: bullet.id, type: "bullet", value: bullet.text, normalized: normalize(bullet.text), parentId: exp.id, sourceQuote: bullet.text });

      for (const m of bullet.metrics || []) {
        metrics.add(normalize(m));
        atoms.push({ id: `${bullet.id}-metric-${normalize(m)}`, type: "metric", value: m, normalized: normalize(m), parentId: bullet.id, sourceQuote: bullet.text });
      }

      for (const t of bullet.tools || []) {
        tools.add(normalize(t));
        atoms.push({ id: `${bullet.id}-tool-${normalize(t)}`, type: "tool", value: t, normalized: normalize(t), parentId: bullet.id, sourceQuote: bullet.text });
      }
    }
  }

  for (const edu of inventory.education || []) {
    degrees.add(normalize(edu.degree));
    atoms.push({ id: edu.id, type: "degree", value: edu.degree, normalized: normalize(edu.degree) });

    if (edu.institution) {
      employers.add(normalize(edu.institution));
      atoms.push({ id: `${edu.id}-inst`, type: "employer", value: edu.institution, normalized: normalize(edu.institution), parentId: edu.id });
    }

    if (edu.year) {
      dates.add(edu.year);
      atoms.push({ id: `${edu.id}-year`, type: "date", value: edu.year, normalized: edu.year, parentId: edu.id });
    }
  }

  for (const cert of inventory.certifications || []) {
    const certName = typeof cert === "string" ? cert : cert.name;
    const certId = typeof cert === "string" ? `cert-${normalize(cert)}` : cert.id;
    certifications.add(normalize(certName));
    atoms.push({ id: certId, type: "certification", value: certName, normalized: normalize(certName) });

    if (typeof cert === "object" && cert.year) {
      dates.add(cert.year);
      atoms.push({ id: `${certId}-year`, type: "date", value: cert.year, normalized: cert.year, parentId: certId });
    }
  }

  const skillCategories = inventory.skills || {};
  for (const [category, skillList] of Object.entries(skillCategories)) {
    for (const skill of (skillList as string[]) || []) {
      tools.add(normalize(skill));
      atoms.push({ id: `skill-${category}-${normalize(skill)}`, type: "tool", value: skill, normalized: normalize(skill) });
    }
  }

  const allText = JSON.stringify(inventory).toLowerCase();

  return {
    version: `v1-${Date.now()}`,
    extractedAt: new Date().toISOString(),
    atoms,
    employers,
    titles,
    dates,
    metrics,
    tools,
    degrees,
    certifications,
    bulletIds,
    bulletTexts,
    allText,
  };
}

export function serializeRegistry(reg: FactRegistry): SerializableFactRegistry {
  const bulletTexts: Record<string, string> = {};
  reg.bulletTexts.forEach((v, k) => { bulletTexts[k] = v; });

  return {
    version: reg.version,
    extractedAt: reg.extractedAt,
    atoms: reg.atoms,
    employers: [...reg.employers],
    titles: [...reg.titles],
    dates: [...reg.dates],
    metrics: [...reg.metrics],
    tools: [...reg.tools],
    degrees: [...reg.degrees],
    certifications: [...reg.certifications],
    bulletIds: [...reg.bulletIds],
    bulletTexts,
  };
}

export function deserializeRegistry(data: SerializableFactRegistry): FactRegistry {
  return {
    ...data,
    employers: new Set(data.employers),
    titles: new Set(data.titles),
    dates: new Set(data.dates),
    metrics: new Set(data.metrics),
    tools: new Set(data.tools),
    degrees: new Set(data.degrees),
    certifications: new Set(data.certifications),
    bulletIds: new Set(data.bulletIds),
    bulletTexts: new Map(Object.entries(data.bulletTexts)),
    allText: JSON.stringify(data).toLowerCase(),
  };
}
