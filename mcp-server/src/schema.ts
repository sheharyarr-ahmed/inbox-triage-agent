import { z } from "zod";

/**
 * Zod on input and output, per SPEC § Decisions → MCP server.
 *
 * Both tools return a typed not-found object. Neither throws on an unknown ID.
 * An agent that receives a clean not-found and escalates is the behaviour
 * under test (T-009), so the not-found path must be a normal, well-typed
 * result rather than an error.
 */

export const AccountIdInput = z.object({ account_id: z.string().min(1) });

export const Account = z.object({
  account_id: z.string(),
  plan_tier: z.enum(["free", "starter", "pro", "business"]),
  status: z.enum(["active", "suspended", "closed"]),
  signup_date: z.string(), // ISO 8601
  open_ticket_count: z.number().int(),
  refund_window_status: z.enum(["inside", "outside", "not_applicable"]),
  refund_window_ends: z.string().nullable(),
  known_issues: z.array(z.string()), // e.g. ["duplicate_charge:CHG-88213"]
});

export const Order = z.object({
  order_id: z.string(),
  account_id: z.string(),
  status: z.enum(["pending", "shipped", "delivered", "refunded", "failed"]),
  amount_usd: z.number(),
  placed_at: z.string(),
});

export const NotFound = z.object({
  found: z.literal(false),
  account_id: z.string(),
  message: z.string(),
});

export const AccountResult = z.union([
  z.object({ found: z.literal(true), account: Account }),
  NotFound,
]);

export const OrdersResult = z.union([
  z.object({ found: z.literal(true), orders: z.array(Order) }),
  NotFound,
]);

export type AccountIdInput = z.infer<typeof AccountIdInput>;
export type Account = z.infer<typeof Account>;
export type Order = z.infer<typeof Order>;
export type NotFound = z.infer<typeof NotFound>;
export type AccountResult = z.infer<typeof AccountResult>;
export type OrdersResult = z.infer<typeof OrdersResult>;
