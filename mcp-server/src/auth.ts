import { timingSafeEqual } from "node:crypto";

/**
 * Bearer check for the MCP endpoint, per SPEC § Decisions → MCP server.
 *
 * The same token is stored as the vault `static_bearer` credential. The
 * credential never enters the sandbox: the MCP tool call leaves the container,
 * an Anthropic-side proxy attaches the token, and the request arrives here
 * authenticated. That is the guardrail — prompt injection in a ticket cannot
 * exfiltrate a secret the sandbox never held.
 *
 * Kept as a pure function so the suite can assert on a missing and a wrong
 * token without standing up an HTTP server (SPEC § Verification).
 */

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401; message: string };

const UNAUTHORIZED = "Unauthorized";

/** Constant-time compare that does not leak length via early return. */
function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, so compare fixed-width digests
  // of equal size instead of returning early on differing lengths.
  if (a.length !== b.length) {
    // Still burn a comparison so the failure path costs the same either way.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * @param authorization the raw `Authorization` request header, if any
 * @param expectedToken the value of MCP_SERVER_TOKEN
 */
export function checkBearer(
  authorization: string | undefined,
  expectedToken: string | undefined,
): AuthResult {
  // A server with no configured token must fail closed, never open.
  if (!expectedToken) {
    return { ok: false, status: 401, message: UNAUTHORIZED };
  }
  if (!authorization) {
    return { ok: false, status: 401, message: UNAUTHORIZED };
  }

  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  if (!match?.[1]) {
    return { ok: false, status: 401, message: UNAUTHORIZED };
  }

  if (!tokensMatch(match[1], expectedToken)) {
    return { ok: false, status: 401, message: UNAUTHORIZED };
  }

  return { ok: true };
}
