import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { checkBearer } from "../src/auth.js";
import { buildServer } from "../src/index.js";

/**
 * The Vercel function. Thin by design — all behaviour lives in ../src.
 *
 * Vercel's zero-config Node builder only detects functions under `api/**`
 * (verified against Vercel CLI 58.1.0's builder table), so this file, not
 * `src/index.ts`, is the deployed entry. `vercel.json` rewrites /mcp here so
 * the public URL matches MCP_SERVER_URL in SPEC § Runtime configuration.
 */

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    // The bearer gate runs before the transport sees anything. The token is
    // held in a vault as a static_bearer credential and attached by an
    // Anthropic-side proxy after the request leaves the sandbox, so prompt
    // injection in a ticket cannot exfiltrate it (SPEC § Decisions → MCP server).
    const auth = checkBearer(
      request.headers.get("authorization") ?? undefined,
      process.env.MCP_SERVER_TOKEN,
    );
    if (!auth.ok) {
      return jsonRpcError(auth.status, -32000, auth.message);
    }

    // Only POST carries JSON-RPC. A GET with Accept: text/event-stream would
    // open a standing SSE stream and hold the invocation open to the 300s
    // Hobby ceiling — billable wall-clock for zero work, against a $10 budget
    // (SPEC § Cost controls). Refuse it.
    if (request.method !== "POST") {
      return jsonRpcError(405, -32000, "Method not allowed. Use POST.");
    }

    // Stateless: a new server and transport per invocation. The transport
    // throws if reused, and Vercel instances are not sticky, so there is no
    // session to keep anyway.
    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      // connect() calls transport.start() and installs the message handler.
      // Reversing these two lines drops the request silently.
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch {
      return jsonRpcError(500, -32603, "Internal server error");
    }
  },
};
