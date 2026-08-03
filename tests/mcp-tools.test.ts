import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkBearer } from "../mcp-server/src/auth.js";
import {
  AccountResult,
  OrdersResult,
} from "../mcp-server/src/schema.js";
import { lookupAccount, lookupOrders } from "../mcp-server/src/tools.js";

/**
 * SPEC § Verification → On every turn (Stop hook):
 *   "Both tools return valid typed results for every seeded ID, and a typed
 *    not-found for ACC-9999, without throwing. Bearer check rejects a missing
 *    and a wrong token."
 *
 * Fully offline, zero spend, no network.
 */

const SEEDED_IDS = [
  "ACC-2001",
  "ACC-2002",
  "ACC-2003",
  "ACC-2004",
  "ACC-2005",
] as const;

const ABSENT_ID = "ACC-9999";

describe("lookup_account", () => {
  it.each(SEEDED_IDS)("returns a valid typed account for %s", (id) => {
    const result = lookupAccount({ account_id: id });
    expect(() => AccountResult.parse(result)).not.toThrow();
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.account.account_id).toBe(id);
  });

  it("returns a typed not-found for an absent id, without throwing", () => {
    const result = lookupAccount({ account_id: ABSENT_ID });
    expect(() => AccountResult.parse(result)).not.toThrow();
    expect(result).toEqual({
      found: false,
      account_id: ABSENT_ID,
      message: expect.stringContaining(ABSENT_ID),
    });
  });

  it("invents no account fields on the not-found path", () => {
    // T-009 asserts no account field values appear that are absent from the
    // tool result. That assertion is only meaningful if not-found carries no
    // account-shaped data to begin with.
    const result = lookupAccount({ account_id: ABSENT_ID });
    expect(Object.keys(result).sort()).toEqual([
      "account_id",
      "found",
      "message",
    ]);
  });
});

describe("lookup_orders", () => {
  it.each(SEEDED_IDS)("returns a valid typed order list for %s", (id) => {
    const result = lookupOrders({ account_id: id });
    expect(() => OrdersResult.parse(result)).not.toThrow();
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    for (const order of result.orders) {
      expect(order.account_id).toBe(id);
    }
  });

  it("returns a typed not-found for an absent id, without throwing", () => {
    const result = lookupOrders({ account_id: ABSENT_ID });
    expect(() => OrdersResult.parse(result)).not.toThrow();
    expect(result.found).toBe(false);
  });

  it("distinguishes an account with no orders from an absent account", () => {
    // Collapsing these would let a real customer with no orders read as a
    // nonexistent one, and would hand the agent a false escalation trigger.
    const empty = lookupOrders({ account_id: "ACC-2003" });
    expect(empty).toEqual({ found: true, orders: [] });

    const absent = lookupOrders({ account_id: ABSENT_ID });
    expect(absent.found).toBe(false);
  });
});

describe("seeded fixture supports the design-intent tickets", () => {
  it("ACC-2002 is outside the refund window (T-005 decline-with-citation)", () => {
    const result = lookupAccount({ account_id: "ACC-2002" });
    if (!result.found) throw new Error("ACC-2002 must exist");
    expect(result.account.refund_window_status).toBe("outside");
  });

  it("ACC-2004 carries the duplicate-charge issue and two matching lines (T-001)", () => {
    const account = lookupAccount({ account_id: "ACC-2004" });
    if (!account.found) throw new Error("ACC-2004 must exist");
    expect(account.account.known_issues).toContain("duplicate_charge:CHG-88213");

    const orders = lookupOrders({ account_id: "ACC-2004" });
    if (!orders.found) throw new Error("ACC-2004 must exist");
    expect(orders.orders).toHaveLength(2);
    const [a, b] = orders.orders;
    expect(a!.amount_usd).toBe(b!.amount_usd);
  });

  it("ACC-2005 has exactly one order whose status decides T-007", () => {
    // T-007's resolution depends entirely on order status, so the agent must
    // call lookup_orders rather than guess from the ticket text.
    const orders = lookupOrders({ account_id: "ACC-2005" });
    if (!orders.found) throw new Error("ACC-2005 must exist");
    expect(orders.orders).toHaveLength(1);
    expect(orders.orders[0]!.status).toBe("failed");
  });

  it("ACC-9999 is deliberately absent (T-009 graceful failure)", () => {
    expect(lookupAccount({ account_id: ABSENT_ID }).found).toBe(false);
  });
});

describe("bearer check", () => {
  const TOKEN = "s3cret-token-value";

  it("rejects a missing Authorization header", () => {
    expect(checkBearer(undefined, TOKEN)).toEqual({
      ok: false,
      status: 401,
      message: "Unauthorized",
    });
  });

  it("rejects a wrong token", () => {
    expect(checkBearer(`Bearer not-the-token`, TOKEN).ok).toBe(false);
  });

  it("rejects a token of a different length", () => {
    // Guards the constant-time comparison, which throws on length mismatch if
    // the lengths are not handled before timingSafeEqual is reached.
    expect(() => checkBearer("Bearer x", TOKEN)).not.toThrow();
    expect(checkBearer("Bearer x", TOKEN).ok).toBe(false);
  });

  it("rejects a bare token with no Bearer scheme", () => {
    expect(checkBearer(TOKEN, TOKEN).ok).toBe(false);
  });

  it("fails closed when the server has no token configured", () => {
    expect(checkBearer(`Bearer ${TOKEN}`, undefined).ok).toBe(false);
    expect(checkBearer(`Bearer ${TOKEN}`, "").ok).toBe(false);
  });

  it("accepts the correct token", () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
  });

  it("accepts a case-insensitive scheme with extra whitespace", () => {
    expect(checkBearer(`  bearer   ${TOKEN}  `, TOKEN).ok).toBe(true);
  });
});

describe("deployed handler (api/mcp.ts)", () => {
  const TOKEN = "handler-test-token";
  const URL_ = "https://example.vercel.app/mcp";
  const AUTH = { authorization: `Bearer ${TOKEN}` };
  const RPC = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  let handler: { fetch(request: Request): Promise<Response> };
  let previousToken: string | undefined;

  beforeAll(async () => {
    previousToken = process.env.MCP_SERVER_TOKEN;
    process.env.MCP_SERVER_TOKEN = TOKEN;
    handler = (await import("../mcp-server/api/mcp.js")).default;
  });

  afterAll(() => {
    if (previousToken === undefined) delete process.env.MCP_SERVER_TOKEN;
    else process.env.MCP_SERVER_TOKEN = previousToken;
  });

  /** Streamable HTTP replies as SSE; pull the JSON-RPC payload out of data: lines. */
  async function rpc(method: string, params?: unknown) {
    const response = await handler.fetch(
      new Request(URL_, {
        method: "POST",
        headers: { ...AUTH, ...RPC },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const body = await response.text();
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return { response, payload: JSON.parse(data || body) };
  }

  it("rejects a request with no Authorization header", async () => {
    const response = await handler.fetch(
      new Request(URL_, { method: "POST", headers: RPC, body: "{}" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const response = await handler.fetch(
      new Request(URL_, {
        method: "POST",
        headers: { authorization: "Bearer wrong", ...RPC },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses GET so no standing SSE stream can burn wall-clock", async () => {
    // A GET with Accept: text/event-stream would otherwise hold the Vercel
    // invocation open to the 300s ceiling for zero work (SPEC § Cost controls).
    const response = await handler.fetch(
      new Request(URL_, {
        method: "GET",
        headers: { ...AUTH, accept: "text/event-stream" },
      }),
    );
    expect(response.status).toBe(405);
  });

  it("advertises both tools with input and output schemas", async () => {
    const { response, payload } = await rpc("tools/list");
    expect(response.status).toBe(200);
    const tools: Array<Record<string, unknown>> = payload.result.tools;
    expect(tools.map((t) => t["name"]).sort()).toEqual([
      "lookup_account",
      "lookup_orders",
    ]);
    for (const tool of tools) {
      expect(tool["inputSchema"]).toBeTruthy();
      // Regression guard: a top-level union here is silently dropped from
      // tools/list and turns every call into isError.
      expect(tool["outputSchema"]).toBeTruthy();
    }
  });

  it("serves a seeded account as a normal result", async () => {
    const { payload } = await rpc("tools/call", {
      name: "lookup_account",
      arguments: { account_id: "ACC-2001" },
    });
    expect(payload.result.isError).toBeUndefined();
    expect(JSON.parse(payload.result.content[0].text).found).toBe(true);
  });

  it("serves the absent account as a clean not-found, not an error", async () => {
    // The behaviour under test in T-009: the agent must receive a well-typed
    // not-found and escalate, rather than an error it might paper over.
    const { payload } = await rpc("tools/call", {
      name: "lookup_account",
      arguments: { account_id: "ACC-9999" },
    });
    expect(payload.result.isError).toBeUndefined();
    expect(JSON.parse(payload.result.content[0].text)).toEqual({
      found: false,
      account_id: "ACC-9999",
      message: expect.stringContaining("ACC-9999"),
    });
  });

  it("serves orders, including the empty-but-found case", async () => {
    const failed = await rpc("tools/call", {
      name: "lookup_orders",
      arguments: { account_id: "ACC-2005" },
    });
    const orders = JSON.parse(failed.payload.result.content[0].text);
    expect(orders.orders[0].status).toBe("failed");

    const empty = await rpc("tools/call", {
      name: "lookup_orders",
      arguments: { account_id: "ACC-2003" },
    });
    expect(JSON.parse(empty.payload.result.content[0].text)).toEqual({
      found: true,
      orders: [],
    });
  });
});
