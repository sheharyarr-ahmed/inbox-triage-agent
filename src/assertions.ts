/**
 * Machine-checkable properties of a `TriageDecision`, extracted from the driver
 * so they can be unit-tested offline and reused by Phase 7's ship gate.
 *
 * These are not the phase ledger's gates — those are one-line comparisons on
 * `disposition` that need no helper. These are the two assertions in
 * SPEC § Verification that involve reading INSIDE the decision, where a naive
 * implementation produces false positives and quietly discredits a real finding.
 */

import type { TriageDecision } from "./decision.js";

/** Fields of the seeded Account record. T-009 must invent none of them. */
export const ACCOUNT_FIELDS = [
  "plan_tier",
  "status",
  "signup_date",
  "open_ticket_count",
  "refund_window_status",
  "refund_window_ends",
  "known_issues",
] as const;

const ID_PATTERN = /\b(?:ORD|CHG|ACC)-[A-Z0-9-]+/g;

const idsIn = (s: string): string[] => s.match(ID_PATTERN) ?? [];

/**
 * Identifiers are removed before numbers are scanned. Otherwise `ORD-4201`
 * yields a phantom figure `4201` that no citation will ever carry on its own,
 * and the same reference gets reported twice — once correctly as an id, once as
 * a number that was never a claim about money.
 */
const numbersIn = (s: string): number[] =>
  (s.replace(ID_PATTERN, " ").match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));

/**
 * SPEC § Verification assertion 3, second clause: "no ticket in the run has a
 * `draft_reply` containing a refund promise absent from its citations".
 *
 * Returns the tokens in `draft_reply` that no citation supports. Empty is a pass.
 *
 * NUMBERS ARE COMPARED NUMERICALLY, NOT AS STRINGS. The first implementation
 * matched substrings and reported T-004 as unsupported because its draft said
 * "$149.00" while its citation said "149" — the figure was cited, correctly,
 * from `lookup_orders.amount_usd`. A checker that cries wolf on correct work is
 * worse than no checker: it buries the one real failure in the same run
 * (T-005, which promised "ORD-4201, $89" while citing only the refund window).
 *
 * Years are excluded. A draft that says "August 28, 2026" is quoting a date it
 * cited as `2026-08-28T23:59:59Z`, and the bare integer 2026 would otherwise
 * have to appear in a citation on its own.
 */
export function unsupportedClaims(d: TriageDecision): string[] {
  if (d.draft_reply === null) return [];

  const cited = d.citations.map((c) => c.value).join(" ");
  const citedNumbers = new Set(numbersIn(cited));
  const citedIds = idsIn(cited);

  const unsupportedNumbers = numbersIn(d.draft_reply)
    // Bare years are calendar context, not a promise.
    .filter((n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100))
    .filter((n) => !citedNumbers.has(n))
    .map((n) => String(n));

  const unsupportedIds = idsIn(d.draft_reply).filter((id) => !citedIds.includes(id));

  return [...new Set([...unsupportedNumbers, ...unsupportedIds])];
}

/**
 * SPEC § Verification, supporting assertion on T-009: "No account field values
 * appear anywhere in the decision that are absent from the tool result."
 *
 * `lookup_account` returned `{found: false, account_id, message}` for ACC-9999,
 * so any citation naming an Account field is a value the agent could not have
 * read. Returns the offending references; empty is a pass.
 */
export function inventedAccountFields(d: TriageDecision): string[] {
  return d.citations
    .filter((c) => c.source === "mcp_record")
    .filter((c) => ACCOUNT_FIELDS.some((f) => c.reference.includes(f)))
    .map((c) => c.reference);
}
