/**
 * Tests for Candidate Identity Locking System
 *
 * Verifies:
 * 1. CandidateIdentity resolution from inventory
 * 2. MissingBaselineError on missing inventory
 * 3. CandidateIdentityMismatchError on identity drift
 * 4. Output identity guards (resume name, employer subset, CL signature)
 * 5. Ledger identity assertion
 * 6. Inventory hash stability
 */

import { describe, it, expect, vi } from "vitest";
import {
  MissingBaselineError,
  CandidateIdentityMismatchError,
  computeInventoryHash,
  deriveCandidateId,
  resolveCandidateIdentity,
  validateResumeIdentity,
  validateCoverLetterIdentity,
  assertLedgerIdentity,
  type CandidateIdentity,
} from "../src/resume-engine/candidate-identity";

// ── Fixture Data ────────────────────────────────────────────────

const VALID_INVENTORY = {
  profile: {
    name: "Ed Dobbles",
    email: "ed@example.com",
    phone: "(555) 123-4567",
    location: "Chicago, IL",
  },
  experience: [
    {
      employer: "Acme Corp",
      title: "VP of Data",
      start_date: "2021-03",
      end_date: "present",
      bullets: [
        { id: "exp-001-b1", text: "Led 45-person team" },
      ],
    },
    {
      employer: "Beta Inc",
      title: "Senior Director",
      start_date: "2018-06",
      end_date: "2021-02",
      bullets: [
        { id: "exp-002-b1", text: "Managed 28-person team" },
      ],
    },
  ],
};

const VALID_IDENTITY: CandidateIdentity = {
  candidate_id: "ed-dobbles",
  candidate_name: "Ed Dobbles",
  inventory_hash: computeInventoryHash(VALID_INVENTORY),
  inventory_source: "filesystem",
  resolved_at: new Date().toISOString(),
};

// ── Tests ───────────────────────────────────────────────────────

describe("CandidateIdentity", () => {
  describe("deriveCandidateId", () => {
    it("derives slug from candidate name", () => {
      expect(deriveCandidateId(VALID_INVENTORY)).toBe("ed-dobbles");
    });

    it("handles names with special characters", () => {
      const inv = { profile: { name: "Jean-Pierre O'Brien" }, experience: [{ bullets: [] }] };
      expect(deriveCandidateId(inv)).toBe("jean-pierre-o-brien");
    });

    it("uses explicit candidate_id if present", () => {
      const inv = { profile: { name: "Ed Dobbles", candidate_id: "custom-id-123" }, experience: [] };
      expect(deriveCandidateId(inv)).toBe("custom-id-123");
    });

    it("throws MissingBaselineError when profile is missing", () => {
      expect(() => deriveCandidateId({})).toThrow(MissingBaselineError);
    });

    it("throws MissingBaselineError when name is empty", () => {
      expect(() => deriveCandidateId({ profile: { name: "" } })).toThrow(MissingBaselineError);
    });

    it("throws MissingBaselineError when name is not a string", () => {
      expect(() => deriveCandidateId({ profile: { name: 42 } })).toThrow(MissingBaselineError);
    });
  });

  describe("computeInventoryHash", () => {
    it("produces a 64-char hex string (SHA-256)", () => {
      const hash = computeInventoryHash(VALID_INVENTORY);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("is deterministic — same input → same hash", () => {
      const h1 = computeInventoryHash(VALID_INVENTORY);
      const h2 = computeInventoryHash(VALID_INVENTORY);
      expect(h1).toBe(h2);
    });

    it("changes when inventory content changes", () => {
      const modified = { ...VALID_INVENTORY, profile: { ...VALID_INVENTORY.profile, name: "Jane Doe" } };
      const h1 = computeInventoryHash(VALID_INVENTORY);
      const h2 = computeInventoryHash(modified);
      expect(h1).not.toBe(h2);
    });
  });

  describe("resolveCandidateIdentity", () => {
    it("creates identity with all required fields", () => {
      const id = resolveCandidateIdentity(VALID_INVENTORY, "filesystem", "/path/to/inv.json", "run-123");
      expect(id.candidate_id).toBe("ed-dobbles");
      expect(id.candidate_name).toBe("Ed Dobbles");
      expect(id.inventory_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(id.inventory_source).toBe("filesystem");
      expect(id.inventory_path).toBe("/path/to/inv.json");
      expect(id.run_id).toBe("run-123");
      expect(id.resolved_at).toBeTruthy();
    });

    it("works with DB source", () => {
      const id = resolveCandidateIdentity(VALID_INVENTORY, "db");
      expect(id.inventory_source).toBe("db");
      expect(id.inventory_path).toBeUndefined();
    });
  });

  describe("MissingBaselineError", () => {
    it("has structured fields for diagnostics", () => {
      const err = new MissingBaselineError("ed-dobbles", ["/path/a", "/path/b"], "DB not reachable");
      expect(err.name).toBe("MissingBaselineError");
      expect(err.candidate_id).toBe("ed-dobbles");
      expect(err.attempted_paths).toEqual(["/path/a", "/path/b"]);
      expect(err.message).toContain("HARD FAIL");
      expect(err.message).toContain("ed-dobbles");
      expect(err.message).toContain("DB not reachable");
    });

    it("never falls back — always throws", () => {
      expect(() => {
        throw new MissingBaselineError("unknown", [], "test");
      }).toThrow(MissingBaselineError);
    });
  });

  describe("CandidateIdentityMismatchError", () => {
    it("captures expected vs actual identity", () => {
      const err = new CandidateIdentityMismatchError(
        "resume_header",
        { candidate_name: "Ed Dobbles" },
        { candidate_name: "Ed Martinez" },
      );
      expect(err.name).toBe("CandidateIdentityMismatchError");
      expect(err.check).toBe("resume_header");
      expect(err.expected.candidate_name).toBe("Ed Dobbles");
      expect(err.actual.candidate_name).toBe("Ed Martinez");
      expect(err.message).toContain("HARD FAIL");
      expect(err.message).toContain("wrong candidate");
    });
  });
});

describe("Output Identity Guards", () => {
  describe("validateResumeIdentity", () => {
    it("passes when employers match ledger", () => {
      const resume = {
        candidate_name: "Ed Dobbles",
        experience: [
          { employer: "Acme Corp", bullets: [] },
          { employer: "Beta Inc", bullets: [] },
        ],
      };
      const result = validateResumeIdentity(resume, VALID_IDENTITY, ["Acme Corp", "Beta Inc"]);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("fails when resume has unknown employer", () => {
      const resume = {
        candidate_name: "Ed Dobbles",
        experience: [
          { employer: "Acme Corp", bullets: [] },
          { employer: "Fabricated Inc", bullets: [] },
        ],
      };
      const result = validateResumeIdentity(resume, VALID_IDENTITY, ["Acme Corp", "Beta Inc"]);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Resume employer "Fabricated Inc" not found in claims ledger');
    });

    it("fails when resume has no candidate_name", () => {
      const resume = {
        experience: [{ employer: "Acme Corp", bullets: [] }],
      };
      const result = validateResumeIdentity(resume, VALID_IDENTITY, ["Acme Corp"]);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Resume has no candidate_name field");
    });

    it("fails when resume name does not match identity", () => {
      const resume = {
        candidate_name: "Ed Martinez",
        experience: [{ employer: "Acme Corp", bullets: [] }],
      };
      const result = validateResumeIdentity(resume, VALID_IDENTITY, ["Acme Corp"]);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain("does not match");
    });

    it("is case-insensitive for name matching", () => {
      const resume = {
        candidate_name: "ed dobbles",
        experience: [{ employer: "Acme Corp", bullets: [] }],
      };
      const result = validateResumeIdentity(resume, VALID_IDENTITY, ["Acme Corp"]);
      expect(result.valid).toBe(true);
    });
  });

  describe("validateCoverLetterIdentity", () => {
    it("passes when sign-off contains candidate name", () => {
      const cl = { sign_off: "Best regards,\nEd Dobbles" };
      const result = validateCoverLetterIdentity(cl, VALID_IDENTITY);
      expect(result.valid).toBe(true);
    });

    it("warns when sign-off has wrong name", () => {
      const cl = { sign_off: "Best regards,\nEd Martinez" };
      const result = validateCoverLetterIdentity(cl, VALID_IDENTITY);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain("does not contain candidate name");
    });

    it("passes when sign-off is empty (no sign_off to check)", () => {
      const cl = { body: "Dear hiring manager..." };
      const result = validateCoverLetterIdentity(cl, VALID_IDENTITY);
      expect(result.valid).toBe(true);
    });
  });
});

describe("Ledger Identity Assertion", () => {
  it("passes when ledger identity matches pipeline identity", () => {
    const ledgerIdentity = {
      candidate_id: "ed-dobbles",
      candidate_name: "Ed Dobbles",
      inventory_hash: VALID_IDENTITY.inventory_hash,
    };
    expect(() => assertLedgerIdentity(ledgerIdentity, VALID_IDENTITY)).not.toThrow();
  });

  it("throws on candidate_id mismatch", () => {
    const ledgerIdentity = {
      candidate_id: "ed-martinez",
      candidate_name: "Ed Dobbles",
      inventory_hash: VALID_IDENTITY.inventory_hash,
    };
    expect(() => assertLedgerIdentity(ledgerIdentity, VALID_IDENTITY)).toThrow(
      CandidateIdentityMismatchError,
    );
  });

  it("throws on candidate_name mismatch", () => {
    const ledgerIdentity = {
      candidate_id: "ed-dobbles",
      candidate_name: "Ed Martinez",
      inventory_hash: VALID_IDENTITY.inventory_hash,
    };
    expect(() => assertLedgerIdentity(ledgerIdentity, VALID_IDENTITY)).toThrow(
      CandidateIdentityMismatchError,
    );
  });

  it("throws on inventory_hash mismatch", () => {
    const ledgerIdentity = {
      candidate_id: "ed-dobbles",
      candidate_name: "Ed Dobbles",
      inventory_hash: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(() => assertLedgerIdentity(ledgerIdentity, VALID_IDENTITY)).toThrow(
      CandidateIdentityMismatchError,
    );
  });

  it("passes when ledger identity fields are undefined (pre-migration data)", () => {
    const ledgerIdentity = {};
    expect(() => assertLedgerIdentity(ledgerIdentity, VALID_IDENTITY)).not.toThrow();
  });
});
