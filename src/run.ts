/**
 * THE PHASE 2 ACCEPTANCE CRITERION.
 *
 * SPEC § Session protocol → Phase ledger, Phase 2:
 *   "A session runs end to end against the real account and streams events back."
 *
 * This is also the skeleton of the ten-ticket driver. The terminal gate is
 * written correctly here so Phase 3 EXTRACTS it into src/events.ts rather than
 * rewriting it; reconnect, history dedupe, and the full ConsumerResult shape
 * are Phase 3's scope and are deliberately absent.
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
import { addUsage, emptyTally, report, type SessionUsage } from "./cost.js";

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

  const agentTally = emptyTally();
  const graderTally = emptyTally();
  const seenTypes = new Map<string, number>();

  // Findings this run is here to capture beyond the acceptance criterion.
  let mcpToolUses = 0;
  let mcpAuthFailed = false;
  let sawMcpResult = false;
  let clientEventProcessedAt: string | null | undefined;
  let terminatedBy = "timeout";
  let interrupted = false;

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

  // STREAM FIRST, THEN SEND. events-and-streaming.md:369 — only events emitted
  // after the stream opens are delivered. Creating with initial_events would
  // start the session before the consumer attached and batch the opening
  // events, degrading exactly the trace Phase 3 needs as its fixture.
  const stream = await client.beta.sessions.events.stream(session.id);
  const abort = setTimeout(() => {
    interrupted = true;
    stream.controller.abort();
  }, DEADLINE_MS);

  try {
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: MESSAGE }] }],
    });

    for await (const event of stream) {
      appendFileSync(EVIDENCE, `${JSON.stringify(event)}\n`);
      seenTypes.set(event.type, (seenTypes.get(event.type) ?? 0) + 1);

      switch (event.type) {
        case "user.message":
          // SPEC § processed_at claims client-sent events appear first with
          // null. Record what actually arrives.
          clientEventProcessedAt = event.processed_at;
          console.log(`  echo  user.message  processed_at=${event.processed_at ?? "null"}`);
          break;

        case "agent.mcp_tool_use":
          mcpToolUses += 1;
          console.log(
            `  → mcp   ${event.mcp_server_name}.${event.name}  ${JSON.stringify(event.input)}`,
          );
          break;

        case "agent.mcp_tool_result": {
          sawMcpResult = true;
          const text = (event.content ?? [])
            .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
            .join(" ")
            .slice(0, 400);
          console.log(`  ← mcp   is_error=${event.is_error ?? false}  ${text}`);
          break;
        }

        case "agent.tool_use":
          console.log(`  → tool  ${event.name}`);
          break;

        case "agent.message":
          for (const block of event.content) {
            if (block.type === "text") console.log(`\n  agent: ${block.text.trim()}\n`);
          }
          break;

        case "span.model_request_end":
          addUsage(agentTally, event.model_usage);
          break;

        case "span.outcome_evaluation_end":
          addUsage(graderTally, event.usage);
          break;

        case "session.error": {
          const e = event.error;
          console.error(`  !! session.error  ${e.type}: ${e.message}`);
          if (e.type === "mcp_authentication_failed_error") {
            mcpAuthFailed = true;
            console.error(
              `     server=${e.mcp_server_name} — the vault credential did not match ` +
                `or was rejected. mcp-connector.md:368: an unmatched credential means ` +
                `the connection is attempted UNAUTHENTICATED rather than failing loudly.`,
            );
          }
          if (e.type === "billing_error") {
            // Under a $5 hard cap this is the failure that ends a build session.
            // Its own docstring: retrying with the same credentials will not succeed.
            console.error(
              "     SPEND LIMIT REACHED. Retrying with the same credentials will not " +
                "succeed. Stopping immediately.",
            );
            terminatedBy = "billing_error";
            stream.controller.abort();
          }
          break;
        }

        case "session.status_terminated":
          terminatedBy = "terminated";
          break;

        case "session.status_idle":
          if (event.stop_reason.type !== "requires_action") {
            terminatedBy = event.stop_reason.type;
          }
          break;

        default:
          // Unknown types log and continue — SPEC § The SSE consumer. Proven
          // against a synthetic unrecognised event in Phase 3.
          break;
      }

      // ---- TERMINAL GATE -------------------------------------------------
      // Break on terminated, or on idle when the stop reason is NOT
      // requires_action. Idle alone is not terminal: the session idles
      // transiently while waiting for a custom tool result, and a loop that
      // breaks on bare idle abandons every ticket at the decision step from
      // Phase 4 onward. The doc's own headline example has exactly that bug.
      if (event.type === "session.status_terminated") break;
      if (
        event.type === "session.status_idle" &&
        event.stop_reason.type !== "requires_action"
      ) {
        break;
      }
      if (terminatedBy === "billing_error") break;
    }
  } catch (err) {
    dumpError("session drain", err);
    process.exitCode = 1;
  } finally {
    clearTimeout(abort);
  }

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
    `  user.message processed_at        ${
      clientEventProcessedAt === undefined
        ? "(no echo observed)"
        : clientEventProcessedAt === null
          ? "null on first sighting (matches SPEC)"
          : `${clientEventProcessedAt} — populated on FIRST sighting`
    }`,
  );
  console.log(`  trace written                    ${EVIDENCE}`);

  const accepted = rows.every(([, pass]) => pass) && !interrupted;
  console.log(
    `\n  ${accepted ? "ACCEPTANCE MET" : "ACCEPTANCE NOT MET"} — Phase 2${accepted ? "" : " is not closed"}`,
  );
  if (!accepted) process.exitCode = 1;
}

main().catch((err) => {
  dumpError("run", err);
  process.exitCode = 1;
});
