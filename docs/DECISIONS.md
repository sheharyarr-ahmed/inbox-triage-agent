# Decisions

Architectural choices and deviations from `SPEC.md`, recorded at each phase
boundary per SPEC § Session protocol. Each entry states the alternatives
considered and why this one won, so the choice is defensible without re-reading
the code.

---

## Phase 0 — verification, reference snapshot, scaffolding

### D-001 · pnpm workspace with a second package at `mcp-server/`

**Deviates from SPEC § Files** — adds `pnpm-workspace.yaml` and
`mcp-server/package.json`, neither of which SPEC lists.

Considered: (a) single root `package.json`, relying on Vercel's "Include source
files outside of the Root Directory" dashboard toggle; (b) a pnpm workspace.

Chose (b). Vercel deploys with Root Directory = `mcp-server` and needs a
`package.json` there to resolve `@modelcontextprotocol/sdk` at build time.
Option (a) works but hinges on a setting that lives only in the Vercel
dashboard — nothing in the repo records it, so a fresh clone cannot reproduce
the deploy. A committed workspace file can.

### D-002 · SPEC Correction #1 amended: the memory beta header

The spec claimed `agent-memory-2026-07-22` "does not appear in the current
reference". It does. `docs/reference/memory.md` requires it on
`/v1/memory_stores` endpoints *instead of* `managed-agents-2026-04-01`, and
says sending both returns 400. Verified against the live page before amending.

The blueprint was right and the v1 correction over-corrected. SPEC's own
tiebreaker — "where `docs/reference/` contradicts training data, the docs win" —
decides it. The `dreaming-2026-04-21` half stands unverified and unstated.

Consequence: any explicit-header code path must switch headers per endpoint
family. The SDK does this automatically, so this is a documentation and defend
correction rather than a code change.

### D-003 · Twelve reference pages, not nine

SPEC § Verification lists nine. Added `agent-setup`, `tools`, and
`environments` because Phase 2 writes `agent.yaml` and `environment.yaml`
against exactly those surfaces, and pulling them costs nothing. Flagged as
additions in `docs/reference/README.md` so the deviation is visible.

### D-004 · TypeScript 7.0.2, `@types/node` pinned to `^24`

`@types/node@latest` is 26.x; the runtime is Node 24.14.1. The major tracks the
Node major, so `latest` would type-surface APIs absent at runtime. Pinned `^24`.

TypeScript 7 was taken rather than 5.x/6.x, then proven: a probe file with two
deliberate errors confirmed `strict` and `noUncheckedIndexedAccess` are live
(TS2322, TS2345), so the typecheck gate is not vacuously passing.

### D-005 · No `zod-to-json-schema`

zod 4.4.3 ships `z.toJSONSchema()`. The separate package is still maintained
but redundant. Relevant in Phase 4, which needs a JSON Schema for
`submit_triage_decision`.

**Open risk for Phase 4:** `toJSONSchema` cannot represent `.refine()`.
`SPEC § Files → src/decision.ts` defines `TriageDecision` with three `.refine()`
calls, and `agent.yaml` needs its JSON Schema. The refinements will be dropped
or throw. The cross-field invariants will have to be enforced host-side in
`run.ts` when validating the custom-tool payload, not by the published schema.

---

## Phase 1 — MCP server, standalone

### D-006 · `api/mcp.ts` is the deployed entry; `src/index.ts` is demoted to a module

**Deviates from SPEC § Files** — adds `mcp-server/api/mcp.ts`, and changes the
role of `mcp-server/src/index.ts` from "Vercel Node function entry" to a
`buildServer()` module.

Vercel's zero-config Node builder detects functions only under
`api/**/*.+(js|mjs|ts|tsx)` — verified directly against Vercel CLI 58.1.0's
builder table, not from documentation. `src/index.ts` is not a detectable
entrypoint under any current mechanism.

Considered: (a) `vercel.json` `functions` pointing at `src/index.ts` — does not
work; `functions` only *configures* files already detected as functions;
(b) the legacy `builds` property — deprecated, and it suppresses all outputs
not produced by a listed build; (c) renaming to `src/server.ts`, which Vercel
does auto-detect — but that requires calling `server.listen()` at module scope,
which is wrong for a serverless handler; (d) `api/mcp.ts` plus a rewrite.

Chose (d). It is also the shape of Vercel's own MCP template. `vercel.json`
rewrites `/mcp` → `/api/mcp`, so the public URL still matches the
`MCP_SERVER_URL` that SPEC § Runtime configuration pins.

### D-007 · `outputSchema` wraps the union instead of using it directly

**Deviates from SPEC § Files' wire contract**, but leaves `schema.ts` untouched.

MCP requires `outputSchema` to be a JSON Schema of `type: "object"`. SPEC
defines `AccountResult` / `OrdersResult` as top-level `z.union([...])`, which
cannot be represented. Verified empirically: passing the union directly makes
`tools/list` silently omit the schema, and makes **every** `tools/call` return
`isError: true` — including the clean not-found path that SPEC explicitly
requires to be a normal result.

Considered: (a) flatten to one object schema with `found: z.boolean()` and
optional members — flat wire shape, but `found:true` would no longer imply
`account` exists, moving that invariant out of the type system and into tests;
(b) drop `outputSchema` — weakens the typed-boundary claim; (c) wrap.

Chose (c): `outputSchema: { result: AccountResult }`, handler returns
`structuredContent: { result }`. The union survives as `anyOf`, `schema.ts`
stays byte-identical to SPEC, and the `content` text block the model reads and
cites stays flat, so citations remain of the form `lookup_account.known_issues`.

### D-008 · `WebStandardStreamableHTTPServerTransport`, not the Node transport

The SDK ships both. Considered the Node variant (`handleRequest(req, res)`),
which is what a Vercel Node function's `(req, res)` signature suggests.

Chose the Web Standard variant with a `fetch` export. Vercel pre-parses Node
request bodies, so the Node transport hangs on an already-consumed stream
unless the parsed body is threaded through as a third argument — a footgun with
no compile-time signal. The Web signature is Vercel's documented default, needs
no `@vercel/node` types dependency, and matches the shape in the SDK's own
JSDoc.

### D-009 · Stateless: a new server and transport per invocation

The stateless transport throws "Stateless transport cannot be reused across
requests" on its second use. Hoisting either object to module scope works on
the first request of a warm Vercel instance and fails on every one after it —
the worst failure shape available, since it passes a single smoke test. Both
are constructed inside the handler.

### D-010 · GET and DELETE return 405

SPEC is silent. A GET with `Accept: text/event-stream` is valid MCP and opens a
standing SSE stream; on Vercel that holds the invocation open to the ceiling
for zero work — billable wall-clock against the $10 budget in SPEC § Cost
controls. Only POST carries JSON-RPC for this workload, so everything else is
refused. `maxDuration` is 60s, matching Vercel's own MCP template; their README
suggests 800, which exceeds the Hobby cap.

### D-011 · `lookup_orders` decides existence from the account record

An account with no orders returns `{found: true, orders: []}`; only an unknown
`account_id` returns not-found. Deriving existence from the orders map instead
would make any real customer who has not ordered indistinguishable from a
nonexistent one, handing the agent a false escalation trigger and quietly
corrupting the T-009 gate.

### D-013 · Vercel project linked at `mcp-server/`, not at the repo root

The documented monorepo approach is to link at the repo root and set Root
Directory = `mcp-server` in project settings. That setting is only reachable
through an interactive `vercel link` prompt or the dashboard — nothing in the
repo records it, and a non-interactive `vercel link --yes` silently accepts the
default `./`, which produces a deploy with no function rather than an error.

Chose `vercel link --cwd mcp-server` instead, which makes `mcp-server/` itself
the project root. The deploy then needs no out-of-repo configuration and is
reproducible from a clean clone with a single documented command.

Trade-off: the deployed function installs from `mcp-server/package.json`
without the workspace lockfile, so its dependency resolution is not pinned the
way local development is. Acceptable for two direct dependencies
(`@modelcontextprotocol/sdk`, `zod`); revisit if that list grows.

Deploy command is `vercel deploy --prod --cwd mcp-server` from the repo root.
Vercel assigned the **first** deploy to production automatically regardless of
the absent `--prod` flag, so the preview-then-promote sequence collapsed into a
single production deploy on this one occasion. Subsequent deploys default to
preview as normal.

The project is named `mcp-server` after the directory. Cosmetic, and renameable
in the Vercel dashboard without changing the deployment URL.

### D-012 · Deferred to Phase 2 — `permission_policy` on the MCP toolset

Not a Phase 1 change, recorded so it is not rediscovered late.
`docs/reference/mcp-connector.md` states the MCP toolset defaults to
`permission_policy: always_ask`, which requires approval before every tool
call. SPEC § Runtime configuration declares
`{ type: mcp_toolset, mcp_server_name: support-records }` with no policy, so a
headless ten-session run would stall on every MCP call. `agent.yaml` must set
this explicitly in Phase 2 or Phase 4 cannot complete.
