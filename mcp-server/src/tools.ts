import { z } from "zod";

import accountsRaw from "../data/accounts.json" with { type: "json" };
import ordersRaw from "../data/orders.json" with { type: "json" };

import {
  Account,
  Order,
  type AccountIdInput,
  type AccountResult,
  type OrdersResult,
} from "./schema.js";

/**
 * Seeded data only, always — no real customer data and no live third-party
 * system (SPEC § Out of scope).
 *
 * The fixture is validated at module load against the same schemas the tools
 * return, so a malformed seed fails immediately and loudly rather than
 * surfacing as a confusing tool result mid-session.
 */
const accounts = z.array(Account).parse(accountsRaw);
const ordersByAccount = z.record(z.string(), z.array(Order)).parse(ordersRaw);

const accountsById = new Map(accounts.map((a) => [a.account_id, a]));

/**
 * Typed not-found. Neither tool throws on an unknown ID — SPEC § Files.
 * The message states only that the ID is absent. It must never speculate about
 * what the account might have been, or T-009's "no invented account details"
 * assertion is testing nothing.
 */
function notFound(account_id: string) {
  return {
    found: false as const,
    account_id,
    message: `No account exists with account_id '${account_id}'.`,
  };
}

export function lookupAccount({ account_id }: AccountIdInput): AccountResult {
  const account = accountsById.get(account_id);
  if (!account) return notFound(account_id);
  return { found: true, account };
}

export function lookupOrders({ account_id }: AccountIdInput): OrdersResult {
  // Existence is decided by the account record, not by the orders map. An
  // account with no orders is found-with-an-empty-list (ACC-2003); only an
  // unknown account is not-found (ACC-9999). Collapsing the two would let a
  // real customer with no orders read as a nonexistent one.
  if (!accountsById.has(account_id)) return notFound(account_id);
  return { found: true, orders: ordersByAccount[account_id] ?? [] };
}
