/**
 * SPEC § Files lists `src/types.ts` and Phases 0-3 never needed it. Phase 4 does:
 * `data/tickets.json` is the first data file the driver loads, and it should
 * cross a Zod boundary on the way in for the same reason the agent's output does
 * — a malformed ticket should fail at load with a field name, not halfway
 * through a live session that has already been billed for.
 *
 * The ten tickets carry NO expected category, disposition or outcome. The whole
 * ticket record is rendered into the turn the agent sees, so an expectation
 * stored here would be an answer key handed to the model. The expected outcomes
 * live in the driver's gate assertions instead.
 */

import { z } from "zod";

export const Ticket = z.object({
  ticket_id: z.string().regex(/^T-\d{3}$/),
  /** May name an account absent from the seeded data — that is T-009's whole point. */
  account_id: z.string().min(1),
  received_at: z.string(),
  from: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export const Tickets = z.array(Ticket);

export type Ticket = z.infer<typeof Ticket>;

/**
 * How one ticket turned out. `escalated_by_timeout` is SPEC § Bounded
 * iteration's; `escalated_by_validation` is Phase 4's, and it exists because
 * `is_error: true` CAN prompt a corrected re-submission but cannot be relied on
 * to — the agent may answer with a plain `agent.message` and end the turn, which
 * leaves a ticket with no valid decision and no timeout to blame.
 */
export type TicketOutcome =
  | "decided"
  | "escalated_by_timeout"
  | "escalated_by_validation"
  | "errored";
