import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AccountResult, OrdersResult } from "./schema.js";
import { lookupAccount, lookupOrders } from "./tools.js";

export const SERVER_NAME = "support-records";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds the MCP server. Deliberately a factory, not a module-level singleton.
 *
 * In stateless mode the Streamable HTTP transport refuses to serve a second
 * request ("Stateless transport cannot be reused across requests"), so both
 * the server and its transport must be constructed per invocation. Hoisting
 * either to module scope works on the first request of a warm Vercel instance
 * and fails on every one after it — the worst possible failure shape.
 *
 * SPEC § Files calls this file the Vercel function entry. It cannot be one:
 * Vercel's zero-config Node builder only detects `api/**` (verified against
 * Vercel CLI 58.1.0's builder table). The actual entry is `api/mcp.ts`, which
 * imports this. See docs/DECISIONS.md.
 */
export function buildServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "lookup_account",
    {
      title: "Look up a support account",
      description:
        "Fetch the account record for an account_id: plan tier, status, signup date, " +
        "open ticket count, refund-window status, and any known issues already on file. " +
        "Returns found=false with no account fields when the account_id does not exist — " +
        "this is a normal result, not an error. Never infer account details that are " +
        "absent from the returned record.",
      inputSchema: { account_id: z.string().min(1) },
      // MCP requires outputSchema to be an object schema; SPEC's AccountResult
      // is a top-level union, which the SDK cannot normalise (it silently drops
      // the schema from tools/list and returns isError on every call). Wrapping
      // preserves the union as `anyOf` and leaves SPEC's schema.ts untouched.
      outputSchema: { result: AccountResult },
    },
    async ({ account_id }) => {
      const result = lookupAccount({ account_id });
      return {
        // The text block is the flat result: it is what the model reads and
        // cites, so citations stay of the form `lookup_account.known_issues`.
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { result },
        // isError deliberately unset — a clean not-found is a successful call.
      };
    },
  );

  server.registerTool(
    "lookup_orders",
    {
      title: "Look up an account's orders",
      description:
        "Fetch every order on file for an account_id, each with order_id, status " +
        "(pending, shipped, delivered, refunded, failed), amount_usd, and placed_at. " +
        "Call this before answering any question whose resolution depends on order " +
        "state; do not infer order status from the ticket text. An account with no " +
        "orders returns found=true with an empty list, which is different from an " +
        "account_id that does not exist (found=false).",
      inputSchema: { account_id: z.string().min(1) },
      outputSchema: { result: OrdersResult },
    },
    async ({ account_id }) => {
      const result = lookupOrders({ account_id });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { result },
      };
    },
  );

  return server;
}
