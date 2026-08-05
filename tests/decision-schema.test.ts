/**
 * SPEC § Verification → On every turn (Stop hook):
 *   "`TriageDecision` accepts each valid disposition shape and rejects:
 *    auto_resolve with zero citations, auto_resolve with null draft, escalate
 *    with null reason, an invented category."
 *
 * Plus the drift assertion that makes docs/DECISIONS.md D-005's resolution
 * hold: the `input_schema` published on agent/agent.yaml is GENERATED from
 * `src/decision.ts`, so the two can silently diverge the moment either is
 * edited. Deep-equality against a freshly generated schema catches that
 * offline, for $0, on every turn.
 *
 * `agent/agent.yaml` is resolved locally rather than through `src/config.ts`'s
 * `REPO_ROOT`, deliberately and for the same reason `tests/events.test.ts` does
 * it: `config.ts` runs `load()` at import time and would couple this suite to a
 * populated `.env.local`. See docs/DECISIONS.md D-028.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inventedAccountFields, unsupportedClaims } from "../src/assertions.js";
import { TriageDecision } from "../src/decision.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A decision that satisfies all three `.refine()` calls. */
const escalation = {
  ticket_id: "T-006",
  category: "other",
  disposition: "escalate",
  citations: [],
  draft_reply: null,
  escalation_reason: "Mixes an unspecified fault with a refund demand.",
  suspected_injection: false,
};

const resolved = {
  ticket_id: "T-002",
  category: "technical",
  disposition: "auto_resolve",
  citations: [
    { source: "ticket_field", reference: "ticket.body", value: "CSV export drops the last row" },
  ],
  draft_reply: "Thanks for the detail — we have reproduced it.",
  escalation_reason: null,
  suspected_injection: false,
};

const declined = {
  ...resolved,
  ticket_id: "T-005",
  category: "refund-request",
  disposition: "decline",
  citations: [
    { source: "mcp_record", reference: "lookup_account.refund_window_status", value: "outside" },
  ],
  draft_reply: "The refund window for this account closed on 15 June.",
};

describe("TriageDecision accepts every valid disposition shape", () => {
  it("accepts an escalation with no citations and a null draft", () => {
    expect(TriageDecision.safeParse(escalation).success).toBe(true);
  });

  it("accepts an auto_resolve with a citation and a draft", () => {
    expect(TriageDecision.safeParse(resolved).success).toBe(true);
  });

  it("accepts a decline citing the record it declined on", () => {
    // SPEC § Files: declining a refund because the record says the window
    // closed is an autonomous decision, not an escalation.
    expect(TriageDecision.safeParse(declined).success).toBe(true);
  });
});

describe("TriageDecision rejects the four shapes SPEC names", () => {
  it("rejects auto_resolve with zero citations", () => {
    const bad = TriageDecision.safeParse({ ...resolved, citations: [] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("at least one citation");
  });

  it("rejects auto_resolve with a null draft_reply", () => {
    const bad = TriageDecision.safeParse({ ...resolved, draft_reply: null });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("require a draft reply");
  });

  it("rejects escalate with a null escalation_reason", () => {
    const bad = TriageDecision.safeParse({ ...escalation, escalation_reason: null });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("escalation reason");
  });

  it("rejects an invented category", () => {
    expect(TriageDecision.safeParse({ ...resolved, category: "suspicious" }).success).toBe(false);
  });
});

describe("the published input_schema tracks src/decision.ts", () => {
  /**
   * The schema is committed as a one-line JSON flow mapping, which YAML 1.2
   * accepts because it is a JSON superset. That is what lets this test parse it
   * with no YAML dependency — the repo has three runtime deps and adding one
   * for a single assertion is not worth it.
   */
  const published = (): unknown => {
    const yaml = readFileSync(resolve(REPO, "agent/agent.yaml"), "utf8");
    const line = yaml.split("\n").find((l) => l.trimStart().startsWith("input_schema:"));
    if (!line) throw new Error("no input_schema line in agent/agent.yaml");
    return JSON.parse(line.slice(line.indexOf("input_schema:") + "input_schema:".length).trim());
  };

  const generated = (): Record<string, unknown> => {
    const schema = z.toJSONSchema(TriageDecision) as Record<string, unknown>;
    // Stripped before publishing: no tools.md example carries it, and this test
    // must assert the shape actually sent, not the raw generator output.
    delete schema["$schema"];
    return schema;
  };

  it("matches a freshly generated schema exactly", () => {
    expect(published()).toEqual(generated());
  });

  it("publishes every field as required, so no key can arrive missing", () => {
    const schema = generated();
    expect(schema["required"]).toEqual(Object.keys(schema["properties"] as object));
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("does NOT carry the three cross-field invariants — D-005, stated as measured", () => {
    // This is the defect, asserted rather than assumed. z.toJSONSchema() does
    // not throw on `.refine()`; it drops it silently, which is why the
    // invariants are restated in the tool description and enforced host-side in
    // run.ts. If a future zod release starts emitting them, this test fails and
    // the host-side path gets re-examined instead of quietly becoming dead code.
    const json = JSON.stringify(generated());
    expect(json).not.toContain("allOf");
    expect(json).not.toContain("oneOf");
    expect(json).not.toContain("if");

    // And the schema genuinely admits what the refinements reject.
    const invalidPerRefinement = { ...resolved, citations: [] };
    expect(TriageDecision.safeParse(invalidPerRefinement).success).toBe(false);
    const schema = generated();
    const citations = (schema["properties"] as Record<string, Record<string, unknown>>)["citations"];
    expect(citations?.["minItems"]).toBeUndefined();
  });
});

/**
 * SPEC § Verification's two assertions that read INSIDE a decision. Extracted to
 * `src/assertions.ts` so they are testable without importing the driver, which
 * runs `main()` at module scope.
 */
describe("unsupportedClaims — ship-gate assertion 3, second clause", () => {
  const base = {
    ticket_id: "T-004",
    category: "refund-request" as const,
    disposition: "auto_resolve" as const,
    escalation_reason: null,
    suspected_injection: false,
  };

  it("passes a draft whose every figure is cited", () => {
    expect(
      unsupportedClaims({
        ...base,
        draft_reply: "We can refund $149.00 for order ORD-4101.",
        citations: [
          { source: "mcp_record", reference: "lookup_orders.amount_usd", value: "149" },
          { source: "mcp_record", reference: "lookup_orders.order_id", value: "ORD-4101" },
        ],
      }),
    ).toEqual([]);
  });

  it("does NOT flag $149.00 against a citation of 149 — numbers compare numerically", () => {
    // The regression this test exists for. A substring matcher reported T-004
    // as promising an uncited figure when the figure was cited correctly, which
    // buried the one real failure in the same run.
    expect(
      unsupportedClaims({
        ...base,
        draft_reply: "a refund of $149.00",
        citations: [
          { source: "mcp_record", reference: "lookup_orders.amount_usd", value: "149" },
        ],
      }),
    ).toEqual([]);
  });

  it("flags an order id and amount that no citation supports", () => {
    // T-005 as actually decided: it promised ORD-4201 and $89 while citing only
    // the refund window.
    expect(
      unsupportedClaims({
        ...base,
        ticket_id: "T-005",
        disposition: "decline",
        draft_reply: "your June order (ORD-4201, $89) is outside the window",
        citations: [
          { source: "mcp_record", reference: "lookup_account.refund_window_status", value: "outside" },
        ],
      }).sort(),
    ).toEqual(["89", "ORD-4201"]);
  });

  it("ignores bare years, which are calendar context and not a promise", () => {
    expect(
      unsupportedClaims({
        ...base,
        draft_reply: "the window ends August 28, 2026",
        citations: [
          {
            source: "mcp_record",
            reference: "lookup_account.refund_window_ends",
            value: "2026-08-28T23:59:59Z",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("passes an escalation, which has no draft to check", () => {
    expect(
      unsupportedClaims({ ...base, disposition: "escalate", draft_reply: null, citations: [], escalation_reason: "x" }),
    ).toEqual([]);
  });

  it("does NOT flag a prior ticket id named because memory informed the decision", () => {
    // Phase 5 regression, and the same failure D-040 records wearing a new
    // costume. SKILL.md now tells the agent to name an earlier ticket's id when
    // account memory bore on this one, so "T-001" legitimately appears in a
    // draft. Before the ticket form joined the strip list, the number scan
    // extracted `001` from it and reported a phantom uncited figure on entirely
    // correct work — and a checker that fires on correct work buries the real
    // finding beside it.
    //
    // A ticket id is a pointer to a prior ticket, not a promise about an order
    // or an amount, so it needs no citation of its own — which is why it is
    // stripped before numbers are read but is NOT added to the id-claim check.
    expect(
      unsupportedClaims({
        ...base,
        ticket_id: "T-010",
        draft_reply: "Following up on T-001, the duplicate charge is with our billing team.",
        citations: [
          { source: "mcp_record", reference: "lookup_account.known_issues", value: "duplicate_charge:CHG-88213" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("inventedAccountFields — the T-009 supporting assertion", () => {
  it("accepts a citation of the not-found record", () => {
    expect(
      inventedAccountFields({
        ticket_id: "T-009",
        category: "account-access",
        disposition: "escalate",
        citations: [{ source: "mcp_record", reference: "lookup_account.found", value: "false" }],
        draft_reply: null,
        escalation_reason: "no such account",
        suspected_injection: false,
      }),
    ).toEqual([]);
  });

  it("flags a citation naming an Account field the tool never returned", () => {
    expect(
      inventedAccountFields({
        ticket_id: "T-009",
        category: "account-access",
        disposition: "escalate",
        citations: [
          { source: "mcp_record", reference: "lookup_account.plan_tier", value: "pro" },
        ],
        draft_reply: null,
        escalation_reason: "x",
        suspected_injection: false,
      }),
    ).toEqual(["lookup_account.plan_tier"]);
  });
});
