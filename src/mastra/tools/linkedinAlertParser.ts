/**
 * Deterministic parser for LinkedIn job-alert emails.
 *
 * Why this exists: Step 1 used to concatenate every fetched email body into a
 * single agent call. LinkedIn alert bodies run 40-190KB and are almost entirely
 * tracking-URL query string, so 50 emails produced ~225K tokens against a
 * 128K-token model and the run died in 7 seconds.
 *
 * These emails are machine-readable. Parsing them by regex is faster, free, and
 * cannot hallucinate a company name. The agent stays available as a fallback for
 * senders whose shape we do not recognize (see parseAlertEmails().unmatched).
 *
 * Two shapes are observed in the wild — do not assume one rigid format:
 *   Shape A (single job):  subject "{Title} at {Company}", body carries a full JD.
 *   Shape B (digest):      subject "\"{keyword}\": {Company} - {Title} posted on M/D/YY",
 *                          body repeats
 *                            Title / Company / City, ST / [Top applicant] /
 *                            View job: https://www.linkedin.com/comm/jobs/view/{id}/?...
 *                          separated by dashed rules.
 *
 * Bodies usually arrive as text/plain (newlines intact). When only text/html is
 * present the Gmail client collapses all whitespace, so line structure is gone —
 * the subject-derived path below covers that case.
 */

export interface RawEmailLike {
  id: string;
  subject: string;
  from: string;
  date?: string;
  body: string;
}

export interface ParsedAlertJob {
  linkedinJobId: string;
  title: string;
  company: string;
  location: string;
  compensation: string;
  posting_url: string;
  source: string;
  source_message_id: string;
}

export interface ParseAlertsResult {
  jobs: ParsedAlertJob[];
  /** Emails the deterministic parser could not read — hand these to the agent. */
  unmatched: RawEmailLike[];
  stats: {
    emailsIn: number;
    emailsParsed: number;
    emailsUnmatched: number;
    jobsFound: number;
    duplicatesInBatch: number;
  };
}

/** Senders whose alert shape this parser understands. */
const KNOWN_ALERT_SENDERS =
  /(?:jobs-noreply|jobalerts-noreply|job-alerts-noreply)@linkedin\.com/i;

export function isKnownAlertSender(from: string): boolean {
  return KNOWN_ALERT_SENDERS.test(from || "");
}

/** Any LinkedIn job-view URL, /jobs/view/{id} or /comm/jobs/view/{id}. */
const JOB_VIEW_URL =
  /https?:\/\/[^\s<>"')]*linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)[^\s<>"')]*/gi;

/**
 * Drop the query string. A single "View job:" URL runs ~1,100 characters of
 * which ~40 carry meaning — everything after "?" is tracking.
 */
export function stripTracking(url: string): string {
  const jobId = url.match(/\/jobs\/view\/(\d+)/)?.[1];
  if (jobId) return `https://www.linkedin.com/jobs/view/${jobId}`;
  return url.split("?")[0];
}

/** Footer / chrome lines that carry nothing. */
const NOISE_LINE =
  /^(?:view job:?|see all jobs|unsubscribe|manage job alerts.*|help|you are receiving.*|this email was intended for.*|©.*|linkedin( and the linkedin logo)?.*|·|-{3,}|_{3,}|={3,})$/i;

/**
 * Lines that decorate the posting above them rather than naming it.
 * Remote/hybrid annotations are kept and folded back into the location.
 */
const MODIFIER_LINE =
  /^(?:remote(?: ok)?|hybrid|on-?site|actively recruiting|be an early applicant|easy apply|promoted|top applicant|\d+ (?:school )?alum\w*|\d+\+? connections?|viewed|new)$/i;

const WORKPLACE_MODIFIER = /^(?:remote(?: ok)?|hybrid|on-?site)$/i;

const LOCATION_LINE =
  /^(?:[A-Za-z][A-Za-z .'\/-]*,\s*(?:[A-Z]{2}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)*)|United States|Remote|United States \(Remote\)|[A-Za-z .'\/-]+ \((?:Remote|Hybrid|On-site)\))$/;

const SALARY =
  /\$\s?\d[\d,.]*\s?[KkMm]?(?:\s*(?:-|–|to)\s*\$?\s?\d[\d,.]*\s?[KkMm]?)?(?:\s*(?:\/|per\s)\s?(?:year|yr|hour|hr))?/;

function cleanCompany(s: string): string {
  return s
    .replace(/\s*·.*$/, "")
    .replace(/\s*\|\s*LinkedIn\s*$/i, "")
    .trim();
}

function extractSalary(text: string): string {
  const m = text.match(SALARY);
  return m ? m[0].replace(/\s+/g, " ").trim() : "";
}

/**
 * Subject shapes:
 *   Shape B digest: "vice president analytics": Acme Corp - VP, Data posted on 9/12/26
 *   Shape A single: VP, Data & Analytics at Acme Corp
 *                   VP, Data & Analytics at Acme Corp: up to $315K/year
 */
export function parseSubject(
  subject: string,
): { title?: string; company?: string; compensation?: string } {
  const s = (subject || "").trim();
  if (!s) return {};

  const digest = s.match(/^["“](.+?)["”]\s*:\s*(.+?)\s+-\s+(.+?)\s+posted on\s+\S+/i);
  if (digest) {
    return { company: cleanCompany(digest[2]), title: digest[3].trim() };
  }

  // "Title at Company" — optionally followed by ": <salary blurb>".
  const single = s.match(/^(.+?)\s+at\s+(.+)$/);
  if (single) {
    let company = single[2].trim();
    let compensation = "";
    const tail = company.match(/^(.*?):\s*(.*\$.*)$/);
    if (tail) {
      company = tail[1].trim();
      compensation = extractSalary(tail[2]);
    }
    return { title: single[1].trim(), company: cleanCompany(company), compensation };
  }
  return {};
}

/**
 * Parse one alert email into zero or more job rows.
 * Returns [] when the shape is not recognized — the caller falls back to the agent.
 */
export function parseLinkedInAlert(email: RawEmailLike): ParsedAlertJob[] {
  const body = email.body || "";
  if (!body) return [];

  // Anchor on every job-view URL in document order.
  const anchors: { jobId: string; url: string; start: number; end: number }[] = [];
  JOB_VIEW_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JOB_VIEW_URL.exec(body)) !== null) {
    anchors.push({
      jobId: m[1],
      url: stripTracking(m[0]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  if (anchors.length === 0) return [];

  const fromSubject = parseSubject(email.subject);
  const hasLines = /\n/.test(body);
  const out: ParsedAlertJob[] = [];
  const seen = new Set<string>();
  let prevEnd = 0;

  for (const a of anchors) {
    if (seen.has(a.jobId)) {
      prevEnd = a.end;
      continue;
    }

    // The block preceding this URL holds the title/company/location for it.
    const block = body.slice(prevEnd, a.start);
    prevEnd = a.end;

    let title = "";
    let company = "";
    let location = "";

    if (hasLines) {
      const lines = block
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter((l) => l.length > 0 && !NOISE_LINE.test(l));

      // Peel trailing annotation lines ("Actively recruiting", "Remote", ...)
      // off the end; they decorate the posting rather than name it.
      const mods: string[] = [];
      while (lines.length > 0 && MODIFIER_LINE.test(lines[lines.length - 1])) {
        mods.unshift(lines.pop() as string);
      }

      // Shape seen in every captured LinkedIn alert:
      //   Title / "Company · Location" / [annotations] / URL
      const dotIdx = (() => {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (/\s·\s/.test(lines[i])) return i;
        }
        return -1;
      })();

      if (dotIdx >= 0) {
        const [co, ...rest] = lines[dotIdx].split(/\s·\s/);
        company = cleanCompany(co);
        location = rest.join(" · ").trim();
        title = (lines[dotIdx - 1] || "").trim();
      } else {
        // Digest variant: Title / Company / Location on three separate lines.
        const tail = lines.slice(-3);
        if (tail.length === 3 && LOCATION_LINE.test(tail[2])) {
          [title, company, location] = [tail[0], cleanCompany(tail[1]), tail[2]];
        } else if (tail.length >= 2 && LOCATION_LINE.test(tail[tail.length - 1])) {
          location = tail[tail.length - 1];
          company = cleanCompany(tail[tail.length - 2] || "");
        }
      }

      const workplace = mods.find((x) => WORKPLACE_MODIFIER.test(x));
      if (workplace) {
        location = location ? `${location} (${workplace})` : workplace;
      }
    }

    // Shape A, or an HTML body whose newlines were collapsed: fall back to the
    // subject for title/company and scan the block for a location.
    if (!title && fromSubject.title) title = fromSubject.title;
    if (!company && fromSubject.company) company = fromSubject.company;
    if (!location) {
      const loc = block.match(
        /([A-Z][A-Za-z .'\/-]+,\s*(?:[A-Z]{2}\b|[A-Z][a-z]+))(?:\s*\((Remote|Hybrid|On-site)\))?|United States \(Remote\)/,
      );
      location = loc ? loc[0].trim() : "";
    }

    if (!title || !company) continue; // unreadable — let the agent try this email

    seen.add(a.jobId);
    out.push({
      linkedinJobId: a.jobId,
      title,
      company,
      location,
      compensation:
        extractSalary(block) || fromSubject.compensation || extractSalary(email.subject) || "",
      posting_url: a.url,
      source: "linkedin",
      source_message_id: email.id,
    });
  }

  return out;
}

/**
 * Parse a batch of emails. Dedupes on the LinkedIn job id across the whole batch
 * BEFORE anything downstream sees a row — the 17 overlapping alerts mean the same
 * posting arrives 2-5 times a day, and that duplication is the dominant waste.
 */
export function parseAlertEmails(emails: RawEmailLike[]): ParseAlertsResult {
  const jobs: ParsedAlertJob[] = [];
  const unmatched: RawEmailLike[] = [];
  const seen = new Set<string>();
  let duplicatesInBatch = 0;
  let emailsParsed = 0;

  for (const email of emails) {
    if (!isKnownAlertSender(email.from || "")) {
      unmatched.push(email);
      continue;
    }
    const parsed = parseLinkedInAlert(email);
    if (parsed.length === 0) {
      unmatched.push(email);
      continue;
    }
    emailsParsed++;
    for (const job of parsed) {
      if (seen.has(job.linkedinJobId)) {
        duplicatesInBatch++;
        continue;
      }
      seen.add(job.linkedinJobId);
      jobs.push(job);
    }
  }

  return {
    jobs,
    unmatched,
    stats: {
      emailsIn: emails.length,
      emailsParsed,
      emailsUnmatched: unmatched.length,
      jobsFound: jobs.length,
      duplicatesInBatch,
    },
  };
}

// ---------------------------------------------------------------------------
// Token budgeting for the agent fallback
// ---------------------------------------------------------------------------

/**
 * Conservative token estimate. Measures the text, not the email count — an
 * email-count cap is what produced the 225K-token call in the first place.
 * ~3.2 chars/token is deliberately pessimistic for tracking-URL soup, which
 * tokenizes far worse than prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 3.2);
}

/**
 * Split items into batches whose estimated token cost stays under `budget`.
 * An item larger than the budget on its own gets its own batch — the caller is
 * responsible for letting that batch fail without killing the run.
 */
export function chunkByTokens<T>(
  items: T[],
  sizeOf: (item: T) => number,
  budget: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const cost = sizeOf(item);
    if (current.length > 0 && currentTokens + cost > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
