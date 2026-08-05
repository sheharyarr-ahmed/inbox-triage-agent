/**
 * Reading the grader's verdict out of the one field it has. Phase 6.
 *
 * SPEC § Verification condition 5 asks for a "per-criterion rubric score".
 * THERE IS NO SUCH FIELD. `span.outcome_evaluation_end` carries one
 * `result: string` and one freeform `explanation: string`
 * (events.d.ts:962-1010), and define-outcomes.md:586 says the grader's reasoning
 * is "opaque: you see that it's working, not what it's thinking". Raised as
 * amendment A-7 and ruled 2026-08-05: the satisfiable reading is "an explanation
 * that names each rubric criterion and its verdict", which is what the platform
 * actually emits.
 *
 * THE FORMAT IS MEASURED, NOT ASSUMED. Three real evaluations across
 * docs/evidence/phase-4-probe-T-006.jsonl and phase-4-probe-fixed-T-006.jsonl,
 * every one of them:
 *
 *   - a lead line, and it differs by verdict: "An independent grader found all
 *     criteria met:" vs "...found the following criteria are not fully met:"
 *   - `- ` bullets, in rubric order
 *   - each bullet echoing the criterion's opening text, then `(met)` or
 *     `(not met)`, then prose
 *
 * WHICH criteria appear depends on the RESULT, and getting that wrong is how two
 * successive versions of this gate failed. Measured over 18 real evaluations:
 *
 *   satisfied              enumerates ALL five, every time — 7 of 7, 5 bullets each
 *   needs_revision         enumerates ONLY the unmet ones — 1 to 2 bullets
 *   max_iterations_reached enumerates ONLY the still-unmet ones — 1 to 3 bullets
 *
 * Each carries its own lead line, and they say so: "found all criteria met",
 * "found the following criteria are not fully met", "Reached 3 revision cycles
 * without satisfying the rubric".
 *
 * So a FULL enumeration exists only on `satisfied`, and `namesAllCriteria` is a
 * property of an evaluation rather than of a ticket. A ticket that never
 * satisfies never receives one — three did not — and that is a platform
 * property, not an agent defect. See D-055.
 *
 * TWO THINGS THAT MEASUREMENT KILLED, both of which a plausible implementation
 * would have got wrong:
 *
 * 1. `PROBE_RUBRIC` numbered its criteria `1.` `2.` `3.` and the grader
 *    STRIPPED EVERY NUMBER — `leading digits present: false` on all nine
 *    bullets. A-7's filed recommendation was to number the criteria "so each one
 *    is individually quotable"; numbering is not what makes them quotable. The
 *    echoed opening text is, which is why `CRITERION_ANCHORS` exists.
 *
 * 2. The echo is NOT byte-exact. Terminal periods drop; criterion 3's second
 *    sentence was echoed in one evaluation, truncated in another, and omitted in
 *    a third. So nothing here may match a full criterion string — only a short
 *    distinctive prefix that survived all three.
 *
 * Pure functions, no I/O, no SDK types. `tests/grader.test.ts` runs them against
 * the three real explanations above, which cost $0 because they are already
 * committed.
 */

/**
 * The opening words of each criterion in `agent/rubric.md`, which is what the
 * grader echoes. Hardcoded rather than parsed out of the file so this module
 * stays pure and free of `config.ts` (D-028: importing it makes a test
 * non-hermetic). Drift is caught offline instead — `tests/grader.test.ts`
 * asserts `agent/rubric.md` has exactly five gradeable items opening with
 * exactly these, in this order.
 */
export const CRITERION_ANCHORS = [
  "Valid category",
  "Traceable justification",
  "Correct escalation",
  "Grounded draft",
  "Instruction isolation",
] as const;

export type CriterionAnchor = (typeof CRITERION_ANCHORS)[number];

/**
 * THREE, not two. Phase 4's three evaluations only ever emitted `(met)` and
 * `(not met)`, so a two-value union looked safe. The ten-ticket run emitted
 * **`(partially met)` seven times** across 18 evaluations, and a parser matching
 * only the first two dropped every one of them silently — under-reporting a real
 * verdict, which is D-040's failure with the sign reversed.
 *
 * Counted over the acceptance run: 35 `met`, 9 `not met`, 7 `partially met`.
 * The 35 are exactly the 7 `satisfied` evaluations at five criteria each.
 */
export type Verdict = "met" | "not met" | "partially met";

export type CriterionVerdict = {
  /** The bullet's text, echoed from the rubric and not byte-exact to it. */
  text: string;
  verdict: Verdict;
  /**
   * Which rubric criterion this bullet is, resolved by matching the anchor
   * against the echoed text. NEVER resolved by position: a `needs_revision`
   * explanation lists only the criteria that FAILED, so bullet 1 of 1 can be
   * criterion 3. Reading it positionally labelled T-001's failing "Correct
   * escalation" as "Valid category" — D-040's cry-wolf shape.
   */
  anchor: string | null;
};

/** One `span.outcome_evaluation_end`, reduced to what a gate needs. */
export type Evaluation = {
  result: string;
  iteration: number;
  explanation: string;
};

/**
 * Case-insensitive because nothing documents the casing, and the qualifier is
 * captured rather than assumed absent — see `Verdict` for what assuming cost.
 * The three labels are mutually exclusive substrings, so detection is
 * order-independent.
 */
const LABEL = /\((not|partially)?\s*met\)/i;

/**
 * Split an explanation into its per-criterion bullets.
 *
 * A bullet starts at a line beginning with `- ` and runs until the next such
 * line or a blank line. All three real explanations put each bullet on one line,
 * but a wrapped bullet must not silently become two criteria, so continuation
 * lines are folded in rather than dropped.
 *
 * Only bullets CARRYING A VERDICT LABEL are returned. The lead line and the
 * trailing "Please revise your work to address these gaps." are not bullets and
 * never appear; a bullet with no label is not a criterion verdict and is
 * excluded, which makes a short count visible to the gate rather than papered
 * over.
 */
export function parseCriteria(
  explanation: string,
  anchors: readonly string[] = CRITERION_ANCHORS,
): CriterionVerdict[] {
  const blocks: string[] = [];
  for (const line of explanation.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      blocks.push(trimmed.slice(2).trim());
      continue;
    }
    const last = blocks.length - 1;
    if (trimmed === "" || last < 0) continue;
    blocks[last] = `${blocks[last] ?? ""} ${trimmed}`;
  }

  const out: CriterionVerdict[] = [];
  for (const text of blocks) {
    const match = LABEL.exec(text);
    if (!match) continue;
    const lower = text.toLowerCase();
    const qualifier = match[1]?.toLowerCase();
    out.push({
      text,
      verdict:
        qualifier === "not" ? "not met" : qualifier === "partially" ? "partially met" : "met",
      anchor: anchors.find((a) => lower.includes(a.toLowerCase())) ?? null,
    });
  }
  return out;
}

/**
 * The verdict the grader gave one named criterion, or null if it did not name
 * it at all. Null and `"not met"` are different findings and the caller has to
 * tell them apart: the first says the explanation is malformed, the second says
 * the decision failed.
 */
export function criterionVerdict(
  explanation: string,
  anchor: string,
): Verdict | null {
  const needle = anchor.toLowerCase();
  for (const criterion of parseCriteria(explanation)) {
    if (criterion.text.toLowerCase().includes(needle)) return criterion.verdict;
  }
  return null;
}

/**
 * Index of the last `agent.custom_tool_use` that a grader evaluation had already
 * seen — that is, the last one occurring BEFORE the final
 * `span.outcome_evaluation_end`. Null when nothing was graded.
 *
 * WHY THIS EXISTS. `define-outcomes.md:606`: on `max_iterations_reached`, "One
 * final acknowledgment turn follows before the session transitions to `idle`."
 * The agent submits again on that turn, and the driver — which records the last
 * accepted submission — recorded THAT one. So for any ticket that exhausted the
 * cap, the decision in the committed artifact was never graded. Measured on the
 * Phase 6 acceptance run:
 *
 *   T-002  escalate → grade → auto_resolve → grade → escalate → grade(max_iter)
 *          → auto_resolve   ← recorded, ungraded
 *   T-003  escalate → grade → auto_resolve → grade → auto_resolve → grade(max_iter)
 *          → escalate       ← recorded, ungraded
 *
 * It is also why the grader's final explanation appeared to argue against the
 * disposition the JSON held: it was arguing against a different decision.
 *
 * Returning an index rather than a parsed decision keeps this module free of
 * `decision.ts`, and lets the same function run live over `ConsumerResult.events`
 * and offline over a committed JSONL trace.
 */
export function lastGradedSubmissionIndex(
  events: readonly { type?: string }[],
): number | null {
  let lastEvaluation = -1;
  for (const [i, e] of events.entries()) {
    if (e?.type === "span.outcome_evaluation_end") lastEvaluation = i;
  }
  if (lastEvaluation < 0) return null;

  let submission: number | null = null;
  for (const [i, e] of events.entries()) {
    if (i >= lastEvaluation) break;
    if (e?.type === "agent.custom_tool_use") submission = i;
  }
  return submission;
}

export type EvaluationReport = {
  iteration: number;
  result: string;
  /** Empty explanation is a FAILURE: SPEC § Verification assertion 5. */
  explanationEmpty: boolean;
  criteria: CriterionVerdict[];
  /** Anchors this evaluation never named. */
  missingAnchors: string[];
  /** Every criterion named, each with a verdict. Only a full enumeration. */
  namesAllCriteria: boolean;
};

export type TicketGraderReport = {
  ticketId: string;
  evaluations: EvaluationReport[];
  /** -1 when nothing was evaluated, so a bare `<= 2` cannot pass vacuously. */
  maxIteration: number;
  /** True once this ticket has received one full five-criterion enumeration. */
  namesAllCriteria: boolean;
  /**
   * The bar SPEC § Verification assertion 5 can actually hold to: every
   * `satisfied` evaluation this ticket produced enumerated all five criteria
   * with a verdict. Vacuously true for a ticket that never satisfied, which is
   * why the run-level gate also counts how many did.
   */
  satisfiedEnumerateAll: boolean;
  /** How many of this ticket's evaluations came back `satisfied`. */
  satisfiedCount: number;
};

/**
 * Everything SPEC § Verification assertion 5 asks about one ticket, derived from
 * that ticket's evaluations and nothing else.
 */
export function graderReport(
  ticketId: string,
  evaluations: readonly Evaluation[],
  anchors: readonly string[] = CRITERION_ANCHORS,
): TicketGraderReport {
  const reports: EvaluationReport[] = evaluations.map((e) => {
    const criteria = parseCriteria(e.explanation, anchors);
    const named = new Set(criteria.map((c) => c.anchor).filter((a) => a !== null));
    const missingAnchors = anchors.filter((a) => !named.has(a));
    return {
      iteration: e.iteration,
      result: e.result,
      explanationEmpty: e.explanation.trim() === "",
      criteria,
      missingAnchors,
      namesAllCriteria: missingAnchors.length === 0 && criteria.length === anchors.length,
    };
  });

  const satisfied = reports.filter((e) => e.result === "satisfied");
  return {
    ticketId,
    maxIteration: evaluations.reduce((a, e) => Math.max(a, e.iteration), -1),
    evaluations: reports,
    namesAllCriteria: reports.some((e) => e.namesAllCriteria),
    satisfiedCount: satisfied.length,
    satisfiedEnumerateAll: satisfied.every((e) => e.namesAllCriteria),
  };
}
