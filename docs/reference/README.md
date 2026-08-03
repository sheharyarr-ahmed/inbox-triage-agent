# `docs/reference/` — Anthropic Managed Agents snapshot

Pulled 2026-08-02 to close the last open item in `SPEC.md` § Verification →
*Open before Phase 1*.

**These files, not training data, are the source of truth.** `SPEC.md` states it
directly: *"Where `docs/reference/` contradicts training data, the docs win."*
One contradiction is already recorded below.

## Provenance

Canonical host is `platform.claude.com`. `docs.claude.com` 301-redirects to it,
and the path prefix is `/docs/en/…`, not `/en/docs/…`. Appending `.md` to any
page URL returns its source.

```sh
curl -fsSL https://platform.claude.com/docs/en/managed-agents/<slug>.md \
     -o docs/reference/<slug>.md
```

| File | Page title | Source URL |
|---|---|---|
| `overview.md` | Claude Managed Agents overview | `…/managed-agents/overview` |
| `quickstart.md` | Get started with Claude Managed Agents | `…/managed-agents/quickstart` |
| `sessions.md` | Start a session | `…/managed-agents/sessions` |
| `events-and-streaming.md` | Session event stream | `…/managed-agents/events-and-streaming` |
| `define-outcomes.md` | Define outcomes | `…/managed-agents/define-outcomes` |
| `memory.md` | Using agent memory | `…/managed-agents/memory` |
| `vaults.md` | Authenticate with vaults | `…/managed-agents/vaults` |
| `mcp-connector.md` | MCP connector | `…/managed-agents/mcp-connector` |
| `skills.md` | Skills | `…/managed-agents/skills` |
| `agent-setup.md` † | Define your agent | `…/managed-agents/agent-setup` |
| `tools.md` † | Tools | `…/managed-agents/tools` |
| `environments.md` † | Cloud environment setup | `…/managed-agents/environments` |
| `permission-policies.md` ‡ | Permission policies | `…/managed-agents/permission-policies` |
| `reference.md` ‡ | Reference | `…/managed-agents/reference` |
| `session-operations.md` ‡ | Session operations | `…/managed-agents/session-operations` |

† **Beyond SPEC § Verification.** SPEC lists nine pages; these three were added
because Phase 2 writes `agent/agent.yaml` and `agent/environment.yaml` against
exactly these surfaces:

- `agent-setup.md` — the agent definition field surface (`model`, `system`,
  `tools`, `mcp_servers`, `skills`).
- `tools.md` — `agent_toolset_20260401` with `default_config` / `configs`, the
  shape SPEC's least-privilege allowlist depends on.
- `environments.md` — `config.type: cloud` and `networking: limited` with
  `allow_mcp_servers`, the silent-failure trap SPEC calls out.

‡ **Added 2026-08-03, Phase 2.** All three are linked from the original twelve
but were not pulled, and between them they carried **five load-bearing claims
that `SPEC.md` made and this repo could not substantiate**. Each is now sourced.
See `docs/DECISIONS.md` D-018.

- `permission-policies.md` — closes **D-012**. Line 20: *"the agent toolset
  defaults to `always_allow`, and MCP toolsets default to `always_ask`."*
  Line 205: *"MCP toolsets default to `always_ask`. This ensures that new tools
  added to an MCP server do not execute in your application without approval. To
  auto-approve tools from a trusted MCP server, set
  `default_config.permission_policy` on the `mcp_toolset` entry."* The YAML at
  lines 247–251 is the exact shape `agent/agent.yaml` uses. Line 201 also
  confirms `default_config` is optional and defaults the agent toolset to
  `always_allow`.
- `reference.md` — the **full event-type catalogue**, which no other pulled page
  contains. Sources three SPEC claims that previously rested on the SDK typings
  alone: `session.status_terminated` (line 50), `span.model_request_end`
  *"Includes `model_usage` with token counts"* (line 67), and the four terminal
  outcome results (line 70). Also carries the rate limits SPEC never had: **300
  rpm on create endpoints, 1,200 rpm on read endpoints**, per organization.
- `session-operations.md` — the session status enum (`idle`, `running`,
  `rescheduling`, `terminated`, line 17), which makes SPEC's
  `status !== 'running'` poll predicate sound; *"Sessions created without
  `initial_events` start in `idle`"* (line 19), confirming SPEC § Session
  topology step 1; and line 531, which **sharpens** SPEC § Session topology
  step 6: *"A `running` session cannot be archived; send an interrupt event if
  you need to archive it immediately."* That is a documented constraint, not
  merely the intermittent 400 SPEC describes. SPEC's stated *cause* — the stream
  emitting idle before the queryable status catches up — remains empirical and
  undocumented; the poll-then-archive remedy is now grounded either way.

### Two pages that are *not* these

- `/docs/en/agents-and-tools/mcp-connector` is a **different**, non-Managed-Agents
  MCP connector. `mcp-connector.md` here is the Managed Agents one.
- `/docs/en/agents-and-tools/agent-skills/*` is skill **authoring**. `skills.md`
  here is about *attaching* a skill to an agent.

## Caveats

**These are MDX, not CommonMark.** The bodies contain raw JSX component tags
(`<Note>`, `<Warning>`, `<CodeGroup defaultLanguage="CLI">`, `<Tabs>`,
`<Steps>`, `<Accordion>`) and root-relative links (`/docs/en/…`). Read them as
source; do not feed them to a strict Markdown parser without stripping tags and
absolutising links.

**This is a point-in-time snapshot of a moving beta.** Re-pull before trusting
any header, field name, or limit at a phase boundary.

---

## Contradiction with SPEC.md — resolved in the docs' favour

`SPEC.md` § Decisions, *Corrections to the blueprint*, row 1 originally stated:

> "`agent-memory-2026-07-22` does not appear in the current reference."

`memory.md`, fetched 2026-08-02, says the opposite — verbatim:

> Managed Agents API requests require the `managed-agents-2026-04-01` beta
> header, **except memory store endpoints, which use `agent-memory-2026-07-22`
> instead.** The SDK sets the correct beta header automatically.

> Don't combine `agent-memory-2026-07-22` with `managed-agents-2026-04-01` on a
> memory store request: **sending both returns a `400` error.** If your code
> sets beta headers explicitly, replace `managed-agents-2026-04-01` with
> `agent-memory-2026-07-22` on memory store calls rather than adding a second
> value. Session endpoints, including attaching a memory store to a session,
> still use `managed-agents-2026-04-01`.

**`SPEC.md` was amended on 2026-08-02** to match. Blueprint §1.4 was correct on
the memory header; the v1 correction is withdrawn. The `dreaming-2026-04-21`
half of Correction #1 stands — that header remains unverified and must not be
stated.

## Refinements not folded into SPEC.md

Also from `memory.md`. Recorded here rather than in SPEC to keep that amendment
narrow; carry them into Phase 5 and Phase 7.

1. **Do not construct the mount path.** SPEC writes `/mnt/memory/<store-name>/`.
   The real rule is the display name slugified — lowercased, non-alphanumeric
   runs collapsed to one hyphen — and the docs say to read the exact value from
   the `mount_path` field on the session's memory-store resource. **Writes
   anywhere else under `/mnt/memory/` land in container-local scratch and are
   silently lost when the session ends.** A Phase 5 trap with no error signal.
2. **Store limits:** 2,000 memories per store, 100 kB per memory. Exceeding the
   count makes new writes fail while existing memories stay readable.
3. **`read_write` under untrusted input is a documented injection vector.** Per
   `memory.md`: a successful prompt injection can write malicious content into
   the store, which later sessions then read as trusted memory. This is T-008's
   threat model stated by Anthropic — it belongs in `docs/LIMITATIONS.md`.

## SDK naming — SPEC prose vs. the TypeScript surface

SPEC writes API paths in snake_case. `@anthropic-ai/sdk` is **camelCase on the
client surface**; snake_case appears only in wire payloads.

| SPEC.md writes | Actual TypeScript SDK |
|---|---|
| `memory_stores.memories.list` | `client.beta.memoryStores.memories.list(storeId, {…})` |
| `memory_stores.create` | `client.beta.memoryStores.create(…)` |
| `vaults.credentials.create` | `client.beta.vaults.credentials.create(vaultId, …)` |
| *(sending a session event)* | `client.beta.sessions.events.send(…)` — there is no `.create()` |
| *(SSE stream)* | `client.beta.sessions.events.stream(sessionId)` |
| *(Files API)* | `client.beta.files.upload(…)` — no top-level `client.files` |
| *(Skills API)* | `client.beta.skills` — no non-beta `client.skills` |
