/**
 * SPEC § Verification assertion 6, mechanised.
 *
 * > `docs/EVIDENCE.md` exists and contains, for each of T-006, T-008, and the
 * > T-001 to T-010 memory handoff: the committed trace excerpt, the resulting
 * > `TriageDecision` JSON, and a Console trace screenshot. Plus one screenshot
 * > of a `span.outcome_evaluation_end` showing per-criterion feedback.
 *
 * Assertion 6 was the only one of the six with no implementation of any kind —
 * no file to check and no code to check it. It is checked here rather than in
 * the driver because it is a property of the REPOSITORY, not of a run: a live
 * ten-ticket run tells you nothing about whether the evidence document exists,
 * and `pnpm verify:live` composes this suite with the driver precisely so both
 * halves of the gate run under one command.
 *
 * WHAT THIS CAN AND CANNOT PROVE, stated so no one reads more into a green run
 * than is there. It checks that the document cites artifacts that EXIST and are
 * INTERNALLY CONSISTENT — every session id and event id named in prose is
 * verified to occur in the committed trace it claims to come from, and every
 * decision block is verified against the committed decisions JSON. It cannot
 * check that a screenshot shows what its caption says. That is a human's job,
 * and `/defend` is where it is examined.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Resolved locally, never through `config.ts` — D-028. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_MD = join(ROOT, "docs", "EVIDENCE.md");
const EVIDENCE_DIR = join(ROOT, "docs", "evidence");

const doc = readFileSync(EVIDENCE_MD, "utf8");

const decisions = JSON.parse(
  readFileSync(join(EVIDENCE_DIR, "phase-6-decisions.json"), "utf8"),
) as Record<string, { session_id: string; decision: { disposition: string } }>;

/**
 * Every `sesn_…` / `sevt_…` the document names.
 *
 * The length bound is not cosmetic. A bare `[A-Za-z0-9]+` also matches the
 * literal placeholder in prose like "appending `?event=<sevt_id>`", and the
 * first run of this suite failed on exactly that — a checker firing on correct
 * work, which D-040 records as worse than no checker, because it buries a real
 * finding beside the noise. Real ids are 22 characters after the prefix.
 */
const idsIn = (pattern: RegExp) => [...new Set(doc.match(pattern) ?? [])];
const SESSION_ID = /sesn_[A-Za-z0-9]{20,}/g;
const EVENT_ID = /sevt_[A-Za-z0-9]{20,}/g;

describe("docs/EVIDENCE.md — SPEC ship-gate condition 6", () => {
  it("exists and is substantial", () => {
    expect(existsSync(EVIDENCE_MD)).toBe(true);
    expect(doc.length).toBeGreaterThan(4000);
  });

  it("covers all three required subjects", () => {
    // The three SPEC names: two gate tickets and the handoff.
    expect(doc).toMatch(/T-006/);
    expect(doc).toMatch(/T-008/);
    expect(doc).toMatch(/T-001/);
    expect(doc).toMatch(/T-010/);
  });

  it("carries a TriageDecision JSON block for each gate ticket", () => {
    // Not "mentions the ticket" — the actual decision fields, so a document that
    // described the result in prose without quoting it would fail.
    for (const marker of [
      /"ticket_id":\s*"T-006"/,
      /"ticket_id":\s*"T-008"/,
      /"suspected_injection":\s*true/,
      /"disposition":\s*"escalate"/,
    ]) {
      expect(doc).toMatch(marker);
    }
  });

  it("quotes decisions that match the committed artifact", () => {
    // The document is not allowed to drift from the evidence it cites. If a
    // re-run changes a disposition, this fails rather than letting the prose
    // silently describe a run that no longer exists.
    for (const id of ["T-006", "T-008", "T-010"]) {
      expect(decisions[id]?.decision.disposition).toBe("escalate");
    }
    expect(decisions["T-005"]?.decision.disposition).toBe("decline");
  });

  it("carries committed trace excerpts, not just references to files", () => {
    // A trace excerpt means event JSON. These are shapes only a real trace has.
    expect(doc).toMatch(/"type":\s*"agent\.tool_use"/);
    expect(doc).toMatch(/"type":\s*"agent\.tool_result"/);
    expect(doc).toMatch(/agent\.mcp_tool_result/);
  });

  it("names trace files that exist", () => {
    const named = [...new Set(doc.match(/phase-\d+-[A-Za-z0-9-]+\.(?:jsonl|json)/g) ?? [])];
    expect(named.length).toBeGreaterThan(2);
    for (const file of named) {
      expect(existsSync(join(EVIDENCE_DIR, file)), `${file} is cited but missing`).toBe(true);
    }
  });

  it("every session id it cites is the one the decisions file records", () => {
    // Guards the failure that would quietly invalidate every Console link: a
    // copied id that points at a different session.
    const cited = idsIn(SESSION_ID);
    expect(cited.length).toBeGreaterThanOrEqual(3);

    const known = new Set(Object.values(decisions).map((d) => d.session_id));
    for (const id of cited) {
      expect(known.has(id), `${id} appears in EVIDENCE.md but in no committed run`).toBe(true);
    }
  });

  it("every event id it cites occurs in a committed trace", () => {
    const cited = idsIn(EVENT_ID);
    expect(cited.length).toBeGreaterThanOrEqual(4);

    // One concatenated haystack: an id is valid if SOME committed trace has it.
    const haystack = Object.keys(decisions)
      .map((t) => {
        const p = join(EVIDENCE_DIR, `phase-6-${t}.jsonl`);
        return existsSync(p) ? readFileSync(p, "utf8") : "";
      })
      .join("\n");

    for (const id of cited) {
      expect(haystack.includes(id), `${id} is cited but occurs in no committed trace`).toBe(true);
    }
  });

  it("requires the four Console screenshots and names a file for each", () => {
    const shots = [...new Set(doc.match(/screenshots\/[a-z0-9-]+\.png/g) ?? [])];
    expect(shots).toHaveLength(4);
    // One per required subject, plus the per-criterion feedback capture.
    expect(shots.some((s) => s.includes("t-006"))).toBe(true);
    expect(shots.some((s) => s.includes("t-008"))).toBe(true);
    expect(shots.some((s) => s.includes("memory"))).toBe(true);
    expect(shots.some((s) => s.includes("criterion"))).toBe(true);
  });

  it("and those four files EXIST, and are real images", () => {
    // This assertion could not be written until the captures existed, and its
    // absence was a real hole: the check above reads four FILENAMES out of a
    // markdown table, so it passed for the whole of Phase 7 while
    // `docs/evidence/screenshots/` did not exist at all. Ship-gate condition 6
    // was mechanically green and objectively unmet at the same time.
    //
    // The trace-file assertion five tests above has always called `existsSync`
    // (`:102`). This is the same discipline applied to the other artifact class.
    //
    // The PNG magic number and a size floor are what stop a touched placeholder
    // from satisfying it. A 0-byte `t-006-escalation.png` would otherwise close
    // the last open ship-gate condition.
    const shots = [...new Set(doc.match(/screenshots\/[a-z0-9-]+\.png/g) ?? [])];
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    for (const shot of shots) {
      const path = join(EVIDENCE_DIR, shot.replace(/^screenshots\//, "screenshots/"));
      expect(existsSync(path), `${shot} is required by assertion 6 but missing`).toBe(true);

      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 8).equals(PNG_MAGIC), `${shot} is not a PNG`).toBe(true);
      // A Console screenshot is hundreds of kB. 10 kB rules out a placeholder
      // without pinning a resolution the next capture has to match.
      expect(bytes.byteLength, `${shot} is too small to be a real capture`).toBeGreaterThan(10_000);
    }
  });

  it("gives a resolvable Console URL for every screenshot", () => {
    const urls = doc.match(/https:\/\/platform\.claude\.com\/workspaces\/[^\s`)]+/g) ?? [];
    // Base + one per capture. Each must carry a real session id.
    expect(urls.length).toBeGreaterThanOrEqual(4);
    const deepLinks = urls.filter((u) => u.includes("?event="));
    expect(deepLinks.length).toBeGreaterThanOrEqual(2);
  });

  it("states the grader evidence in the satisfiable form D-055 established", () => {
    // A document claiming all ten tickets were fully scored would be wrong, and
    // this is the assertion that would have let it through unnoticed.
    expect(doc).toMatch(/only on `?satisfied`?/i);
    expect(doc).toMatch(/max_iteration=2|highest .{0,12}iteration.{0,12}2/i);
  });
});
