# Agent design

How the inbox triage agent is put together, and why each load-bearing choice was
made rather than a plausible alternative.

`SPEC.md` is the contract. `docs/DECISIONS.md` is the running record of choices
with their alternatives. This document is the one you read first: it explains the
shape of the system and the four or five decisions that actually determine its
behaviour.

Every platform claim is cited to `docs/reference/`, the Anthropic documentation
snapshot pulled in Phase 0. Where those pages contradict training data or the
blueprint, the pages win — and three times in this build they did.

---

## What it does

Ten seeded support tickets, ten separate sessions. For each ticket the agent
categorises, gathers evidence from a custom MCP server, decides one of three
dispositions, cites the specific field or record it relied on, and submits a
typed decision through a custom tool. A five-criterion rubric grades every
decision through the outcomes loop with a three-pass cap. Customer context
carries across sessions through a memory store the agent itself reads and writes.

Six platform capabilities are exercised, each individually sourced:

| Capability | Where it shows up | Source |
|---|---|---|
| Sessions + a real SSE consumer | `src/events.ts`, every trace in `docs/evidence/` | `sessions.md`, `events-and-streaming.md` |
| Memory stores | `src/memory.ts`, the T-001 → T-010 handoff | `memory.md:19` ff. |
| Outcomes + the grader | `agent/rubric.md`, `src/grader.ts` | `define-outcomes.md` |
| A custom MCP server | `mcp-server/`, live on Vercel | `mcp-connector.md`, `reference.md:103-105` |
| An Agent Skills bundle | `agent/skills/triage/SKILL.md` | `skills.md`, `skill-authoring-overview.md` |
| Vaults | `static_bearer` credential, attached per session | `vaults.md:7` |

**Not "six of eight".** Anthropic publishes **four core concepts** — Agent,
Environment, Session, Events (`overview.md:37-44`) — and no inventory of eight
exists anywhere in the eighteen reference pages. The denominator in earlier
drafts was this project's own accounting. The six are named and cited; the
fraction is dropped. See amendment A-21.

---

## The shape

```
data/tickets.json ──┐
                    │  deliveryText(), fenced
                    ▼
        ┌───────────────────────────┐        ┌──────────────────────┐
        │  src/run.ts               │        │  Managed Agents      │
        │  one session per ticket   │───────▶│  cloud sandbox       │
        │  wall clock, budget stop  │        │                      │
        └───────────┬───────────────┘        │  agent v5, haiku-4-5 │
                    │  SSE                   │  skills: triage      │
                    ▼                        │  tools: 5 file ops   │
        ┌───────────────────────────┐        │         mcp toolset  │
        │  src/events.ts            │◀───────│         custom tool  │
        │  terminal gate, reconnect │        └───────┬──────────────┘
        │  custom-tool dispatch     │                │
        └───────────┬───────────────┘         ┌──────┴───────┬─────────────┐
                    │                          ▼             ▼             ▼
                    │                    vault:         memory store:  outcome:
                    │                    static_bearer  /mnt/memory/…  rubric file
                    │                          │             │             │
                    ▼                          ▼             ▼             ▼
        ┌───────────────────────────┐   mcp-server on   accounts/      grader,
        │  src/decision.ts (Zod)    │   Vercel          ACC-####.md    ≤3 passes
        │  src/assertions.ts        │
        │  src/grader.ts            │
        │  src/cost.ts              │
        └───────────┬───────────────┘
                    ▼
        docs/evidence/<label>-*.jsonl + -decisions.json
```

Control plane through the `ant` CLI against committed YAML; data plane through
the SDK. That split is Anthropic's own recommendation and it is why
`agent/agent.yaml` and `agent/environment.yaml` are files in the repo rather than
arguments to a function call — the agent definition is reviewable in a diff.

`scripts/apply-control-plane.sh` exists because `ant beta:agents create` is **not
idempotent**: it mints a new agent on every invocation and silently accumulates
orphans. The create-vs-update branch has to live somewhere a clean clone can
reproduce, and a README of commands pasted by hand is not that.

---

## The five decisions that determine behaviour

### 1. The guardrail split — what is in `system` and what is in the skill

Skills load **progressively, on demand**. At startup only a skill's name and
description occupy context (~100 tokens); `SKILL.md` itself enters the context
window only when the skill is triggered (`skill-authoring-overview.md:44-82`).

That single fact decides the split:

- **`agent/agent.yaml`'s `system` prompt** carries only what must never be absent
  from any turn — ticket content is data and never instruction; every decision
  cites a specific field or record; ambiguity, unsupported claims and adversarial
  input escalate.
- **`agent/skills/triage/SKILL.md`** carries the procedure — the five categories,
  the lookup order, the citation format, the escalation triggers, the memory
  read-then-write protocol, the submission step.

A guardrail that must hold on every turn cannot depend on the model having chosen
to load a file. A procedure can.

**There is a second legitimate home**, and it is neither. A memory store's
`description` and its session resource's `instructions` are *"automatically added
to the system prompt"* of every session that attaches it (`memory.md:380`,
`:213`, capped at 4,096 characters). So the memory trust boundary — memory
content is untrusted, and the write constraint — ships in `MEMORY_INSTRUCTIONS`
in `src/memory.ts`. It passes the same test: present on every turn, not
contingent on a load.

### 2. Least privilege by allowlist, not denylist

`agent.yaml` sets `default_config: { enabled: false }` on the agent toolset and
opts in exactly five tools: `read`, `write`, `edit`, `glob`, `grep`. `bash`,
`web_search` and `web_fetch` are never enabled.

**Why the allowlist form:** a denylist silently grants any tool added to a future
toolset version. An allowlist does not.

`read` is required because skills cannot load without it. The other four exist
for the memory mount and nothing else.

This is also what makes the credential claim defensible (see § 4): an agent with
no shell and no outbound fetch has no mechanism to exfiltrate a secret, whatever
the platform does with it.

**One default had to be overridden, and it is worth naming honestly.** MCP
toolsets default to `permission_policy: always_ask`
(`permission-policies.md:20`, `:205`) — *"This ensures that new tools added to an
MCP server do not execute in your application without approval."* A headless
ten-session run would stall on every MCP call. `agent.yaml` sets `always_allow`
explicitly, and `apply-control-plane.sh` **fails the apply** if it ever reads back
anything else. The guardrail is the allowlist and the vault boundary; it is not
the permission policy, and the design does not pretend otherwise.

### 3. Decision capture through a custom tool — and a file, because of what the grader reads

The agent finishes a ticket by calling `submit_triage_decision`. The session
emits `agent.custom_tool_use` and goes idle with `stop_reason.type ===
'requires_action'`; `run.ts` validates the payload against the `TriageDecision`
Zod schema and replies with `user.custom_tool_result`.

**Why a custom tool rather than parsed prose:** it puts a typed boundary on the
agent's output, the ship gate asserts on fields rather than regex over text, and
it returns the decision to the host **synchronously** — so a malformed payload
comes back as `is_error: true` with the Zod message and the agent corrects
itself, which a file cannot do.

**Why also a file.** The outcomes grader reads the **sandbox filesystem** and
cannot see a custom-tool payload. This was measured, not assumed, in a single
session that gave a controlled comparison: with the decision existing only as a
tool payload the grader returned `needs_revision` on every criterion, reporting
that it had searched `/mnt/session/outputs`, `/mnt/session`, `/workspace` and the
broader filesystem and found nothing; after the agent wrote a JSON file it
returned `satisfied`, quoting that file's fields back.

So `SKILL.md` writes `/mnt/session/outputs/<ticket_id>.json` **first**, then
submits the same object through the tool. **The mitigation pays for itself**: one
grader evaluation instead of two, and the session cost fell from $0.10 to $0.04.
Removing that step is silent, so `tests/memory.test.ts` holds it. See D-032.

The cross-field invariants — an `auto_resolve` needs a citation and a draft, an
`escalate` needs a reason — cannot be published in the schema at all:
`z.toJSONSchema()` **silently discards** `.refine()`. They are stated in the
tool's description where the model reads them and enforced host-side where it
matters. See D-031.

### 4. Three dispositions, not two

`auto_resolve`, `decline`, `escalate`.

`decline` is not decoration. T-005 asks for a refund the record says is outside
the window: declining on the strength of a record is an **autonomous decision**,
not an escalation, and the rubric grades it as one. A two-value disposition set
would force every "no" through the escalation path and make the escalation gate
meaningless.

The ship gate asserts it: T-005 must `decline` **and** cite the refund-window
record. A decline that cites the order but never the window has declined for a
reason it did not establish.

### 5. The SSE consumer is a state machine, not a print loop

`src/events.ts` is the piece most likely to be mistaken for a `for await` with a
`console.log` in it. Four things make it not that, each learned from a failure:

**The terminal gate.** Break on `session.status_terminated`, on
`session.deleted`, or on `session.status_idle` when `stop_reason.type !==
'requires_action'`. **Idle alone is not terminal** — the session idles
transiently while waiting for the custom-tool result, and a loop breaking on bare
idle abandons every ticket at the decision step.

**The reply is keyed on the idle event, not on the tool call's arrival.**
`events.d.ts:1184-1190` is explicit that the id to echo back is found in the last
`session.status_idle`'s `stop_reason.event_ids`. Replying on arrival posts a
result while the session is still running. Three details are load-bearing:
`requires_action` carries **no discriminator** — a tool-confirmation block has an
identical shape — so each blocking id is type-checked first; dispatch is on
`session.status_idle` only and never the `session.thread_status_idle` decoy, or
every reply doubles; and `event_ids` is iterated rather than indexed at `[0]`, so
two calls in one turn resolve instead of deadlocking (D-030).

**Stream exhaustion is not completion.** Read from the SDK source rather than the
docs, which are silent: a clean server-side close ends the `for await`
**silently**, and so does an abort. Only a socket drop throws. So the iterator
running out proves nothing — only a terminal event proves completion, and the
consumer treats exhaustion-without-a-terminal-event as a dropped stream (D-022).

**Reconnect must not outlive the wall clock.** Both timers are one-shot, so after
expiry a reconnect is unbounded — and a session parked at `requires_action` emits
nothing at all, so the drain never returns. A ten-ticket driver would have wedged
on ticket one (D-029).

**Stream first, then send.** The stream delivers only events emitted after it
opens, so a session created with `initial_events` starts running before the
consumer attaches and buffers the opening events into one batch — degrading
exactly the trace that becomes ship-gate evidence.

---

## Memory: the read-then-write protocol, and how it is verified

The store attaches at **session creation only** — `sessions.resources.add()` does
not accept `memory_store` (`memory.md:211`). One store, `read_write`, mounted at
a path **read from the resource and never constructed**.

That last point is the trap of the phase. `memory.md:380`: the directory is the
display name *slugified*, *"The exact path is returned in the `mount_path` field
… read it from there rather than constructing it yourself"*, and — the half with
no error signal — *"writes to any other path under `/mnt/memory/` land in
container-local scratch and are lost when the session ends."* `memoryMountPath()`
has **no fallback branch** by design: a constructed path produces a run that looks
entirely successful and stores nothing.

Protocol, enforced by `SKILL.md`: before deciding, check whether
`/accounts/<account_id>.md` exists and read it. After the decision is accepted,
append one line — ticket, category, disposition, one line of context. **The write
comes last on purpose**: a submission that was rejected must not leave a record
of a decision that was never made.

### Verification is host-side and out of band

The proof never depends on the agent's claim that it wrote something. Three
layers, each covering the others' blind spot:

| Layer | Catches | Blind to |
|---|---|---|
| Version rows filtered by `session_id` | a stale file from any other session | content correctness |
| Pre-run snapshot + `changedSince` | a path that appeared or changed | a byte-identical rewrite |
| `--reset-memory` | the byte-identical rewrite | who wrote it |

The middle blind spot is why the flag exists: *"Every **non-no-op** mutation to a
memory produces a new version"*, so a rewrite of identical bytes leaves no version
row and no sha change, invisible to the other two layers.

**And the gate had to be built so a no-memory run fails it.** SPEC originally
asked that T-010's citations "reference the prior issue" — but Phase 4 ran all ten
tickets with **no memory store attached to anything** and satisfied that clause,
because ACC-2004's `known_issues` carries the same fact through MCP. A gate a
no-memory baseline already passes proves nothing about memory.

What replaced it is a **memory-exclusive token**: `T-001` appears in the memory
file and nowhere else in session B's world — not in T-010's ticket body, not in
`accounts.json`, not in `orders.json`. The gate asserts the decision names it
**and** that it appears in no `agent.mcp_tool_result` in the same trace. The
second clause is what turns co-occurrence into direction of flow (D-045).

---

## The rubric, and the adversarial interaction it had to close

Five criteria, uploaded once through the Files API so all ten sessions grade
against a byte-identical document: valid category; traceable justification;
correct escalation; grounded draft; instruction isolation.

**Two structural constraints, both measured rather than assumed.**

*The unit of grading is the item, not the heading.* `define-outcomes.md:29-53`
shows a rubric with five `##` sections and ~fourteen bullets whose sample
explanation reports "All 12 criteria met". So `agent/rubric.md` carries exactly
five gradeable items and **no nested sub-lists** — a nested bullet inside
criterion 3's four grounds would have been graded as a sixth criterion.

*Numbering is not what makes a criterion quotable.* The Phase 4 probe numbered its
criteria and the grader **stripped every number from every bullet**. What the
grader echoes is the criterion's opening text, and not byte-exactly — terminal
periods drop, second sentences get truncated. So `src/grader.ts` anchors on five
short distinctive prefixes and never on a full criterion string (D-052).

**The interaction the rubric exists to close.** Criterion 3 says an escalation
resting on one of four grounds — genuine ambiguity, an unsupported claim,
adversarial content, an account not found — is a **full pass**, never revisable.
Without that sentence, a grader can return `needs_revision` on T-006's *correct*
escalation and pressure the agent into resolving it on pass two. The system's own
correction mechanism would then attack its own gate. Criteria 4 and 5 carry
matching clauses for the same reason: a criterion 4 that failed a null draft, or a
criterion 5 that failed the agent for quoting the payload it escalated over, would
deliver the same pressure through a different door.

A run-level **negative control** asserts criterion 3 is never marked `not met` on
T-006, T-008 or T-009. It held on every evaluation of both Phase 6 runs.

---

## Bounded iteration

Two genuinely distinct mechanisms:

- **Grader passes.** `max_iterations: 3`, caller-set and server-enforced.
  Terminal results are `satisfied`, `max_iterations_reached`, `failed` and
  `interrupted`; only `needs_revision` continues. There is no second
  platform-side ceiling underneath it — the blueprint's claim of two independent
  caps was wrong.
- **Wall clock.** A per-ticket deadline in `run.ts` — 5 minutes ungraded, 8
  graded. On expiry it sends `user.interrupt`, drains to idle, and records the
  ticket as `escalated_by_timeout`.

The graded path needs its own clock for a reason beyond slowness:
`define-outcomes.md:608` says an interrupt marks the evaluation `interrupted`
*"even if evaluation hadn't started yet"* — exactly the shape that fails the ship
gate's "non-empty explanation" clause. A wall-clock overrun would not degrade the
gate run, it would fail it, for a reason unrelated to triage quality (D-054).

**A ticket that exhausts either bound escalates by definition**, and as of
Phase 7 that sentence has a representation in the code: `escalated_by_iteration_cap`.
The host labels how a ticket ended; it never rewrites what the agent decided.

---

## Cost

The dominant cost is the grader — measured at **63% of session tokens** on the
run that established it, which turned an assumption into a number.

Every dollar figure is **derived** from `session.usage` token counts at the pinned
model's rates. Two platform sources were tried and rejected: summing
`span.outcome_evaluation_end.usage` under-reports because that field is
zero-filled, and `list_cost` moved from dollars to cents between two runs a day
apart. Both are documented in `docs/LIMITATIONS.md` § 5.

Seven controls, in order of leverage: measure before scaling; develop against
three gate tickets; `max_iterations: 2` while iterating; outcomes on gate tickets
only during development; no web search or fetch, structurally; a per-ticket wall
clock; and a budget projection stop.

Through Phase 6 the workspace carried a **$5 hard limit** that made overspend
structurally impossible. The operator removed it on 2026-08-05. `--budget` and
`--label` are therefore both **required flags** as of Phase 7 — "must be passed
explicitly" was a sentence in a document, which is the same class of protection as
the one that had just been removed.

**Billing boundary:** the Max subscription pays for Claude Code, the builder. API
credits pay for Managed Agents, the thing being built. That is why
`ANTHROPIC_API_KEY` lives only in `.env.local` and is never exported into a shell
that also runs `claude`.

---

## Where to look next

| Question | File |
|---|---|
| What is the contract? | `SPEC.md` |
| Why was this chosen over that? | `docs/DECISIONS.md` — 65 entries with alternatives |
| What does it not do? | `docs/LIMITATIONS.md` |
| Show me it working | `docs/EVIDENCE.md` |
| The decision procedure the agent follows | `agent/skills/triage/SKILL.md` |
| The grading criteria | `agent/rubric.md` |
