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

**RESOLVED 2026-08-03 in Phase 2.** `agent/agent.yaml` sets it on the
`mcp_toolset` entry:

```yaml
  - type: mcp_toolset
    mcp_server_name: support-records
    default_config:
      enabled: true
      permission_policy: { type: always_allow }
```

Now sourced rather than inferred. `docs/reference/permission-policies.md:205`:
*"MCP toolsets default to `always_ask`. This ensures that new tools added to an
MCP server do not execute in your application without approval. To auto-approve
tools from a trusted MCP server, set `default_config.permission_policy` on the
`mcp_toolset` entry."*

Verified three ways, not asserted: the create response echoed
`always_allow`; `scripts/apply-control-plane.sh` fails the apply if it ever
reads back anything else; and the Phase 2 acceptance session executed
`lookup_account` with no approval stall.

---

## Phase 2 — hello world on the runtime

### D-014 · Phase 2 `agent.yaml` omits `skills` and the custom tool

**Deviates from SPEC § Runtime configuration**, which lists both.

Neither can be applied yet. `skills` needs `agent/skills/triage/SKILL.md`, and
`submit_triage_decision` needs the `TriageDecision` JSON Schema — which D-005
records as an open problem, because `z.toJSONSchema()` cannot represent its
three `.refine()` calls.

Considered: (a) commit the full SPEC shape with placeholders — it cannot be
applied, so Phase 2 would have no acceptance criterion to meet; (b) two YAML
files, one appliable and one aspirational — two sources of truth for one
resource; (c) ship what applies now.

Chose (c). Phase 4 runs `ant beta:agents update --agent-id … --version 1` to add
both, producing agent version 2. That is the versioning story SPEC already
depends on — sessions pin `{type: agent, id, version}`, so the Phase 2 trace in
`docs/evidence/` stays reproducible after Phase 4 lands, and Phase 4 gets an
auditable diff instead of a second create.

The `system` prompt ships in full now: the three guardrails depend on no later
phase, so the split SPEC § The guardrail split describes is visible from
version 1.

### D-015 · Inline text rubric for the smoke test

SPEC § Session topology and § Rubric specify `rubric: {type: file, file_id}`,
uploaded from `agent/rubric.md` — a Phase 6 artifact that does not exist.

`docs/reference/define-outcomes.md:55` documents an inline form as the primary
example: *"Pass the rubric as inline text on `user.define_outcome` … or upload
it through the Files API for reuse across sessions."* The SDK types it as
`{type: 'text', content: string}`, max 262,144 characters.

Used the text form for the smoke test only. It removes the Files API, a
beta-header question, and a failure mode from a test whose sole job is to prove
the outcomes primitive exists. Not a contradiction — SPEC's file form is for the
ten production sessions, where "byte-identical rubric across ten sessions" is
the reproducibility claim, and the doc supports both.

### D-016 · `scripts/apply-control-plane.sh`, plus `src/env-file.ts`

**Deviates from SPEC § Files**, which lists no `scripts/` directory.

`ant beta:agents create` is not idempotent — it mints a new agent on every
invocation and silently accumulates orphans. The create-vs-update branch has to
live somewhere reproducible from a clean clone; a README of commands pasted by
hand is not that, and cannot express the branch.

Two corrections to SPEC's example command line, both from the docs:

- **`--raw-output`, not `-r`.** The short form appears nowhere in the reference
  set; the long form appears ten times, always as `--transform id --raw-output`.
- The key goes in a **per-command environment** (`ANTHROPIC_API_KEY=… ant …`)
  rather than `--api-key`, which SPEC's example uses. A command-line argument is
  visible in `ps` to every user on the box. This is still not a shell export —
  it exists only for the `ant` process, so SPEC's billing-boundary guarantee is
  unchanged.

`src/env-file.ts` exists so the "never drop a key" invariant on `.env.local` has
exactly one implementation, shared by the shell script and `deploy.ts`. It is
covered by `tests/env-file.test.ts` — a fourth suite beyond SPEC § Verification's
three, added because that file holds the only copy of the workspace-scoped API
key and keys cannot move between workspaces.

Two hardenings came directly out of writing that test:

1. **`path` is a required parameter with no default.** An earlier draft
   defaulted it to `.env.local`; a test that failed to pass its temp path
   silently wrote the real file. The invariant caught the key, but the write
   should not have been possible.
2. **Newlines in a value are rejected.** The dropped-key invariant does not
   catch line injection — nothing is lost, something is added — so a value
   containing `\n` would silently corrupt the file.

### D-017 · The cost estimate cannot be computed the way SPEC specifies

**Contradicts SPEC § Cost controls, control #1**, which says `run.ts`
*"accumulates `span.model_request_end.model_usage` and
`span.outcome_evaluation_end.usage` and prints a per-run dollar estimate."*

**Measured 2026-08-03 across two sessions.** `span.outcome_evaluation_end.usage`
came back **all zeros** on all three evaluations of the smoke run, verbatim:

```json
{"iteration":0,"result":"needs_revision","usage":{"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"input_tokens":0,"output_tokens":0}}
```

`define-outcomes.md:619` shows a populated example, so the field is specified —
the platform simply is not filling it in. Summing the two span families as SPEC
directs therefore **under-reports**:

| Run | Grader ran | Summed spans | `session.usage` | Gap |
|---|---|---|---|---|
| smoke | yes, 3 evaluations | 5,995 | 16,353 | **10,358 unreported** |
| hello world | no | 8,456 | 8,456 | 0 — exact match |

The two runs isolate it. With no grader, spans reconcile to `session.usage`
exactly, field for field, so `span.model_request_end` covers the agent
completely. With a grader, the entire grader spend is missing from every span
event. SPEC's method would have reported **$0.0116 for a run that cost
$0.0242–0.0744**.

`src/cost.ts` therefore treats **`session.usage` as authoritative** and
**derives** the grader's share by subtracting the agent spans, rather than
reading the grader's own events. The agent share stays exact — the model is
pinned in `agent.yaml`.

Two limits stand regardless, and they bound what the estimate can honestly
claim:

- **No model attribution.** Neither usage block carries a model identifier, and
  no reference page names the grading model. SPEC correction #3 is confirmed —
  `user.define_outcome` has no grader-model parameter. Grader spend is reported
  as a range (Haiku floor, Opus 5 ceiling) with the assumption stated, never as
  a single fabricated number.
- **A cold measurement over-estimates a ten-ticket run.** `events-and-streaming.md`
  notes a 5-minute default cache TTL; the hello-world run already showed 4,239
  cache-creation tokens, which back-to-back sessions would read instead of write.

**Confirmed as a side effect:** SPEC § Cost controls asserts *"The dominant cost
is the grader."* Measured at **63% of session tokens** on the smoke run. That was
previously an unsupported assumption.

### D-018 · Three more reference pages — the snapshot is now fifteen

`permission-policies.md`, `reference.md`, and `session-operations.md` were
linked from the original twelve but never pulled. Between them they carried
five load-bearing claims SPEC made that this repo could not substantiate:
`session.status_terminated`, `span.model_request_end.model_usage`, `is_error` on
`user.custom_tool_result`, `retries_exhausted`, and the poll-then-archive rule.
Each is now sourced. Provenance and the specific line references are in
`docs/reference/README.md`.

`reference.md` also supplies rate limits SPEC never recorded: **300 rpm on
create endpoints, 1,200 rpm on read endpoints**, per organization. Relevant to
Phase 4's ten-session run.

### D-019 · Console trace URL is constructed, not returned

SPEC § Verification assertion 1 requires a Console trace URL printed per
session. **No reference page documents such a URL or any response field carrying
one** — `events-and-streaming.md` § Console observability describes the tracing
view by navigation only.

`consoleTraceUrl()` in `src/config.ts` builds it from `ANTHROPIC_WORKSPACE_ID`:

```
https://platform.claude.com/workspaces/${ANTHROPIC_WORKSPACE_ID}/sessions/${sessionId}
```

The workspace segment cannot be `default` — the session response does not carry
a workspace field, and a `default` link to a session in another workspace lands
on "Session not found".

**Open for Phase 8:** `events-and-streaming.md:2727` states tracing views are
*"only accessible to Developers and Admins."* If the key's workspace role is
lower, ship-gate condition 6's Console screenshots are unobtainable. Confirm
before Phase 8, not during it.

### D-020 · `pnpm provision` and `pnpm session`, not `deploy` and `run`

`pnpm deploy` and `pnpm run` are **reserved pnpm subcommands**. `pnpm deploy`
fails with `ERR_PNPM_NOTHING_TO_DEPLOY` rather than running the script.

Script names are `smoke`, `provision`, and `session`. The **files** keep the
names SPEC § Files specifies — `src/deploy.ts`, `src/run.ts` — since only the
npm script name collides. `verify:live` still has no entrypoint and is still not
added.

---

## Proposed `SPEC.md` amendments — raised, NOT applied

SPEC § Subagents: *"A finding that contradicts this spec is escalated to the
operator, never silently applied."* Four, for the operator to accept or reject.
None of them block Phase 3.

### A-1 · § Cost controls #1 describes a method that under-reports

Covered in full by D-017. SPEC directs summing
`span.model_request_end.model_usage` and `span.outcome_evaluation_end.usage`;
the second is zero-filled in practice, so the method misses all grader spend.
Suggested replacement: treat `session.usage` as authoritative and derive the
grader's share. **This is the one amendment with a real consequence** — it is
the difference between a $0.0116 estimate and a $0.0242–0.0744 reality, on a
build with a $5 hard cap.

### A-2 · § The SSE consumer, `processed_at` — the exception list is incomplete AND the model is wrong

SPEC, verbatim:

> Client-sent events appear twice, first with `processed_at: null` while queued
> and again once processed. The exception is `user.define_outcome` and
> `user.custom_tool_result` […]

Two problems.

**The list is short one.** `events-and-streaming.md:22` names *three*
exceptions, adding `user.tool_result`. That one is `self_hosted`-only per
`reference.md`, so it is off this build's path — but the sentence states the
list as closed and it is not.

**"Appear twice" did not hold when measured.** In the Phase 2 acceptance trace
(`docs/evidence/phase-2-session.jsonl`) a plain `user.message` — not one of the
named exceptions — appeared **exactly once**, with `processed_at` already
populated:

```json
{"id":"sevt_01319m6rTtjyuymu1wP3pjkS","processed_at":"2026-08-03T11:55:58.925038Z"}
```

Honest reading: the session was idle with nothing queued ahead of the message,
so there was nothing to queue behind, and the doc's *"null while the event is
still queued"* is conditional on a backlog. What is falsified is SPEC's
unconditional *"appear twice"* framing, not the queueing mechanic. A
pending-state UI keyed on "first sighting is always null" would fail for
`user.message` too, not only for the two SPEC names.

### A-3 · § Session topology step 6 — the reason is empirical, the rule is now sourced

SPEC: *"Archiving straight off the idle event intermittently returns 400 because
the stream emits idle slightly before the queryable status catches up."*

`session-operations.md:531` states the rule outright and more strongly:
*"A `running` session cannot be archived; send an interrupt event if you need to
archive it immediately."* That is a documented constraint, not an intermittent
race. SPEC's stated *cause* remains undocumented. The poll-then-archive remedy
is correct either way and is what `run.ts` does.

### A-4 · § Decision capture may be incompatible with the outcomes grader

**Raised as a Phase 6 risk, not a Phase 2 finding. Not established.**

Across all three smoke-test iterations the grader reported it could not find
anything to grade, verbatim:

> Unable to locate any deliverables from the agent. No output files or responses
> could be found in the filesystem to evaluate against the rubric.

The agent had produced a correct `agent.message` containing exactly the required
text. The grader did not count it.

SPEC § Decision capture deliberately routes the decision through the custom tool
`submit_triage_decision` rather than through session output files, citing the
Files API indexing lag. **If the grader reads the sandbox filesystem rather than
the event stream, a custom-tool payload may be invisible to it** — and no
ticket's rubric could ever be satisfied.

What is NOT established: the smoke agent had every built-in tool disabled, so it
genuinely could not write a file. The grader's "no deliverables" may simply have
been accurate. One observation, degenerate setup.

Cheap to settle in Phase 6 before committing to the design: enable `write`, have
the agent write to `/mnt/session/outputs/`, and compare against a run where the
deliverable exists only as a custom-tool payload.
