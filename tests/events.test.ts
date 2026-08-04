/**
 * SPEC § Verification → On every turn (Stop hook):
 *   "Consumer replays `fixtures/session-events.jsonl` and produces the expected
 *    `ConsumerResult`; breaks on idle-with-terminal-stop_reason and does not
 *    break on idle-requires_action; survives a synthetic unknown event type;
 *    dedupes a replayed history page by event id."
 *
 * Fully offline, zero spend, no network. Every test drives the same
 * `consumeEvents` loop the live path uses; only the `EventSource` is swapped.
 *
 * The fixture path is resolved locally rather than through `src/config.ts`'s
 * `REPO_ROOT`, deliberately: `config.ts` runs `load()` at import time and would
 * couple this suite to a populated `.env.local`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  consumeEvents,
  readEventsJsonl,
  replaySource,
  terminalReason,
  type EventSource,
  type SessionEvent,
  type StreamEvent,
} from "../src/events.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The real Phase 2 capture, byte-identical to docs/evidence/phase-2-session.jsonl. */
const REAL = readEventsJsonl(resolve(FIXTURES, "session-events.jsonl"));
/** A Phase-4-shaped session the Phase 2 agent could not have produced. */
const SYNTHETIC = readEventsJsonl(resolve(FIXTURES, "synthetic-events.jsonl"));

const silent = () => {};

/**
 * An `EventSource` whose `live()` hands back a different batch on each connect,
 * so a test can force the drop-and-reconnect path deterministically.
 */
function scriptedSource(opts: {
  live: readonly (readonly StreamEvent[])[];
  history?: readonly SessionEvent[] | undefined;
  /** Events released into the current live batch once `interrupt()` arrives. */
  afterInterrupt?: readonly StreamEvent[] | undefined;
}): EventSource & { connects: () => number; interrupts: () => number } {
  let connects = 0;
  let interrupts = 0;
  let release: (() => void) | null = null;

  return {
    connects: () => connects,
    interrupts: () => interrupts,
    async live() {
      const batch = opts.live[connects] ?? [];
      connects += 1;
      const afterInterrupt = opts.afterInterrupt;
      return (async function* () {
        for (const event of batch) yield event;
        if (afterInterrupt) {
          await new Promise<void>((r) => {
            release = r;
          });
          for (const event of afterInterrupt) yield event;
        }
      })();
    },
    history() {
      const page = opts.history ?? [];
      return (async function* () {
        for (const event of page) yield event;
      })();
    },
    async interrupt() {
      interrupts += 1;
      release?.();
    },
    abort() {
      release?.();
    },
  };
}

/** `session.status_idle` carrying an arbitrary stop reason. */
function idle(stopReason: Record<string, unknown>, id = "sevt_test_idle"): StreamEvent {
  return {
    id,
    processed_at: "2026-08-04T09:00:00.000000Z",
    stop_reason: stopReason,
    type: "session.status_idle",
  } as unknown as StreamEvent;
}

function bare(type: string, id: string): StreamEvent {
  return {
    id,
    processed_at: "2026-08-04T09:00:00.000000Z",
    type,
  } as unknown as StreamEvent;
}

/** An `agent.custom_tool_use` carrying an arbitrary payload. */
function customToolUse(id: string, name = "submit_triage_decision"): StreamEvent {
  return {
    id,
    input: { ticket_id: "T-006" },
    name,
    processed_at: "2026-08-04T09:00:00.000000Z",
    type: "agent.custom_tool_use",
  } as unknown as StreamEvent;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("consumeEvents replaying the real Phase 2 trace", () => {
  it("produces the expected ConsumerResult", async () => {
    const result = await consumeEvents({
      source: replaySource(REAL),
      deadlineMs: 60_000,
      log: silent,
    });

    expect(result.terminatedBy).toBe("end_turn");
    expect(result.events).toHaveLength(13);
    expect(result.decision).toBeNull();
    expect(result.outcomeEvaluations).toEqual([]);
    // Summed from the two span.model_request_end events. With no grader running
    // these reconcile to session.usage exactly — docs/DECISIONS.md D-017.
    expect(result.usage).toEqual({
      input: 3978,
      output: 239,
      cacheRead: 0,
      cacheCreation: 4239,
    });
  });

  it("pairs the MCP tool call and derives its duration from processed_at", async () => {
    // No duration field exists on any event. The value is the gap between two
    // COMPLETION stamps, correlated on agent.mcp_tool_result.mcp_tool_use_id.
    // If the correlation key were wrong the array would be empty, not wrong.
    const result = await consumeEvents({
      source: replaySource(REAL),
      deadlineMs: 60_000,
      log: silent,
    });

    expect(result.toolCalls).toEqual([{ name: "lookup_account", durationMs: 419 }]);
  });

  it("logs no unknown event types", async () => {
    // Guards the acceptance criterion's meaning: if known-but-uninteresting
    // types fell through to the default branch, "unknown event" in a trace
    // would stop being evidence of anything.
    const lines: string[] = [];
    await consumeEvents({
      source: replaySource(REAL),
      deadlineMs: 60_000,
      log: (line) => lines.push(line),
    });

    expect(lines.filter((l) => l.includes("unknown event"))).toEqual([]);
  });
});

describe("consumeEvents replaying a Phase-4-shaped session", () => {
  it("does not break on idle-requires_action, and runs on to the real terminal", async () => {
    // THE bug this module exists to prevent. The fixture idles with
    // requires_action at event 15 while the custom tool result is outstanding.
    // A loop that breaks on bare idle abandons the ticket there and never sees
    // the grader or the end_turn idle at event 22.
    const result = await consumeEvents({
      source: replaySource(SYNTHETIC),
      deadlineMs: 60_000,
      log: silent,
    });

    expect(result.events).toHaveLength(22);
    expect(result.terminatedBy).toBe("end_turn");
    expect(result.outcomeEvaluations).toHaveLength(1);
  });

  it("invokes onCustomToolUse and captures the validated decision", async () => {
    const seen: string[] = [];
    const result = await consumeEvents({
      source: replaySource(SYNTHETIC),
      deadlineMs: 60_000,
      log: silent,
      onCustomToolUse: async (event) => {
        seen.push(event.name);
      },
    });

    expect(seen).toEqual(["submit_triage_decision"]);
    expect(result.decision?.ticket_id).toBe("T-006");
    expect(result.decision?.disposition).toBe("escalate");
    expect(result.decision?.draft_reply).toBeNull();
  });

  it("leaves decision null when the custom tool payload fails the schema", async () => {
    // SPEC § Decision capture puts the is_error reply in run.ts. The consumer
    // must not throw here, or one malformed payload kills the whole ticket
    // instead of giving the agent a chance to correct.
    const broken = SYNTHETIC.map((event) =>
      event.type === "agent.custom_tool_use"
        ? ({ ...event, input: { ticket_id: "T-006", disposition: "escalate" } } as StreamEvent)
        : event,
    );

    const result = await consumeEvents({
      source: replaySource(broken),
      deadlineMs: 60_000,
      log: silent,
    });

    expect(result.decision).toBeNull();
    expect(result.terminatedBy).toBe("end_turn");
  });

  it("pairs a built-in agent tool on tool_use_id as well as an MCP tool", async () => {
    // agent.tool_result correlates on `tool_use_id`, agent.mcp_tool_result on
    // `mcp_tool_use_id`. The two keys differ and only one of them is attested
    // in a real capture, so the built-in pair is asserted explicitly.
    const result = await consumeEvents({
      source: replaySource(SYNTHETIC),
      deadlineMs: 60_000,
      log: silent,
    });

    expect(result.toolCalls).toEqual([
      { name: "lookup_account", durationMs: 412 },
      { name: "read", durationMs: 35 },
    ]);
  });

  it("records the grader's result, explanation and iteration", async () => {
    const result = await consumeEvents({
      source: replaySource(SYNTHETIC),
      deadlineMs: 60_000,
      log: silent,
    });

    const evaluation = result.outcomeEvaluations[0];
    expect(evaluation?.result).toBe("satisfied");
    expect(evaluation?.iteration).toBe(0);
    expect(evaluation?.explanation).toContain("Criterion 3");
    // Zero-filled in practice, which is why cost.ts derives grader spend from
    // session.usage instead. docs/DECISIONS.md D-017 / amendment A-1.
    expect(evaluation?.usage.input_tokens).toBe(0);
  });
});

describe("terminalReason", () => {
  it("terminates on idle with end_turn and with retries_exhausted", () => {
    expect(terminalReason(idle({ type: "end_turn" }))).toBe("end_turn");
    expect(terminalReason(idle({ type: "retries_exhausted" }))).toBe("retries_exhausted");
  });

  it("does not terminate on idle with requires_action", () => {
    // Idle alone is not terminal: from Phase 4 every ticket idles here while
    // waiting on submit_triage_decision.
    expect(terminalReason(idle({ type: "requires_action", event_ids: ["sevt_x"] }))).toBeNull();
  });

  it("does not terminate on session.thread_status_idle, even with end_turn", () => {
    // The decoy. In the real trace it arrives 2 microseconds BEFORE
    // session.status_idle carrying an identical stop_reason, so a gate keyed on
    // stop_reason alone fires one event early.
    const threadIdle = {
      agent_name: "inbox-triage-agent",
      id: "sevt_test_thread_idle",
      processed_at: "2026-08-04T09:00:00.000000Z",
      session_thread_id: "sthr_test",
      stop_reason: { type: "end_turn" },
      type: "session.thread_status_idle",
    } as unknown as StreamEvent;

    expect(terminalReason(threadIdle)).toBeNull();
  });

  it("does not terminate on session.status_rescheduled", () => {
    // reference.md:49 — a transient error the session is retrying automatically.
    expect(terminalReason(bare("session.status_rescheduled", "sevt_r"))).toBeNull();
  });

  it("terminates on session.status_terminated and on session.deleted", () => {
    // session.deleted is amendment A-5: SPEC's gate does not name it, but it
    // "terminates any active event stream", so without it the loop waits out
    // the wall clock on a dead socket.
    expect(terminalReason(bare("session.status_terminated", "sevt_t"))).toBe("terminated");
    expect(terminalReason(bare("session.deleted", "sevt_d"))).toBe("terminated");
  });
});

describe("robustness of the consumer loop", () => {
  it("survives unknown event types and logs {type, id} for each", async () => {
    // The first three are real: they are on the SDK's own SSE allowlist
    // (core/streaming.js:56-101) but have no TypeScript member, so they reach
    // the default branch on a live stream. The fourth is wholly invented.
    const unknowns = [
      bare("agent.session_thread_message_received", "sevt_u1"),
      bare("agent.session_thread_message_sent", "sevt_u2"),
      bare("session.thread_status_created", "sevt_u3"),
      bare("session.quantum_entangled", "sevt_u4"),
    ];
    const lines: string[] = [];

    const result = await consumeEvents({
      source: replaySource([...unknowns, idle({ type: "end_turn" })]),
      deadlineMs: 60_000,
      log: (line) => lines.push(line),
    });

    expect(result.terminatedBy).toBe("end_turn");
    expect(result.events).toHaveLength(5);
    const unknownLines = lines.filter((l) => l.includes("unknown event"));
    expect(unknownLines).toHaveLength(4);
    expect(unknownLines[3]).toContain("type=session.quantum_entangled");
    expect(unknownLines[3]).toContain("id=sevt_u4");
  });

  it("skips event_start and event_delta without reading a top-level id", async () => {
    // Those two carry no `id` at all. Reading `.id` before the type filter
    // would poison the dedupe set with `undefined` and, on the second delta,
    // silently drop it as already seen.
    const previews = [
      { type: "event_start", event: { type: "agent.message", id: "sevt_p1" } },
      {
        type: "event_delta",
        event_id: "sevt_p1",
        delta: { type: "content_delta", index: 0, content: { type: "text", text: "hi" } },
      },
      {
        type: "event_delta",
        event_id: "sevt_p1",
        delta: { type: "content_delta", index: 0, content: { type: "text", text: " there" } },
      },
    ] as unknown as StreamEvent[];

    const result = await consumeEvents({
      source: replaySource([...previews, idle({ type: "end_turn" })]),
      deadlineMs: 60_000,
      log: silent,
    });

    // Only the idle is recorded; the three previews are dropped, not counted.
    expect(result.events).toHaveLength(1);
    expect(result.terminatedBy).toBe("end_turn");
  });

  it("dedupes a replayed history page by event id, handling each event once", async () => {
    // Reconnect replays history. If the dedupe did not hold, the two
    // span.model_request_end events would be tallied twice and the usage totals
    // would double.
    const source = scriptedSource({
      live: [REAL.slice(0, 11), []], // drops before the terminal idle
      history: REAL as SessionEvent[], // history carries the whole session
    });

    const result = await consumeEvents({
      source,
      deadlineMs: 60_000,
      log: silent,
      maxReconnects: 1,
    });

    expect(source.connects()).toBe(2);
    expect(result.events).toHaveLength(13);
    expect(result.usage).toEqual({
      input: 3978,
      output: 239,
      cacheRead: 0,
      cacheCreation: 4239,
    });
    expect(result.toolCalls).toEqual([{ name: "lookup_account", durationMs: 419 }]);
  });

  it("still terminates on a terminal event whose id is already in the seen set", async () => {
    // THE bug SPEC § The SSE consumer names by name, and the one the reference
    // doc's own reconnect example has at events-and-streaming.md:744: dedupe by
    // `continue` placed before the terminal check swallows a terminal event
    // already present in history, and the loop never exits.
    const terminal = idle({ type: "end_turn" }, "sevt_already_seen");
    const seenEventIds = new Set<string>(["sevt_already_seen"]);

    const result = await consumeEvents({
      source: replaySource([terminal]),
      deadlineMs: 60_000,
      log: silent,
      seenEventIds,
    });

    expect(result.terminatedBy).toBe("end_turn");
    // Handling was correctly suppressed — only the termination was not.
    expect(result.events).toHaveLength(0);
  });

  it("treats stream exhaustion without a terminal event as a drop, not completion", async () => {
    // @anthropic-ai/sdk/core/streaming.js:119-133 ends the iterator silently on
    // both a clean close and an abort, so the loop running out proves nothing.
    // Recovery here comes from the history page, which carries the terminal.
    const source = scriptedSource({
      live: [REAL.slice(0, 5), []],
      history: REAL as SessionEvent[],
    });

    const result = await consumeEvents({
      source,
      deadlineMs: 60_000,
      log: silent,
      maxReconnects: 1,
    });

    expect(source.connects()).toBe(2);
    expect(result.terminatedBy).toBe("end_turn");
  });

  it("throws rather than reporting a false terminal when reconnects are exhausted", async () => {
    // Returning a ConsumerResult here would let Phase 4 record a ticket as
    // finished on end_turn that never actually finished.
    await expect(
      consumeEvents({
        source: scriptedSource({ live: [REAL.slice(0, 5)] }),
        deadlineMs: 60_000,
        log: silent,
        maxReconnects: 0,
      }),
    ).rejects.toThrow(/no terminal event/);
  });

  it("opens the stream before onOpen runs, and reads no event until it resolves", async () => {
    // STREAM FIRST, THEN SEND. events-and-streaming.md:369 — only events emitted
    // after the stream opens are delivered, so the event that starts the work
    // must be sent after the connection exists. Firing the send alongside the
    // consumer and hoping the stream wins is the race SPEC § Session topology
    // step 2 exists to prevent, and it fails intermittently rather than loudly.
    const order: string[] = [];
    const base = replaySource([idle({ type: "end_turn" })]);

    await consumeEvents({
      source: {
        ...base,
        async live() {
          order.push("live");
          return base.live();
        },
      },
      deadlineMs: 60_000,
      log: silent,
      onOpen: async () => {
        // The real send is an HTTP round trip, so it yields before it finishes.
        // Without a hop here the assertion passes even when onOpen is merely
        // *started* rather than awaited, which is exactly the racing bug.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        order.push("send");
      },
      onEvent: () => order.push("event"),
    });

    expect(order).toEqual(["live", "send", "event"]);
  });

  it("sends user.interrupt on the wall clock and reports terminatedBy timeout", async () => {
    // SPEC § Bounded iteration: an interrupted turn ends with stop_reason
    // end_turn, identical to a clean finish, "so the driver tracks that it sent
    // the interrupt rather than inferring it".
    const source = scriptedSource({
      live: [REAL.slice(0, 5)],
      afterInterrupt: [idle({ type: "end_turn" }, "sevt_after_interrupt")],
    });

    const result = await consumeEvents({
      source,
      deadlineMs: 50,
      log: silent,
    });

    expect(source.interrupts()).toBe(1);
    expect(result.terminatedBy).toBe("timeout");
  });
});

/**
 * Points 5 and 6 in the src/events.ts header. Both are Phase 4 fixes to bugs
 * that only a session parked at `requires_action` can reach, which is why three
 * closed phases never saw them.
 */
describe("the custom-tool round trip and the wall clock that bounds it", () => {
  it("does not reconnect once the wall clock has expired", async () => {
    // Point 5. The bug: the reconnect loop was guarded on `reason === null`
    // alone, so an expired run kept reconnecting. Both timers are one-shot and
    // already spent by then, so on a session parked at `requires_action` — which
    // emits nothing at all — `drain()` on the new stream never returns and
    // `consumeEvents` never resolves. A ten-ticket driver wedges on ticket one.
    //
    // Asserting on `connects()` targets the guard directly. The hang is the
    // downstream consequence of the reconnect; reconnecting at all after expiry
    // is the defect. Reverting `!timedOut` makes this read 4, not 1.
    //
    // The first stream outlives the deadline and then ends without a terminal
    // event, which is the shape point 4 turns into a reconnect. `interrupt()`
    // is a no-op here on purpose: a session blocked on an unresolved tool event
    // is exactly the case where the interrupt does not land.
    let connects = 0;
    const source: EventSource = {
      async live() {
        connects += 1;
        return (async function* () {
          await sleep(60);
        })();
      },
      history() {
        return (async function* () {})();
      },
      async interrupt() {},
      abort() {},
    };

    const result = await consumeEvents({
      source,
      deadlineMs: 20,
      log: silent,
    });

    expect(connects).toBe(1);
    expect(result.terminatedBy).toBe("timeout");
  });

  it("dispatches the custom-tool reply on the idle event, not on arrival", async () => {
    // Point 6. events.d.ts:1184-1190 says the id to echo back "can be found in
    // the last `session.status_idle` event's `stop_reason.event_ids` field", and
    // the committed synthetic fixture encodes use@12 -> idle@15 -> reply@16.
    // Dispatching on arrival posts a result while the session is still running.
    const order: string[] = [];

    await consumeEvents({
      source: replaySource(SYNTHETIC),
      deadlineMs: 60_000,
      log: silent,
      onEvent: (e) => order.push(e.type),
      onCustomToolUse: async () => {
        order.push("DISPATCH");
      },
    });

    const at = order.indexOf("DISPATCH");
    expect(at).toBeGreaterThan(-1);
    // Immediately after the real idle — not after `agent.custom_tool_use`, and
    // not after the `session.thread_status_idle` decoy that carries an identical
    // stop_reason two events earlier.
    expect(order[at - 1]).toBe("session.status_idle");
    expect(order.filter((o) => o === "DISPATCH")).toHaveLength(1);
  });

  it("answers every blocking id, so two calls in one turn do not deadlock", async () => {
    // events.d.ts:701-702: "Resolving fewer than all re-emits
    // `session.status_idle` with the remainder." Taking `event_ids[0]` and
    // ignoring the rest parks the session until the wall clock fires.
    const answered: string[] = [];

    await consumeEvents({
      source: replaySource([
        customToolUse("sevt_use_a"),
        customToolUse("sevt_use_b"),
        idle({ type: "requires_action", event_ids: ["sevt_use_a", "sevt_use_b"] }, "sevt_block"),
        idle({ type: "end_turn" }, "sevt_end"),
      ]),
      deadlineMs: 60_000,
      log: silent,
      onCustomToolUse: async (e) => {
        answered.push(e.id);
      },
    });

    expect(answered).toEqual(["sevt_use_a", "sevt_use_b"]);
  });

  it("does not answer a blocking id that is not a custom tool call", async () => {
    // `requires_action` carries no discriminator — tool confirmation blocks with
    // the identical shape (permission-policies.md:653). Sending a
    // `user.custom_tool_result` for a confirmation id is a 400 that leaves the
    // session parked, which is exactly the state point 5 has to escape.
    const answered: string[] = [];

    const result = await consumeEvents({
      source: replaySource([
        customToolUse("sevt_use_a"),
        idle({ type: "requires_action", event_ids: ["sevt_confirmation"] }, "sevt_block"),
        idle({ type: "end_turn" }, "sevt_end"),
      ]),
      deadlineMs: 60_000,
      log: silent,
      onCustomToolUse: async (e) => {
        answered.push(e.id);
      },
    });

    expect(answered).toEqual([]);
    expect(result.terminatedBy).toBe("end_turn");
  });
});
