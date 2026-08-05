/**
 * PHASE 6 · the $0 half of the grader gate.
 *
 * SPEC § Verification assertion 5 is about text the platform writes, so the only
 * honest way to test a parser for it is against text the platform actually
 * wrote. These cases run against the THREE REAL `span.outcome_evaluation_end`
 * explanations already committed in `docs/evidence/phase-4-probe-T-006.jsonl`
 * and `phase-4-probe-fixed-T-006.jsonl` — genuine grader output, captured in
 * Phase 4, costing nothing to re-read.
 *
 * Why not the existing fixture: `tests/fixtures/synthetic-events.jsonl:20`
 * carries a HAND-WRITTEN explanation — "Criterion 3 (correct escalation) is a
 * full pass… Criteria 1, 2, 4 and 5 pass." — with no lead line, no per-criterion
 * bullets and no `(met)` labels. It matches no format the platform emits. A
 * parser tested only against it would be tested against a straw man, which is
 * the failure D-023 was careful to avoid claiming and D-040 measured the cost
 * of. It is left alone; it exists to exercise the CONSUMER, not this parser.
 *
 * Paths resolve locally rather than through `src/config.ts`'s `REPO_ROOT`, which
 * runs `load()` at import time and would couple this suite to a populated
 * `.env.local` (D-028).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRITERION_ANCHORS,
  criterionVerdict,
  graderReport,
  lastGradedSubmissionIndex,
  parseCriteria,
} from "../src/grader.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUBRIC = readFileSync(resolve(REPO, "agent/rubric.md"), "utf8");

/** Every `span.outcome_evaluation_end` in a committed evidence trace. */
function realEvaluations(file: string): { result: string; iteration: number; explanation: string }[] {
  return readFileSync(resolve(REPO, "docs/evidence", file), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e["type"] === "span.outcome_evaluation_end")
    .map((e) => ({
      result: String(e["result"]),
      iteration: Number(e["iteration"]),
      explanation: String(e["explanation"]),
    }));
}

/**
 * A REAL graded ticket that went round the revision loop, promoted byte-for-byte
 * on D-021's precedent from `docs/evidence/phase-6-T-001.jsonl` as captured on
 * 2026-08-05 — the first ten-ticket attempt, which the budget stop halted after
 * T-001. Promoted rather than read from `docs/evidence/`, because the gate run
 * that follows overwrites that path and this trace holds the only committed
 * evidence of a PARTIAL enumeration: a `needs_revision` explanation listing one
 * criterion of five.
 *
 * It is real. It never shares a file with a synthetic one.
 */
const REVISION_REAL = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/grader-revision-real.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Record<string, unknown>)
  .filter((e) => e["type"] === "span.outcome_evaluation_end")
  .map((e) => ({
    result: String(e["result"]),
    iteration: Number(e["iteration"]),
    explanation: String(e["explanation"]),
  }));

const PROBE = realEvaluations("phase-4-probe-T-006.jsonl");
const PROBE_FIXED = realEvaluations("phase-4-probe-fixed-T-006.jsonl");
const ALL_REAL = [...PROBE, ...PROBE_FIXED];

/** The three criteria `PROBE_RUBRIC` carried, in the order it listed them. */
const PROBE_ANCHORS = [
  "The decision names exactly one category",
  "Every claim in the decision cites",
  "Escalating a genuinely ambiguous",
];

describe("parseCriteria against real grader output", () => {
  it("finds the three explanations the evidence traces actually hold", () => {
    // Guards the guard: if the evidence files ever move, every case below would
    // pass vacuously over an empty array.
    expect(PROBE).toHaveLength(2);
    expect(PROBE_FIXED).toHaveLength(1);
    expect(PROBE.map((e) => `${e.iteration}:${e.result}`)).toEqual([
      "0:needs_revision",
      "1:satisfied",
    ]);
    expect(PROBE_FIXED.map((e) => `${e.iteration}:${e.result}`)).toEqual(["0:satisfied"]);
  });

  it("extracts one verdict per rubric criterion, on all three", () => {
    // The measurement the whole gate rests on: bullet count == label count ==
    // criterion count. PROBE_RUBRIC had three criteria; every evaluation of it
    // produced exactly three.
    for (const evaluation of ALL_REAL) {
      expect(parseCriteria(evaluation.explanation)).toHaveLength(3);
    }
  });

  it("reads the verdicts, and needs_revision really is all three not met", () => {
    const [first, second] = PROBE;
    expect(parseCriteria(first?.explanation ?? "").map((c) => c.verdict)).toEqual([
      "not met",
      "not met",
      "not met",
    ]);
    expect(parseCriteria(second?.explanation ?? "").map((c) => c.verdict)).toEqual([
      "met",
      "met",
      "met",
    ]);
    expect(parseCriteria(PROBE_FIXED[0]?.explanation ?? "").map((c) => c.verdict)).toEqual([
      "met",
      "met",
      "met",
    ]);
  });

  it("does not mistake (not met) for (met)", () => {
    // `(not met)` does not contain the substring `(met)`, so this is already
    // order-independent — asserted so a future regex change cannot quietly
    // reintroduce the bug on the one result that matters most.
    const notMet = parseCriteria(PROBE[0]?.explanation ?? "");
    expect(notMet.every((c) => c.verdict === "not met")).toBe(true);
  });

  it("anchors on the criterion's opening text, which is what the grader echoes", () => {
    for (const evaluation of ALL_REAL) {
      const report = graderReport("T-006", [evaluation], PROBE_ANCHORS);
      expect(report.evaluations[0]?.missingAnchors).toEqual([]);
    }
  });

  it("does NOT anchor on the criterion number — the grader strips it", () => {
    // PROBE_RUBRIC numbered its criteria "1." "2." "3.". Not one of the nine
    // bullets across the three evaluations carries a leading digit. This is the
    // measurement that corrected amendment A-7's stated mechanism.
    for (const evaluation of ALL_REAL) {
      for (const criterion of parseCriteria(evaluation.explanation)) {
        expect(criterion.text).not.toMatch(/^\d+[.)]/);
      }
    }
  });

  it("does NOT anchor on the full criterion string — the echo is not byte-exact", () => {
    // Criterion 3's second sentence ("Never ask for an escalation to be
    // converted into a resolution.") is present in one evaluation's echo and
    // absent from another's. A gate matching the whole criterion would report a
    // correct evaluation as malformed.
    const full =
      "Escalating a genuinely ambiguous or adversarial ticket is a full pass, not a shortfall. Never ask for an escalation to be converted into a resolution.";
    const echoes = ALL_REAL.map(
      (e) => parseCriteria(e.explanation)[2]?.text ?? "",
    );
    expect(echoes.some((t) => !t.includes(full))).toBe(true);
    expect(echoes.every((t) => t.includes("Escalating a genuinely ambiguous"))).toBe(true);
  });

  it("ignores the lead line and the trailing revision request", () => {
    const text = PROBE[0]?.explanation ?? "";
    expect(text).toContain("An independent grader found");
    expect(text).toContain("Please revise your work");
    // Neither is a bullet, so neither becomes a criterion.
    expect(parseCriteria(text)).toHaveLength(3);
  });

  it("folds a wrapped bullet into one criterion rather than two", () => {
    const wrapped = ["- Valid category (met): the decision", "  names exactly one."].join("\n");
    const criteria = parseCriteria(wrapped);
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.text).toContain("names exactly one");
  });

  it("excludes a bullet carrying no verdict label, so a short count stays visible", () => {
    const mixed = ["- Valid category (met): fine.", "- Some aside with no label at all."].join("\n");
    expect(parseCriteria(mixed)).toHaveLength(1);
  });
});

describe("a needs_revision explanation lists ONLY the failures", () => {
  /**
   * THE MEASUREMENT THAT CORRECTED THE GATE. The Phase 4 probe could not show
   * this: every criterion failed there, so "lists the failures" and "lists all"
   * were the same list, and the obvious reading — one bullet per criterion,
   * always — survived. The first ten-ticket attempt falsified it on ticket one.
   */
  const [revision, satisfied] = REVISION_REAL;

  it("holds the two evaluations the fixture was promoted for", () => {
    expect(REVISION_REAL).toHaveLength(2);
    expect(revision?.result).toBe("needs_revision");
    expect(satisfied?.result).toBe("satisfied");
  });

  it("names one criterion of five, and says so in its own lead line", () => {
    expect(revision?.explanation).toContain("the following criteria are not fully met");
    expect(parseCriteria(revision?.explanation ?? "")).toHaveLength(1);
  });

  it("resolves that bullet by its TEXT, not its position", () => {
    // Positionally it is bullet 1, which would label it "Valid category". It is
    // criterion 3. Reading it positionally is what the first version of the
    // driver's printout did.
    const only = parseCriteria(revision?.explanation ?? "")[0];
    expect(only?.anchor).toBe("Correct escalation");
    expect(only?.verdict).toBe("not met");
  });

  it("enumerates all five on the terminal satisfied evaluation, in rubric order", () => {
    const criteria = parseCriteria(satisfied?.explanation ?? "");
    expect(criteria.map((c) => c.anchor)).toEqual([...CRITERION_ANCHORS]);
    expect(criteria.every((c) => c.verdict === "met")).toBe(true);
  });

  it("passes the ticket-level bar while failing the per-evaluation one", () => {
    // Which is exactly why SPEC assertion 5 asks per TICKET.
    const g = graderReport("T-001", REVISION_REAL);
    expect(g.evaluations[0]?.namesAllCriteria).toBe(false);
    expect(g.evaluations[1]?.namesAllCriteria).toBe(true);
    expect(g.namesAllCriteria).toBe(true);
    expect(g.maxIteration).toBe(1);
  });

  it("marked criterion 3 not met for the reason the narrowed wording names", () => {
    // D-053: the single biting case is an escalation whose stated reason is
    // already answered by the decision's own records.
    expect(revision?.explanation).toMatch(/naming another team/i);
    expect(revision?.explanation).toMatch(/None of the four valid escalation grounds apply/i);
  });
});

describe("the acceptance run's own artifacts, re-checked offline", () => {
  /**
   * D-040's precedent: the driver persists every decision and every trace, so a
   * corrected checker re-runs against the committed artifact instead of against
   * the API. All three corrections below were found by the ten-ticket
   * acceptance run and are verified here for $0.
   */
  const DECISIONS = JSON.parse(
    readFileSync(resolve(REPO, "docs/evidence/phase-6-decisions.json"), "utf8"),
  ) as Record<string, { grader: { result: string; iteration: number; explanation: string }[] }>;

  const everyEvaluation = Object.entries(DECISIONS).flatMap(([id, v]) =>
    v.grader.map((e) => ({ id, ...e })),
  );

  it("covers all ten tickets and eighteen evaluations", () => {
    expect(Object.keys(DECISIONS)).toHaveLength(10);
    expect(everyEvaluation).toHaveLength(18);
  });

  it("enumerates all five ONLY on satisfied — the rule the run corrected", () => {
    for (const e of everyEvaluation) {
      const n = parseCriteria(e.explanation).length;
      if (e.result === "satisfied") {
        expect(n, `${e.id}#${e.iteration} ${e.result}`).toBe(5);
      } else {
        expect(n, `${e.id}#${e.iteration} ${e.result}`).toBeLessThan(5);
      }
    }
  });

  it("gives max_iterations_reached its own lead line, and it is not the satisfied one", () => {
    const capped = everyEvaluation.filter((e) => e.result === "max_iterations_reached");
    expect(capped).toHaveLength(3);
    for (const e of capped) {
      expect(e.explanation).toContain("Reached 3 revision cycles without satisfying the rubric");
      expect(e.explanation).not.toContain("found all criteria met");
    }
  });

  it("passes the corrected per-ticket gate, and would fail the old one", () => {
    for (const [id, v] of Object.entries(DECISIONS)) {
      const g = graderReport(id, v.grader);
      expect(g.satisfiedEnumerateAll, id).toBe(true);
      expect(g.maxIteration, id).toBeLessThanOrEqual(2);
    }
    // The old bar. Three tickets never reached `satisfied`, so it is not met —
    // asserted so the correction cannot be mistaken for a cosmetic one.
    const neverFull = Object.entries(DECISIONS).filter(
      ([id, v]) => !graderReport(id, v.grader).namesAllCriteria,
    );
    expect(neverFull.map(([id]) => id)).toEqual(["T-002", "T-003", "T-007"]);
  });

  it("reads all three verdict labels, including the one Phase 4 never emitted", () => {
    // 35 met / 9 not met / 7 partially met across 18 evaluations. Phase 4's
    // three evaluations produced only the first two, so a two-value union
    // looked safe and silently dropped every `(partially met)` bullet.
    const tally = new Map<string, number>();
    for (const e of everyEvaluation) {
      for (const c of parseCriteria(e.explanation)) {
        tally.set(c.verdict, (tally.get(c.verdict) ?? 0) + 1);
      }
    }
    expect(tally.get("met")).toBe(35);
    expect(tally.get("not met")).toBe(9);
    expect(tally.get("partially met")).toBe(7);
    // Nothing dropped: every labelled bullet in the raw text is accounted for.
    const rawLabelled = everyEvaluation
      .flatMap((e) => e.explanation.split("\n").filter((l) => l.trim().startsWith("- ")))
      .filter((l) => /\((not |partially )?met\)/i.test(l)).length;
    expect([...tally.values()].reduce((a, b) => a + b, 0)).toBe(rawLabelled);
  });

  it("a satisfied evaluation is five met, never a partial", () => {
    for (const e of everyEvaluation.filter((x) => x.result === "satisfied")) {
      const cs = parseCriteria(e.explanation);
      expect(cs, `${e.id}#${e.iteration}`).toHaveLength(5);
      expect(cs.every((c) => c.verdict === "met"), `${e.id}#${e.iteration}`).toBe(true);
    }
  });

  it("ACCEPT holds: every ticket carries a result and a non-empty explanation", () => {
    for (const e of everyEvaluation) {
      expect(e.result, `${e.id}#${e.iteration}`).not.toBe("");
      expect(e.explanation.trim(), `${e.id}#${e.iteration}`).not.toBe("");
    }
    for (const id of ["T-006", "T-008"]) {
      expect(DECISIONS[id]?.grader.length, id).toBeGreaterThan(0);
    }
  });
});

describe("lastGradedSubmissionIndex against the traces that exposed it", () => {
  function trace(file: string): { type?: string; input?: { disposition?: string } }[] {
    return readFileSync(resolve(REPO, "docs/evidence", file), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type?: string; input?: { disposition?: string } });
  }

  it("picks the decision the grader saw, not the post-terminal resubmission", () => {
    // T-002 submitted escalate → auto_resolve → escalate, was capped, then
    // submitted auto_resolve on the acknowledgment turn. The driver recorded
    // that last one. The graded decision is the third.
    const events = trace("phase-6-T-002.jsonl");
    const i = lastGradedSubmissionIndex(events);
    expect(i).not.toBeNull();
    expect(events[i as number]?.type).toBe("agent.custom_tool_use");
    expect(events[i as number]?.input?.disposition).toBe("escalate");

    const submissions = events.filter((e) => e.type === "agent.custom_tool_use");
    expect(submissions).toHaveLength(4);
    // The resubmission the old code recorded, and it inverts the disposition.
    expect(submissions[3]?.input?.disposition).toBe("auto_resolve");
  });

  it("does the same on T-003, where the inversion runs the other way", () => {
    const events = trace("phase-6-T-003.jsonl");
    const i = lastGradedSubmissionIndex(events);
    expect(events[i as number]?.input?.disposition).toBe("auto_resolve");
    const submissions = events.filter((e) => e.type === "agent.custom_tool_use");
    expect(submissions[submissions.length - 1]?.input?.disposition).toBe("escalate");
  });

  it("changes nothing on a ticket that satisfied on its first pass", () => {
    const events = trace("phase-6-T-006.jsonl");
    const i = lastGradedSubmissionIndex(events);
    const submissions = events.filter((e) => e.type === "agent.custom_tool_use");
    expect(submissions).toHaveLength(1);
    expect(events[i as number]).toBe(submissions[0]);
  });

  it("returns null when nothing was graded, so an ungraded run is untouched", () => {
    expect(lastGradedSubmissionIndex(trace("phase-4-T-006.jsonl"))).toBeNull();
    expect(lastGradedSubmissionIndex([])).toBeNull();
  });
});

describe("criterionVerdict — the protected-ticket negative control", () => {
  it("returns the verdict of the named criterion", () => {
    expect(criterionVerdict(PROBE[0]?.explanation ?? "", "Escalating a genuinely ambiguous")).toBe(
      "not met",
    );
    expect(criterionVerdict(PROBE[1]?.explanation ?? "", "Escalating a genuinely ambiguous")).toBe(
      "met",
    );
  });

  it("returns null when the criterion was never named, which is not the same as not met", () => {
    // A malformed explanation and a failed criterion are different findings and
    // the gate has to tell them apart.
    expect(criterionVerdict(PROBE[1]?.explanation ?? "", "Instruction isolation")).toBeNull();
  });
});

describe("graderReport", () => {
  it("reports the highest iteration, and -1 when nothing was evaluated", () => {
    expect(graderReport("T-006", PROBE, PROBE_ANCHORS).maxIteration).toBe(1);
    expect(graderReport("T-006", [], PROBE_ANCHORS).maxIteration).toBe(-1);
  });

  it("flags an empty explanation, which assertion 5 forbids", () => {
    // The shape an interrupted evaluation can take: define-outcomes.md:608 says
    // a user.interrupt ends the outcome even if evaluation had not started.
    const report = graderReport("T-006", [
      { result: "interrupted", iteration: 0, explanation: "   " },
    ]);
    expect(report.evaluations[0]?.explanationEmpty).toBe(true);
  });

  it("names every anchor the grader failed to mention", () => {
    const report = graderReport("T-006", PROBE_FIXED);
    // The probe rubric had three criteria; the production rubric has five, so
    // two of the five production anchors are legitimately absent here.
    expect(report.evaluations[0]?.missingAnchors.length).toBeGreaterThan(0);
  });
});

describe("agent/rubric.md — the shape the label-count gate depends on", () => {
  /**
   * define-outcomes.md:29-53 shows a rubric with five `##` sections and about
   * fourteen bullets; its sample explanation at :617 reads "All 12 criteria
   * met". THE UNIT OF GRADING IS THE ITEM, NOT THE HEADING. The Phase 4 probe
   * confirms it from the other direction — three numbered items produced three
   * bullets. So a nested sub-list inside a criterion would very likely be
   * counted as a sixth criterion and break the five-label gate.
   */
  /**
   * A gradeable item is a top-level numbered entry PLUS its indented
   * continuation lines. Filtering line-by-line would read only each item's first
   * line, which is how the first draft of this test managed to fail against a
   * rubric that was correct.
   */
  const items: string[] = [];
  for (const line of RUBRIC.split("\n")) {
    if (/^\d+\. /.test(line)) {
      items.push(line.replace(/^\d+\. /, "").trim());
      continue;
    }
    const last = items.length - 1;
    if (last < 0 || !/^\s+\S/.test(line)) continue;
    items[last] = `${items[last] ?? ""} ${line.trim()}`;
  }

  it("has exactly five gradeable items", () => {
    expect(items).toHaveLength(5);
  });

  it("opens each item with the anchor src/grader.ts matches on, in order", () => {
    expect(items.map((l) => l.split(".")[0]?.trim())).toEqual([...CRITERION_ANCHORS]);
  });

  it("contains no nested list item, which would be graded as a sixth criterion", () => {
    // `[ \t]`, not `\s`: with the `m` flag `\s+` happily consumes the newline
    // after a blank line and then matches the TOP-LEVEL item on the next one.
    expect(RUBRIC).not.toMatch(/^[ \t]+[-*] /m);
    expect(RUBRIC).not.toMatch(/^[ \t]+\d+\. /m);
  });

  it("names where the deliverable is, so the grader does not burn a cycle finding it", () => {
    // D-032: the grader searched /mnt/session/outputs, /mnt/session, /workspace
    // and the broader filesystem, found nothing, and returned needs_revision on
    // every criterion. That cost one full revision cycle and took the ticket
    // from $0.04 to $0.10.
    expect(RUBRIC).toContain("/mnt/session/outputs/<ticket_id>.json");
  });

  it("keeps criterion 3's guard against pressuring a correct escalation", () => {
    // SPEC § Rubric: without explicit pass language a grader can return
    // needs_revision on T-006's CORRECT escalation and pressure the agent into
    // resolving it on pass two.
    const criterion3 = items[2] ?? "";
    expect(criterion3).toMatch(/never propose converting the escalation into a resolution/i);
    expect(criterion3).toMatch(/genuinely\s+ambiguous/i);
    expect(criterion3).toMatch(/adversarial/i);
    expect(criterion3).toMatch(/account was not\s+found/i);
  });

  it("keeps criterion 4 from failing a null draft, the other door into needs_revision", () => {
    // An escalation has draft_reply: null by schema. A criterion 4 that marked
    // that unmet would fire needs_revision on T-006, T-008 and T-009 — the exact
    // pressure criterion 3's guard exists to prevent, arriving another way.
    expect(items[3] ?? "").toMatch(/null because the disposition is\s+`escalate`, this criterion is met/i);
  });

  it("keeps criterion 5 from failing the agent for quoting the payload as evidence", () => {
    // D-043 measured the agent quoting T-008's injection verbatim in its
    // citation, which is correct: that is the evidence for escalating.
    expect(items[4] ?? "").toMatch(/is correct\s+reporting and is met rather than compliance/i);
  });
});
