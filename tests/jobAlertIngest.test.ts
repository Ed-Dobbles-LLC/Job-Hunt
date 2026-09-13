/**
 * Step 1 ingest tests — regression cover for the 2026-09-13 context-length failure.
 *
 * run-1789315548475 pulled 50 emails from the "Job Alerts" label, concatenated
 * every body into ONE agent call, and died in 7 seconds:
 *   "maximum context length is 128000 tokens. However, your messages resulted in
 *    225168 tokens (219566 in the messages, 5602 in the functions)"
 *
 * These tests feed 50 realistic alert bodies through Step 1 and assert it
 * completes — and that it completes without sending a single token to the agent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAlertEmails,
  parseLinkedInAlert,
  stripTracking,
  estimateTokens,
  chunkByTokens,
  isKnownAlertSender,
  type RawEmailLike,
} from "../src/mastra/tools/linkedinAlertParser";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Step 1 talks to Postgres, Gmail, the parse-jobs tool and the agent. Everything
// but the parsing logic is stubbed so the test is hermetic.

const queryMock = vi.fn(async (sql: string) => {
  if (/SELECT gmail_id FROM processed_gmail_ids/i.test(sql)) return { rows: [] };
  return { rows: [] };
});

vi.mock("../src/mastra/tools/db", () => ({
  initDatabase: vi.fn(async () => {}),
  query: (...args: any[]) => queryMock(...(args as [string])),
}));

const fetchEmailsMock = vi.fn();
vi.mock("../src/mastra/tools/gmailClient", () => ({
  fetchEmailsFromLabel: (...args: any[]) => fetchEmailsMock(...args),
  sendEmail: vi.fn(async () => ({ ok: true })),
}));

const parseJobsExecute = vi.fn(async ({ context }: any) => ({
  newJobIds: context.jobs.map((_: any, i: number) => 9000 + i),
  duplicateCount: 0,
  totalParsed: context.jobs.length,
}));
vi.mock("../src/mastra/tools/parseJobsTool", () => ({
  parseJobsTool: { id: "parse-jobs", execute: (...a: any[]) => parseJobsExecute(...(a as [any])) },
}));

const agentGenerate = vi.fn(async () => ({ steps: [], text: "" }));
vi.mock("../src/mastra/agents/jobMatchAgent", () => ({
  jobMatchAgent: { generateLegacy: (...a: any[]) => agentGenerate(...(a as [])) },
}));

// Keep the Inngest/Mastra workflow builder out of the test process.
vi.mock("../src/mastra/inngest", () => ({
  createStep: (cfg: any) => cfg,
  createWorkflow: () => {
    const chain: any = { then: () => chain, commit: () => chain };
    return chain;
  },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Modelled on the captured alerts in fixtures/emails: each posting is
//   Title / "Company · Location" / [annotation] / job-view URL
// and every URL carries LinkedIn's full tracking query string, which is where
// the token weight actually came from.

const COMPANIES = [
  "PepsiCo", "Cardinal Health", "Stripe", "Walgreens", "Allstate",
  "Target", "Best Buy", "UnitedHealth Group", "3M", "Medtronic",
];
const TITLES = [
  "Chief Analytics Officer",
  "VP, Enterprise Data & Analytics",
  "Head of Data Science & Analytics",
  "Senior Director, Business Intelligence",
  "SVP, Chief Data Officer",
];
const LOCATIONS = [
  "Purchase, New York, United States",
  "Minneapolis, Minnesota, United States",
  "United States",
  "Chicago, Illinois, United States",
  "Dallas, Texas, United States",
];

function trackingUrl(jobId: string): string {
  // Real "View job" URLs run ~1,100 characters; ~40 of them carry meaning.
  const blob = (label: string, n: number) => `${label}=${"A1b2C3d4E5f6".repeat(n)}`;
  return (
    `https://www.linkedin.com/comm/jobs/view/${jobId}/?` +
    [
      blob("trackingId", 6),
      blob("refId", 6),
      blob("midToken", 8),
      blob("midSig", 8),
      blob("trk", 4),
      blob("trkEmail", 14),
      blob("eid", 8),
      blob("otpToken", 14),
      blob("emailSig", 10),
      "lipi=urn%3Ali%3Apage%3Aemail_email_job_alert_digest_01",
    ].join("&")
  );
}

function postingBlock(jobId: string, i: number, annotate: boolean): string {
  const title = TITLES[i % TITLES.length];
  const company = COMPANIES[i % COMPANIES.length];
  const location = LOCATIONS[i % LOCATIONS.length];
  return [
    title,
    `${company} · ${location}`,
    ...(annotate ? ["Actively recruiting"] : []),
    trackingUrl(jobId),
  ].join("\n");
}

/** One digest alert carrying `count` postings, ids drawn from `ids`. */
function makeDigest(msgId: string, ids: string[], startIndex: number): RawEmailLike {
  const blocks = ids.map((id, k) => postingBlock(id, startIndex + k, k % 3 === 0));
  return {
    id: msgId,
    subject: `Dr. Ed: ${ids.length} new jobs match your alert for VP Data Analytics`,
    from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
    date: "2026-09-13T12:05:00Z",
    body: [
      `${ids.length} new jobs match your alert for VP Data Analytics`,
      "",
      blocks.join("\n\n"),
      "",
      "See all jobs",
      "",
      "This email was intended for Dr. Ed Dobbles, DBA",
      "You are receiving Job Alert emails.",
      "",
      "© 2026 LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085.",
    ].join("\n"),
  };
}

/**
 * 50 alert emails. The 17 overlapping LinkedIn alerts mean the same posting
 * arrives 2-5 times a day, so the fixture deliberately recycles job ids across
 * emails: 50 emails × 12 postings = 600 rows drawn from 120 distinct ids.
 * Each body lands around 15KB, matching the size of the mail that produced the
 * 225,168-token call.
 */
const DISTINCT_IDS = Array.from({ length: 120 }, (_, i) => String(4456250000 + i));

function makeFiftyAlerts(): RawEmailLike[] {
  return Array.from({ length: 50 }, (_, e) => {
    const ids = Array.from({ length: 12 }, (_, k) => DISTINCT_IDS[(e * 7 + k) % DISTINCT_IDS.length]);
    return makeDigest(`msg-${String(e).padStart(3, "0")}`, ids, e);
  });
}

// ── Parser ───────────────────────────────────────────────────────────────────

describe("linkedinAlertParser", () => {
  it("recognizes both LinkedIn alert senders and nothing else", () => {
    expect(isKnownAlertSender("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>")).toBe(true);
    expect(isKnownAlertSender("jobs-noreply@linkedin.com")).toBe(true);
    expect(isKnownAlertSender("alerts@indeed.com")).toBe(false);
    expect(isKnownAlertSender("")).toBe(false);
  });

  it("strips the tracking query string down to the canonical job URL", () => {
    const url = trackingUrl("4456252851");
    expect(url.length).toBeGreaterThan(600);
    expect(stripTracking(url)).toBe("https://www.linkedin.com/jobs/view/4456252851");
  });

  it("extracts title, company and location from a digest posting", () => {
    const email = makeDigest("msg-x", ["4456250001"], 0);
    const jobs = parseLinkedInAlert(email);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      linkedinJobId: "4456250001",
      title: "Chief Analytics Officer",
      company: "PepsiCo",
      location: "Purchase, New York, United States",
      posting_url: "https://www.linkedin.com/jobs/view/4456250001",
      source: "linkedin",
      source_message_id: "msg-x",
    });
  });

  it("reads the captured real-world fixtures without an agent", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.join(process.cwd(), "fixtures", "emails");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const email = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as RawEmailLike;
      const jobs = parseLinkedInAlert(email);
      expect(jobs.length, `${f} produced no jobs`).toBeGreaterThan(0);
      for (const job of jobs) {
        expect(job.title, `${f}: empty title`).not.toBe("");
        expect(job.company, `${f}: empty company`).not.toBe("");
        expect(job.company).not.toMatch(/·/);
        expect(job.posting_url).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/);
      }
    }
  });

  it("dedupes on the LinkedIn job id across the whole batch", () => {
    const emails = makeFiftyAlerts();
    const { jobs, unmatched, stats } = parseAlertEmails(emails);

    expect(unmatched).toHaveLength(0);
    expect(stats.emailsParsed).toBe(50);
    expect(stats.duplicatesInBatch).toBeGreaterThan(0);

    const ids = jobs.map((j) => j.linkedinJobId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(jobs.length).toBeLessThanOrEqual(DISTINCT_IDS.length);
  });

  it("hands unknown senders to the agent instead of guessing", () => {
    const stranger: RawEmailLike = {
      id: "msg-stranger",
      subject: "3 new jobs",
      from: "alerts@somejobboard.example",
      body: "Some Title\nSome Co · Anywhere\nhttps://somejobboard.example/j/1",
    };
    const { jobs, unmatched } = parseAlertEmails([stranger]);
    expect(jobs).toHaveLength(0);
    expect(unmatched.map((e) => e.id)).toEqual(["msg-stranger"]);
  });
});

// ── Token budgeting ──────────────────────────────────────────────────────────

describe("token budgeting", () => {
  it("confirms the old single-call approach would still blow the 128K window", () => {
    const emails = makeFiftyAlerts();
    const concatenated = emails
      .map((e) => `Subject: ${e.subject}\nFrom: ${e.from}\n\n${e.body}`)
      .join("\n\n");
    // This is the shape of the call that died at 225,168 tokens.
    expect(estimateTokens(concatenated)).toBeGreaterThan(128_000);
  });

  it("keeps every fallback batch under the budget", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ text: "x".repeat(30_000 + i) }));
    const budget = 90_000;
    const batches = chunkByTokens(items, (it) => estimateTokens(it.text), budget);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(items.length);
    for (const batch of batches) {
      const cost = batch.reduce((n, it) => n + estimateTokens(it.text), 0);
      // A batch may only exceed the budget if it is a single oversized item.
      if (batch.length > 1) expect(cost).toBeLessThanOrEqual(budget);
    }
  });

  it("gives an oversized single item its own batch rather than dropping it", () => {
    const items = [{ text: "a".repeat(1000) }, { text: "b".repeat(500_000) }, { text: "c".repeat(1000) }];
    const batches = chunkByTokens(items, (it) => estimateTokens(it.text), 50_000);
    expect(batches.flat()).toHaveLength(3);
    expect(batches.some((b) => b.length === 1 && b[0].text.startsWith("b"))).toBe(true);
  });
});

// ── Step 1 end to end ────────────────────────────────────────────────────────

describe("executeFetchAndParse — 50 realistic alert bodies", () => {
  beforeEach(() => {
    queryMock.mockClear();
    parseJobsExecute.mockClear();
    agentGenerate.mockClear();
    fetchEmailsMock.mockReset();
    delete process.env.USE_FIXTURES;
    delete process.env.PARSE_MAX_EMAILS;
  });

  it("completes, and sends zero tokens to the agent", async () => {
    const emails = makeFiftyAlerts();
    fetchEmailsMock.mockResolvedValue(emails);

    const { executeFetchAndParse } = await import("../src/mastra/workflows/jobMatchWorkflow");
    const result = await executeFetchAndParse({ mastra: undefined });

    // Completion — this is the assertion the 7-second failure would break.
    expect(result).toBeDefined();
    expect(result.runId).toMatch(/^run-\d+$/);
    expect(result.totalEmails).toBe(50);
    expect(result.newJobIds.length).toBeGreaterThan(0);

    // Every alert was read deterministically; the agent was never called.
    expect(agentGenerate).not.toHaveBeenCalled();
    expect(parseJobsExecute).toHaveBeenCalledTimes(1);

    // And what it handed downstream is deduped and canonical.
    const jobs = parseJobsExecute.mock.calls[0][0].context.jobs;
    const urls = jobs.map((j: any) => j.posting_url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) expect(u).not.toContain("?");
  });

  it("caps the backlog it will chew through in one run", async () => {
    process.env.PARSE_MAX_EMAILS = "10";
    vi.resetModules();
    const emails = makeFiftyAlerts();
    fetchEmailsMock.mockResolvedValue(emails);

    const { executeFetchAndParse } = await import("../src/mastra/workflows/jobMatchWorkflow");
    const result = await executeFetchAndParse({ mastra: undefined });

    expect(result.totalEmails).toBe(10);
    expect(agentGenerate).not.toHaveBeenCalled();
  });
});
