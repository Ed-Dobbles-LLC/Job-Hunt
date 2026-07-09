/**
 * clayLeadMapper — tolerant field extraction for Clay webhook payloads.
 *
 * Why this exists: Clay's "Send to HTTP API" posts whatever key names the
 * user typed as column headers in the Clay table ("Company Name", "Job Title",
 * nested wrappers, etc.). The original handler bound to a fixed set of
 * snake_case keys, so every lead with display-style headers was rejected as
 * "no company or title" (observed in production 2026-07-09: 100% rejection).
 *
 * Strategy: normalize every incoming key (lowercase, strip non-alphanumerics),
 * unwrap one level of common wrapper objects, then match against canonical
 * key sets. "Company Name" -> "companyname" -> matches. Self-diagnosing: the
 * caller can log rawKeys whenever a lead still fails validation.
 */

export interface MappedClayLead {
  company: string;
  title: string;
  location: string;
  postingUrl: string;
  jdText: string;
  compensation: string;
  remoteHybrid: string;
  clayRowId: string;
  companyDescription: string;
  industry: string;
  companySize: string;
  funding: string;
  contactName: string;
  contactTitle: string;
  contactLinkedin: string;
  contactEmail: string;
  /** Original (pre-normalization) key names — for diagnostics on failure. */
  rawKeys: string[];
}

const WRAPPER_KEYS = ["fields", "data", "record", "row", "payload", "lead"];

/** lowercase + strip everything that isn't a-z0-9 */
function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Unwrap one level of a common wrapper object, merging outer keys over inner. */
function unwrap(raw: any): Record<string, any> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  for (const w of WRAPPER_KEYS) {
    const inner = raw[w];
    if (
      inner &&
      typeof inner === "object" &&
      !Array.isArray(inner) &&
      Object.keys(raw).length <= 4 // wrapper + a couple of metadata keys at most
    ) {
      return { ...inner, ...raw };
    }
  }
  return raw;
}

function buildNormalizedIndex(obj: Record<string, any>): Record<string, any> {
  const idx: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = normKey(k);
    // first writer wins — top-level keys were merged over wrapper keys already
    if (!(nk in idx)) idx[nk] = v;
  }
  return idx;
}

function pick(idx: Record<string, any>, candidates: string[]): string {
  for (const c of candidates) {
    const v = idx[c];
    if (v !== null && v !== undefined) {
      const s = String(v).trim();
      if (s !== "" && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined") {
        return s;
      }
    }
  }
  return "";
}

// Canonical candidate sets — all pre-normalized (lowercase, alphanumeric only).
const K = {
  company: ["companyname", "company", "organization", "organizationname", "employer", "employername", "org", "hiringcompany", "companycleaned"],
  title: ["jobtitle", "title", "role", "position", "positiontitle", "jobname", "roletitle", "job"],
  location: ["location", "joblocation", "city", "locationname", "jobcity"],
  postingUrl: ["joburl", "postingurl", "url", "linkedinurl", "jobposturl", "link", "applyurl", "jobposting", "jobpostingurl", "joblink"],
  jdText: ["jobdescription", "description", "jdtext", "jobdetails", "descriptiontext", "fulldescription", "jd"],
  compensation: ["compensation", "salary", "salaryrange", "pay", "payrange", "comp"],
  remoteHybrid: ["remotehybrid", "remote", "workmodel", "worktype", "workarrangement", "locationtype"],
  clayRowId: ["clayrowid", "rowid", "recordid", "id"],
  companyDescription: ["companydescription", "aboutcompany", "companyabout", "companysummary"],
  industry: ["industry", "companyindustry", "sector"],
  companySize: ["companysize", "employeecount", "employees", "headcount", "size"],
  funding: ["funding", "totalfunding", "lastfunding", "fundingstage"],
  contactName: ["contactname", "hiringcontact", "hiringmanager", "recruitername", "contact"],
  contactTitle: ["contacttitle", "hiringcontacttitle", "recruitertitle"],
  contactLinkedin: ["contactlinkedin", "contactlinkedinurl", "recruiterlinkedin", "hiringmanagerlinkedin"],
  contactEmail: ["contactemail", "recruiteremail", "hiringmanageremail", "email"],
};

export function mapClayLead(raw: any): MappedClayLead {
  const unwrapped = unwrap(raw);
  const idx = buildNormalizedIndex(unwrapped);
  return {
    company: pick(idx, K.company),
    title: pick(idx, K.title),
    location: pick(idx, K.location),
    postingUrl: pick(idx, K.postingUrl),
    jdText: pick(idx, K.jdText),
    compensation: pick(idx, K.compensation),
    remoteHybrid: pick(idx, K.remoteHybrid),
    clayRowId: pick(idx, K.clayRowId),
    companyDescription: pick(idx, K.companyDescription),
    industry: pick(idx, K.industry),
    companySize: pick(idx, K.companySize),
    funding: pick(idx, K.funding),
    contactName: pick(idx, K.contactName),
    contactTitle: pick(idx, K.contactTitle),
    contactLinkedin: pick(idx, K.contactLinkedin),
    contactEmail: pick(idx, K.contactEmail),
    rawKeys: raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [],
  };
}
