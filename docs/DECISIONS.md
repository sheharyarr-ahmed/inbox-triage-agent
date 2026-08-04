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

## Phase 3 — the SSE consumer

### D-021 · The committed fixture is a Phase 2 capture, not a Phase 3 one

**Deviates from SPEC § Verification**, which says *"The fixture is a real trace
captured once in Phase 3 and committed."*

`tests/fixtures/session-events.jsonl` is `docs/evidence/phase-2-session.jsonl`
copied byte-for-byte. It is a real trace; only its provenance differs.

Considered: (a) capture fresh. The acceptance criterion asks for a session
"incl. one tool call", and the Phase 2 trace already carries an
`agent.mcp_tool_use` / `agent.mcp_tool_result` pair, so a re-run buys no event
type the repo does not already hold — measured cost **~$0.011**. (b) Re-run
`pnpm smoke` with trace capture to obtain real `span.outcome_evaluation_*`
events — **~$0.024–0.074**, but on a throwaway agent against a two-line inline
rubric, which Phase 6 supersedes with the real one. (c) Promote the Phase 2
capture.

Chose (c). Phase 3 spend: **$0.00**. SPEC § Cost controls #2 — "Full runs happen
at phase acceptance, not during iteration" — and #4 point the same way.

**What the Phase 2 trace structurally cannot contain**, and why no amount of
money fixes it in this phase: `agent.custom_tool_use` and therefore
`session.status_idle` with `stop_reason: requires_action` require agent
version 2 carrying `submit_triage_decision`, which is Phase 4 work and blocked
behind D-005. So `tests/fixtures/synthetic-events.jsonl` is a **separate** file,
never mixed with the real one, holding a hand-built Phase-4-shaped session. Every
line is traceable to a cited SDK interface or a measured shape — the
`span.outcome_evaluation_end` usage block is D-017's recorded zero-filled payload
verbatim rather than an invention.

### D-022 · Stream exhaustion is not completion

**SPEC § The SSE consumer specifies the reconnect procedure but never says what
triggers it.** Read from the SDK source rather than the docs, which are silent:
`@anthropic-ai/sdk/core/streaming.js:119-133`. A clean server-side close ends the
`for await` **silently**; `controller.abort()` also returns **silently**; only a
socket drop throws.

So the iterator running out proves nothing. Only a terminal event proves
completion. `consumeEvents` therefore treats exhaustion-without-a-terminal-event
as a dropped stream and reconnects, and **throws** rather than returning a
`ConsumerResult` if reconnects are exhausted — returning one would let Phase 4
record a ticket as finished on `end_turn` that never finished.

### D-023 · The unknown-event claim, stated to match what is actually proven

The SDK filters SSE frames against a hardcoded allowlist of event names
(`core/streaming.js:56-101`); a frame whose name is not on it is never yielded.
So SPEC § The SSE consumer's default branch is **unreachable on the live stream
for a genuinely novel type** — the consumer cannot crash on it because it never
sees it.

The property is real on the paths that carry plain JSON: fixture replay and
`sessions.events.list()`. And it is genuinely exercised on the live stream by
three names that are on the allowlist but have no TypeScript union member —
`agent.session_thread_message_received`, `agent.session_thread_message_sent`,
`session.thread_status_created`. `tests/events.test.ts` uses those three plus one
wholly invented type, so the test is not an exercise against a straw man.

Recorded because the honest claim and the flattering claim differ here, and
`/defend` will be answered against this file.

### D-024 · Amendment A-2 accepted and applied to SPEC

Was raised in Phase 2 as a proposed amendment; the operator accepted both halves
on 2026-08-04 and SPEC § The SSE consumer's `processed_at` paragraph is rewritten
accordingly. Full reasoning is in A-2 below, retained rather than deleted so the
raise-then-rule sequence stays auditable.

Code consequence, and the reason it is worth applying rather than merely noting:
`processed_at` is informational only. It is never a state-machine input and never
a dedupe key anywhere in `src/events.ts`; `event.id` handles repeats.

### D-025 · `src/events.ts` owns the terminal gate, and both callers were refactored onto it

Phase 2 left byte-identical terminal gates inline in `src/run.ts:202-215` and
`src/smoke-outcomes.ts:229-238`. Both are deleted; both files now call
`consumeSession()`. The gate exists once, in `terminalReason()`, and is under
test.

Considered leaving the Phase 2 files untouched, since both are committed
acceptance artifacts and a refactor changes proven code without a live re-run.
Rejected: the duplication is precisely what Phase 3 exists to remove, Phase 4
rewrites `run.ts` into the ten-ticket driver regardless, and the offline suite
plus `pnpm -s typecheck` cover the refactor. Their acceptance output is unchanged
so the Phase 2 evidence stays comparable.

Three behaviours moved into the consumer rather than being dropped on the floor:

1. **`onOpen`.** Refactoring naively introduced a real regression — Phase 2 fully
   awaited the stream before sending, and calling `consumeSession()` then sending
   alongside it races the two HTTP requests. That is exactly the race SPEC
   § Session topology step 2 exists to prevent, and it fails intermittently
   rather than loudly. `onOpen` is awaited after the stream is open and before
   the first event is read.
2. **`SpendLimitReached`.** Both files aborted on `session.error` with
   `billing_error`. That is consumer behaviour every future caller needs under a
   $5 hard cap, so it throws — with the partial `ConsumerResult` attached,
   because on a spend-limit run those events are the only record of what was
   bought. `terminatedBy` has no value for it, which is why it is an exception
   and not a fifth union member.
3. **`onEvent`.** Raw per-event side effect, so `run.ts` still writes its JSONL
   trace as events arrive rather than from the returned array. The run that
   throws is the run whose trace matters most.

### D-026 · `durationMs` is derived, and labelled that way

SPEC § Files requires `toolCalls: { name, durationMs }[]`. **No duration field
exists on any event**, and `processed_at` is a *completion* stamp
(`events-and-streaming.md:22`). The figure is the gap between two `processed_at`
values, paired on `agent.mcp_tool_result.mcp_tool_use_id` (verified in the Phase 2
trace) or `agent.tool_result.tool_use_id` (`events.d.ts:297`).

That is honest for a tool call — the use event completes when the model emits it,
the result event when the result lands; the real trace gives 419ms for
`lookup_account`, which is a plausible HTTPS round trip to Vercel. But adjacent
events are co-stamped to the microsecond, so the value is clamped at zero and the
CLI prints it as `(derived)`. It is not a platform-reported latency and
`docs/EVIDENCE.md` must not present it as one.

### D-027 · Mutation-checked, because a test that cannot fail proves nothing

The suite's whole claim is that it catches the two bugs SPEC names. Each was
reintroduced and the suite confirmed red, then reverted:

| Mutation | Result |
|---|---|
| Terminal gate breaks on bare idle, ignoring `stop_reason` | **3 tests fail** |
| Dedupe `continue` placed before the terminal check | **1 test fails** |
| `onOpen` started but not awaited (send races the stream) | **1 test fails** |

The third mutation initially **passed**, which exposed a weak test rather than
working code: the assertion could not distinguish "awaited" from "merely started"
because its `onOpen` resolved synchronously. A real send is an HTTP round trip,
so the test now yields before recording, and the mutation fails as it should.

### D-028 · Deferred to Phase 7 — `pnpm -s test` is offline but not hermetic

Not a Phase 3 change. Recorded so a cleared session does not rediscover it while
wiring the Stop hook, same as D-012 was for the MCP permission policy.

SPEC § Files makes `.claude/verify.sh` a *"Stop hook gate. Runs `pnpm -s test`
only"*, and SPEC § Verification calls that suite *"Fully offline, zero spend, no
network."* Offline it is. **Hermetic it is not.**

Measured 2026-08-04 by moving `.env.local` aside and re-running:

```
Test Files  1 failed | 2 passed (3)
Tests       53 passed (53)
❯ src/config.ts:90:20
❯ src/env-file.ts:16:1
```

`tests/env-file.test.ts` imports `src/env-file.ts`, which imports `ENV_PATH` from
`src/config.ts`, which executes `export const env = load()` at module scope and
throws unless `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `MCP_SERVER_URL` and
`MCP_SERVER_TOKEN` are all present. So the suite cannot run from a fresh clone,
and it could not run in CI.

Pre-existing, introduced in Phase 2 with D-016 — not caused by Phase 3.
`tests/events.test.ts` is deliberately clean of it: it resolves its own fixture
path rather than importing `REPO_ROOT` from `config.ts`, which is why 53 tests
still pass with the file missing.

Phase 7 options, not chosen here: split the constant so `env-file.ts` does not
import the validating module; make `config.ts` validate lazily instead of at
import; or have the suite provide a fixture env. The first is smallest and keeps
`config.ts`'s fail-fast behaviour for the executables that actually need it.

---

## Proposed `SPEC.md` amendments

SPEC § Subagents: *"A finding that contradicts this spec is escalated to the
operator, never silently applied."*

**Status:** A-2 was **accepted in full on 2026-08-04 and applied to `SPEC.md`**
(see D-024); its text is kept below so the raise-then-rule sequence stays
auditable. A-1, A-3 and A-4 remain raised and unruled. A-5 and A-6 are new in
Phase 3. None of the open ones block Phase 4.

### A-1 · § Cost controls #1 describes a method that under-reports

Covered in full by D-017. SPEC directs summing
`span.model_request_end.model_usage` and `span.outcome_evaluation_end.usage`;
the second is zero-filled in practice, so the method misses all grader spend.
Suggested replacement: treat `session.usage` as authoritative and derive the
grader's share. **This is the one amendment with a real consequence** — it is
the difference between a $0.0116 estimate and a $0.0242–0.0744 reality, on a
build with a $5 hard cap.

### A-2 · ✅ ACCEPTED 2026-08-04, APPLIED — § The SSE consumer, `processed_at`: the exception list is incomplete AND the model is wrong

**Ruled on by the operator in Phase 3. SPEC is rewritten; see D-024.** One
confirmation arrived after this was first raised: the SDK types corroborate the
exception half independently — `BetaManagedAgentsUserDefineOutcomeEvent`
declares `processed_at: string` (required), while
`BetaManagedAgentsUserMessageEvent` and `BetaManagedAgentsUserInterruptEvent`
declare it `string | null` and optional. The original text follows.

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

### A-5 · § The SSE consumer's terminal gate omits `session.deleted` — RAISED IN PHASE 3

SPEC names exactly two terminal conditions: `session.status_terminated`, and
`session.status_idle` when `stop_reason.type !== 'requires_action'`. There is a
third, and the SDK states it outright (`events.d.ts:650-652`):

> Emitted when a session has been deleted. **Terminates any active event stream**
> — no further events will be emitted for this session.

`reference.md:51` says the same. A session deleted mid-run leaves SPEC's loop
waiting on a dead socket until the wall clock fires — five minutes of nothing per
ticket, and a ticket recorded as `escalated_by_timeout` for a reason that has
nothing to do with the ticket.

`ConsumerResult.terminatedBy` has no value for it. **Applied provisionally in
`terminalReason()` mapped to `terminated`**, because leaving a known hang in the
one module Phase 4 depends on was the worse of the two options — flagged here
rather than left silent. If the operator prefers a distinct
`terminatedBy: 'deleted'`, it is a one-line change plus the union.

### A-6 · D-018 mis-sources `retries_exhausted` — RAISED IN PHASE 3

D-018 lists `retries_exhausted` among five SPEC claims it says the three
late-pulled reference pages substantiated. It does not appear in any of the
fifteen pages in `docs/reference/`; a grep returns hits only in `SPEC.md:144` and
in D-018's own sentence.

**The value is real** — `BetaManagedAgentsSessionRetriesExhausted`
(`events.d.ts:707-712`): *"The turn ended because repeated errors exhausted the
retry budget or an error escalated to `retry_status: 'exhausted'`."* It is one of
exactly three members of the `stop_reason` union, so SPEC's `terminatedBy` maps
onto it 1:1 and nothing downstream changes.

Only the provenance is wrong: the source is the installed SDK's type
declarations, not `reference.md`. Worth correcting because D-018's claim that
each of the five is "now sourced" is what a reader would rely on, and `/defend`
answers from this file.
