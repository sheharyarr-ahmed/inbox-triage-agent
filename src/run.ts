/**
 * THE PHASE 2 ACCEPTANCE CRITERION.
 *
 * SPEC § Session protocol → Phase ledger, Phase 2:
 *   "A session runs end to end against the real account and streams events back."
 *
 * This is also the skeleton of the ten-ticket driver.
 *
 * PHASE 3 REFACTOR. The terminal gate this file used to carry inline is now
 * src/events.ts `terminalReason`, extracted rather than rewritten, and the drain
 * loop is `consumeSession()`. What used to be forty lines of switch here is a
 * single call plus the reporting this phase is actually about. Reconnect,
 * history dedupe, the wall-clock interrupt and the full ConsumerResult shape all
 * came with it; none of them existed in the Phase 2 version.
 *
 * The acceptance output below is unchanged, so the Phase 2 evidence it produced
 * stays comparable.
 *
 * No outcome is defined here. The smoke test already proved the outcomes
 * primitive, and leaving the grader out keeps this run cheap AND yields a clean
 * agent-only measurement — if session.usage matches the summed spans with no
 * grader running, that independently confirms span.model_request_end covers the
 * agent completely (see docs/DECISIONS.md D-017).
 *
 *   usage:  pnpm session
 */

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, consoleTraceUrl, requireIds } from "./config.js";
import { emptyTally, report, tallyOf, type SessionUsage } from "./cost.js";
import { SpendLimitReached, consumeSession, type ConsumerResult } from "./events.js";

/** Per-session wall clock. SPEC § Bounded iteration: a stuck session must not bill. */
const DEADLINE_MS = 5 * 60_000;

const EVIDENCE = resolve(REPO_ROOT, "docs/evidence/phase-2-session.jsonl");

/**
 * Forces exactly one MCP lookup against a seeded account. ACC-2004 is the
 * business-tier record carrying `duplicate_charge:CHG-88213`, so a correct
 * answer proves the whole path: agent -> mcp_toolset -> Anthropic proxy ->
 * vault credential -> Vercel -> back.
 */
const MESSAGE =
  "Use the support-records tools to look up account ACC-2004. Report its " +
  "plan_tier and any known_issues, naming the exact field you read each value " +
  "from. Do not guess: if a field is absent, say so.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dumpError(where: string, err: unknown): void {
  console.error(`\n!! ${where} failed`);
  if (err instanceof Anthropic.APIError) {
    console.error(`   status:     ${err.status}`);
    console.error(`   request-id: ${err.requestID ?? "(none)"}`);
    console.error(`   message:    ${err.message}`);
    console.error(`   raw body:   ${JSON.stringify(err.error ?? null, null, 2)}`);
  } else {
    console.error(err);
  }
}

async function main(): Promise<void> {
  const ids = requireIds([
    "ENVIRONMENT_ID",
    "AGENT_ID",
    "AGENT_VERSION",
    "VAULT_ID",
  ]);
  const client = new Anthropic();

  mkdirSync(resolve(REPO_ROOT, "docs/evidence"), { recursive: true });
  rmSync(EVIDENCE, { force: true });

  console.log("── phase 2 · hello world ".padEnd(56, "─"));
  console.log(`  agent         ${ids.AGENT_ID} v${ids.AGENT_VERSION} (pinned)`);
  console.log(`  environment   ${ids.ENVIRONMENT_ID}`);
  console.log(`  vault         ${ids.VAULT_ID}`);

  const session = await client.beta.sessions.create({
    // Pinned rather than the bare-string shorthand, so this trace stays
    // reproducible after Phase 4 bumps the agent to version 2.
    agent: { type: "agent", id: ids.AGENT_ID, version: ids.AGENT_VERSION },
    environment_id: ids.ENVIRONMENT_ID,
    vault_ids: [ids.VAULT_ID],
    title: "Phase 2 hello world",
    // No initial_events: the session starts idle, so the stream attaches before
    // any work begins. session-operations.md:19 confirms the idle start.
  });

  console.log(`  session       ${session.id}  (status ${session.status})`);
  console.log(`  trace         ${consoleTraceUrl(session.id)}\n`);

  const seenTypes = new Map<string, number>();
  let result: ConsumerResult | undefined;

  try {
    result = await consumeSession({
      client,
      sessionId: session.id,
      deadlineMs: DEADLINE_MS,

      // STREAM FIRST, THEN SEND. events-and-streaming.md:369 — only events
      // emitted after the stream opens are delivered. `onOpen` runs once the
      // stream is established and before the first event is read, so this is
      // ordered, not raced. Firing the send alongside the consumer instead
      // would be the race SPEC § Session topology step 2 exists to prevent.
      onOpen: async () => {
        await client.beta.sessions.events.send(session.id, {
          events: [{ type: "user.message", content: [{ type: "text", text: MESSAGE }] }],
        });
      },

      onCustomToolUse: async () => {
        // Phase 2's agent version declares no custom tool (D-014), so this
        // cannot fire yet. Phase 4 supplies the validate-and-reply half.
      },

      // Persist as events arrive rather than from the returned array: the run
      // that throws is the run whose trace matters most.
      onEvent: (event) => {
        appendFileSync(EVIDENCE, `${JSON.stringify(event)}\n`);
        seenTypes.set(event.type, (seenTypes.get(event.type) ?? 0) + 1);
      },

      log: (line) => console.log(` ${line}`),
    });
  } catch (err) {
    if (err instanceof SpendLimitReached) {
      console.error(`\n  !! ${err.message}\n     Stopping immediately.`);
      result = err.partial;
    } else {
      dumpError("session drain", err);
    }
    process.exitCode = 1;
  }

  // Findings this run is here to capture beyond the acceptance criterion, now
  // derived from the consumed trace rather than accumulated by a second loop.
  const events = result?.events ?? [];
  const mcpToolUses = events.filter((e) => e.type === "agent.mcp_tool_use").length;
  const sawMcpResult = events.some((e) => e.type === "agent.mcp_tool_result");
  const mcpAuthFailed = events.some(
    (e) => e.type === "session.error" && e.error.type === "mcp_authentication_failed_error",
  );
  const clientEcho = events.find((e) => e.type === "user.message");
  const clientEventProcessedAt = clientEcho?.processed_at;
  const terminatedBy = result?.terminatedBy ?? "timeout";

  const agentTally = result
    ? tallyOf(result.usage, events.filter((e) => e.type === "span.model_request_end").length)
    : emptyTally();
  // Zero-filled by the platform, so `report()` derives the grader's real share
  // from session.usage. Only the evaluation COUNT is usable here — D-017.
  const graderTally = { ...emptyTally(), calls: result?.outcomeEvaluations.length ?? 0 };

  // Teardown. session-operations.md:531 — "A `running` session cannot be
  // archived", so poll the queryable status first. The stream emits idle
  // slightly before that status catches up.
  let sessionUsage: SessionUsage | undefined;
  let finalStatus = "unknown";
  for (let i = 0; i < 20; i++) {
    const s = await client.beta.sessions.retrieve(session.id);
    sessionUsage = s.usage as SessionUsage;
    finalStatus = s.status;
    if (s.status !== "running") break;
    await sleep(500);
  }

  if (finalStatus === "running") {
    console.error(`\n  session still running after poll budget — not archiving`);
  } else {
    try {
      await client.beta.sessions.archive(session.id);
      console.log(`  archived session (status was ${finalStatus})`);
    } catch (err) {
      dumpError("sessions.archive", err);
    }
  }

  report({ agent: agentTally, grader: graderTally, session: sessionUsage, label: "hello world" });

  console.log("\n── event types seen ".padEnd(56, "─"));
  for (const [type, n] of [...seenTypes].sort()) {
    console.log(`  ${String(n).padStart(3)}  ${type}`);
  }

  console.log("\n── acceptance ".padEnd(56, "─"));
  const streamed = [...seenTypes.values()].reduce((a, b) => a + b, 0);
  const rows: [string, boolean, string][] = [
    ["session created against the real account", true, session.id],
    ["events streamed back through our consumer", streamed > 0, `${streamed} events`],
    ["terminal gate fired correctly", terminatedBy !== "timeout", terminatedBy],
    ["session archived", finalStatus !== "running", finalStatus],
  ];
  for (const [label, pass, detail] of rows) {
    console.log(`  ${pass ? "✓" : "✗"} ${label.padEnd(42)}${detail}`);
  }

  console.log("\n── carried into later phases ".padEnd(56, "─"));
  console.log(`  agent.mcp_tool_use events        ${mcpToolUses}`);
  console.log(`  agent.mcp_tool_result seen       ${sawMcpResult}`);
  console.log(`  mcp auth failure                 ${mcpAuthFailed}`);
  console.log(
    `  vault path                       ${
      mcpToolUses > 0 && sawMcpResult && !mcpAuthFailed
        ? "PROVEN end to end"
        : mcpAuthFailed
          ? "FAILED — fix before Phase 4"
          : "not exercised this run"
    }`,
  );
  console.log(
    // Amendment A-2, accepted 2026-08-04: `processed_at` is null only while an
    // event is genuinely queued behind earlier ones, not unconditionally on
    // first sighting. Either reading is normal; neither is a state input.
    `  user.message processed_at        ${
      clientEventProcessedAt === undefined
        ? "(no echo observed)"
        : clientEventProcessedAt === null
          ? "null on first sighting — queued behind earlier events"
          : `${clientEventProcessedAt} — populated on FIRST sighting (nothing queued)`
    }`,
  );
  console.log(`  trace written                    ${EVIDENCE}`);

  const accepted = rows.every(([, pass]) => pass);
  console.log(
    `\n  ${accepted ? "ACCEPTANCE MET" : "ACCEPTANCE NOT MET"} — Phase 2${accepted ? "" : " is not closed"}`,
  );
  if (!accepted) process.exitCode = 1;
}

main().catch((err) => {
  dumpError("run", err);
  process.exitCode = 1;
});
