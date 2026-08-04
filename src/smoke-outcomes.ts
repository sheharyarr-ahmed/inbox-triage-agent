/**
 * THE PHASE 2 GATE — outcomes smoke test.
 *
 * SPEC § Verification → "Open before Phase 1":
 *
 *   "Outcomes cannot be confirmed from the Console. It is not a stored resource
 *    and has no page or CLI namespace; it is the `user.define_outcome` event
 *    sent through `beta:sessions:events`. Verify with a live smoke test at the
 *    top of Phase 2, before any triage code exists: create a throwaway session,
 *    send one `user.define_outcome` with a two-line rubric, confirm a
 *    `span.outcome_evaluation_start` comes back, then archive. A rejection there
 *    means Tier B, and learning that in Phase 2 costs minutes rather than a
 *    weekend."
 *
 * Runs on a THROWAWAY agent, not agent.yaml, so a failure here is unambiguously
 * about outcomes rather than about agent configuration. A session needs an
 * agent ID, so one has to exist; isolating it keeps the two questions separate.
 *
 *   usage:  pnpm smoke
 */

import Anthropic from "@anthropic-ai/sdk";
import { consoleTraceUrl, env, requireIds } from "./config.js";
import { emptyTally, report, tallyOf, type SessionUsage } from "./cost.js";
import { SpendLimitReached, consumeSession, type ConsumerResult } from "./events.js";

/** Wall clock. Nothing here should take a minute; a stuck session must not bill. */
const DEADLINE_MS = 4 * 60_000;

/**
 * Tiny on purpose. `define-outcomes.md:9` — the grader evaluates *the artifact*,
 * so the agent completes a working turn before any evaluation starts. This is
 * not a free ping, and the agent will genuinely attempt whatever the description
 * asks for.
 */
const DESCRIPTION = "Reply with a single line of text containing exactly: OK";

/** Two lines, per SPEC. Inline text — see D-015. */
const RUBRIC = [
  "1. The reply contains the word OK.",
  "2. The reply is a single line with no other content.",
].join("\n");

/** Any of these on `outcome_evaluations[].result` proves the outcome was accepted. */
const IN_FLIGHT = new Set(["pending", "running", "evaluating"]);

const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The error shape of a gating rejection is UNDOCUMENTED — no reference page
 * gives a code, status, or message for "outcomes are not enabled here". So dump
 * everything rather than matching a shape we would only be guessing at.
 */
function dumpError(where: string, err: unknown): void {
  console.error(`\n!! ${where} failed\n`);
  if (err instanceof Anthropic.APIError) {
    console.error(`   status:     ${err.status}`);
    console.error(`   type:       ${(err as { type?: string }).type ?? "(none)"}`);
    console.error(`   request-id: ${err.requestID ?? "(none)"}`);
    console.error(`   message:    ${err.message}`);
    console.error(`   raw body:   ${JSON.stringify(err.error ?? null, null, 2)}`);
  } else {
    console.error(err);
  }
}

async function main(): Promise<void> {
  const { ENVIRONMENT_ID } = requireIds(["ENVIRONMENT_ID"]);
  const client = new Anthropic();

  console.log("── outcomes smoke test ".padEnd(56, "─"));
  console.log(`  environment   ${ENVIRONMENT_ID}`);

  // 1. Throwaway agent: no MCP, no skills, every built-in tool off.
  const agent = await client.beta.agents.create({
    name: `phase2-outcome-smoke-${new Date().toISOString().slice(0, 10)}`,
    model: "claude-haiku-4-5",
    system:
      "You answer in as few words as possible. Do not use tools. Do not explain.",
    tools: [
      { type: "agent_toolset_20260401", default_config: { enabled: false } },
    ],
  });
  console.log(`  throwaway agent ${agent.id} v${agent.version}`);

  let sessionId: string | undefined;
  let acceptedAs: string | undefined;
  let result: ConsumerResult | undefined;
  const seenTypes = new Map<string, number>();

  try {
    // 2. Session. Sandbox provisioning is lazy, so this costs nothing yet.
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: ENVIRONMENT_ID,
      title: "Phase 2 outcomes smoke test",
    });
    sessionId = session.id;
    console.log(`  session       ${session.id}  (status ${session.status})`);
    console.log(`  trace         ${consoleTraceUrl(session.id)}\n`);

    // 3. STREAM FIRST, THEN SEND. events-and-streaming.md:369 — only events
    //    emitted after the stream opens are delivered.
    //
    //    PHASE 3: the drain and its terminal gate are src/events.ts now. This
    //    file used to carry a byte-identical second copy of the gate; there is
    //    exactly one, and it is under test.
    const consumed = consumeSession({
      client,
      sessionId: session.id,
      deadlineMs: DEADLINE_MS,

      // `onOpen` runs once the stream is established and before the first event
      // is read, so the define_outcome is ordered after the stream rather than
      // racing it.
      onOpen: async () => {
        try {
          await client.beta.sessions.events.send(session.id, {
            events: [
              {
                type: "user.define_outcome",
                description: DESCRIPTION,
                rubric: { type: "text", content: RUBRIC },
                // max_iterations deliberately OMITTED. Default is 3, max is 20,
                // and the MINIMUM is undocumented — `1` would be a guess that
                // could 400. The session is archived long before it could
                // iterate, so the default costs nothing here.
              },
            ],
          });
        } catch (err) {
          dumpError("user.define_outcome", err);
          console.error(
            "\n   THIS IS THE TIER B SIGNAL. SPEC § Open before Phase 1: a rejection\n" +
              "   here means the outcomes-and-grader half of the build is unavailable.\n" +
              "   Stopping. Do not proceed to the hello-world run.\n",
          );
          throw err;
        }
      },

      onCustomToolUse: async () => {
        // The throwaway agent declares no custom tool.
      },
      onEvent: (event) => {
        seenTypes.set(event.type, (seenTypes.get(event.type) ?? 0) + 1);
      },
      log: (line) => console.log(` ${line}`),
    });

    // 4. Acceptance poll, running alongside the drain. This is the earlier and
    //    cheaper of the two signals and does not depend on the SSE consumer:
    //    define-outcomes.md:631 documents `pending` / `running` / `evaluating`
    //    on `outcome_evaluations[].result` before any evaluation completes.
    const deadline = now() + DEADLINE_MS;
    const poller = (async () => {
      while (now() < deadline && acceptedAs === undefined) {
        await sleep(2_000);
        try {
          const s = await client.beta.sessions.retrieve(session.id);
          const first = s.outcome_evaluations[0];
          if (first && (IN_FLIGHT.has(first.result) || first.result.length > 0)) {
            acceptedAs = first.result;
            console.log(
              `  ✓ ACCEPTED — outcome_evaluations[0].result = "${first.result}"` +
                `  (outcome ${first.outcome_id})`,
            );
            return;
          }
        } catch {
          /* transient; the stream is the authoritative path */
        }
      }
    })();

    // 5. Drain.
    try {
      result = await consumed;
    } catch (err) {
      if (err instanceof SpendLimitReached) {
        console.error(`\n  !! ${err.message}`);
        result = err.partial;
      } else {
        throw err;
      }
    }

    await poller;
  } finally {
    // 6. Teardown. session-operations.md:531 — "A `running` session cannot be
    //    archived", so poll the queryable status before archiving.
    if (sessionId) {
      let sessionUsage: SessionUsage | undefined;
      for (let i = 0; i < 20; i++) {
        const s = await client.beta.sessions.retrieve(sessionId);
        sessionUsage = s.usage as SessionUsage;
        if (s.status !== "running") break;
        await sleep(500);
      }
      try {
        await client.beta.sessions.archive(sessionId);
        console.log(`\n  archived session ${sessionId}`);
      } catch (err) {
        dumpError("sessions.archive", err);
      }
      report({
        agent: result
          ? tallyOf(
              result.usage,
              result.events.filter((e) => e.type === "span.model_request_end").length,
            )
          : emptyTally(),
        // Zero-filled by the platform, so `report()` derives the grader's real
        // share from session.usage. Only the evaluation COUNT is usable here.
        grader: { ...emptyTally(), calls: result?.outcomeEvaluations.length ?? 0 },
        session: sessionUsage,
        label: "smoke",
      });
    }

    try {
      await client.beta.agents.archive(agent.id);
      console.log(`  archived throwaway agent ${agent.id}`);
    } catch (err) {
      dumpError("agents.archive", err);
    }
  }

  console.log("\n── event types seen ".padEnd(56, "─"));
  for (const [type, n] of [...seenTypes].sort()) {
    console.log(`  ${String(n).padStart(3)}  ${type}`);
  }

  // Derived from the consumed trace rather than accumulated by a second loop.
  const events = result?.events ?? [];
  const sawStartEvent = events.some((e) => e.type === "span.outcome_evaluation_start");
  const outcomeId =
    result?.outcomeEvaluations[0]?.outcomeId ??
    events.find((e) => e.type === "user.define_outcome")?.outcome_id;

  console.log("\n── gate ".padEnd(56, "─"));
  console.log(`  outcome accepted (poll)        ${acceptedAs ?? "NO"}`);
  console.log(`  span.outcome_evaluation_start  ${sawStartEvent ? "YES" : "NO"}`);
  console.log(`  outcome_id                     ${outcomeId ?? "(none)"}`);
  console.log(`  terminated by                  ${result?.terminatedBy ?? "timeout"}`);
  for (const evaluation of result?.outcomeEvaluations ?? []) {
    console.log(
      `  evaluation #${evaluation.iteration}                  ${evaluation.result}  ` +
        `${evaluation.explanation.slice(0, 200)}`,
    );
  }

  if (!sawStartEvent && acceptedAs === undefined) {
    console.error(
      "\n  GATE FAILED. No evaluation started and the outcome was never accepted.\n" +
        "  SPEC § Open before Phase 1: this is the Tier B signal. Stop here.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n  GATE PASSED — outcomes work on ${env.ANTHROPIC_WORKSPACE_ID}.` +
      (sawStartEvent
        ? ""
        : "\n  (accepted via poll but no start event before the deadline — see the trace)"),
  );
}

main().catch((err) => {
  dumpError("smoke", err);
  process.exitCode = 1;
});
