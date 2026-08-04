/**
 * The `TriageDecision` boundary.
 *
 * SPEC § Files → `src/decision.ts` specifies these two schemas verbatim; this
 * file is a transcription of that block, not a design of its own.
 *
 * PHASE 3 SCOPE — schema only. SPEC § Files also assigns this file the
 * "custom-tool handler", and SPEC § Verification lists a
 * `tests/decision-schema.test.ts` suite. Both are Phase 4, together with
 * docs/DECISIONS.md D-005's unresolved problem: `z.toJSONSchema()` cannot
 * represent the three `.refine()` calls below, so `agent.yaml`'s published
 * `input_schema` for `submit_triage_decision` will not carry them and the
 * cross-field invariants have to be enforced host-side. Nothing here depends on
 * that being resolved.
 *
 * It exists now because SPEC § Files types `ConsumerResult.decision` as
 * `TriageDecision | null`, and `src/events.ts` should compile against the real
 * shape rather than a placeholder Phase 4 would have to remove.
 */

import { z } from "zod";

export const Citation = z.object({
  source: z.enum(["ticket_field", "mcp_record"]),
  reference: z.string(), // e.g. "ticket.body" or "lookup_account.known_issues"
  value: z.string(), // the literal text or record value relied on
});

/**
 * `disposition` has three values, not two. SPEC § Files: declining a refund
 * because the record says the window closed (T-005) is an autonomous decision,
 * not an escalation, and the rubric grades it as one.
 */
export const TriageDecision = z
  .object({
    ticket_id: z.string(),
    category: z.enum([
      "billing",
      "technical",
      "account-access",
      "refund-request",
      "other",
    ]),
    disposition: z.enum(["auto_resolve", "decline", "escalate"]),
    citations: z.array(Citation),
    draft_reply: z.string().nullable(),
    escalation_reason: z.string().nullable(),
    suspected_injection: z.boolean(),
  })
  .refine(
    (d) => d.disposition === "escalate" || d.citations.length >= 1,
    "auto_resolve and decline require at least one citation",
  )
  .refine(
    (d) => d.disposition === "escalate" || d.draft_reply !== null,
    "auto_resolve and decline require a draft reply",
  )
  .refine(
    (d) => d.disposition !== "escalate" || d.escalation_reason !== null,
    "escalate requires an escalation reason",
  );

export type Citation = z.infer<typeof Citation>;
export type TriageDecision = z.infer<typeof TriageDecision>;
