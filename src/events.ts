/**
 * THE SSE CONSUMER. Phase 3.
 *
 * SPEC § Files → `src/events.ts`:
 *   "SSE consumer: typed handling, terminal gate, reconnect"
 *
 * SPEC § The SSE consumer opens with the reason this file is specified
 * concretely rather than left to taste: it "is the piece most likely to be
 * mistaken for a print loop". The four behaviours below are the ones that make
 * it not a print loop, and each has a failure mode that only shows up in a phase
 * later than the one that would have caught it.
 *
 * 1. TERMINAL GATE. Break on `session.status_terminated`, or on
 *    `session.status_idle` when `stop_reason.type !== 'requires_action'`. Idle
 *    alone is not terminal — from Phase 4 the session idles transiently on every
 *    ticket while waiting for the `submit_triage_decision` result, and a loop
 *    that breaks on bare idle abandons every ticket at the decision step.
 *
 *    This gate is EXTRACTED from src/run.ts:202-215, where Phase 2 wrote it
 *    correctly, not re-derived. The reference docs get it wrong twice, in all
 *    eight of their languages:
 *
 *      events-and-streaming.md:471-473  (the headline streaming example)
 *        } else if (event.type === "session.status_idle") { break; }
 *
 *      events-and-streaming.md:741-755  (the reconnect example)
 *        if (seenEventIds.has(event.id)) continue;   <- before the terminal check
 *        ...
 *        } else if (event.type === "session.status_idle") { break; }
 *
 *    The doc contradicts itself — events-and-streaming.md:1951-1953 gets it
 *    right, guarding on `stop_reason.type` exactly as SPEC does. The half it
 *    leads with is the wrong one for any session that uses custom tools.
 *
 * 2. DEDUPE GATES HANDLING ONLY, NEVER THE TERMINAL CHECK. That is the second
 *    bug above. A terminal event already present in the history page would be
 *    skipped by `continue` and the loop would never exit. Here the terminal
 *    check runs on every sighting, seen or not.
 *
 * 3. `event_start` / `event_delta` CARRY NO TOP-LEVEL `id`.
 *    events-and-streaming.md:1100: "Unlike persisted events, `event_start` and
 *    `event_delta` have no `id` or `processed_at` of their own." Reading
 *    `.id` off the stream union is a compile error, not just a runtime risk, so
 *    they are filtered by `type` first. They are stream-only and never persisted
 *    (:1855), so they can never appear in a history page.
 *
 * 4. STREAM EXHAUSTION IS NOT COMPLETION. Read from the SDK source, not the
 *    docs — @anthropic-ai/sdk/core/streaming.js:119-133: a clean server close
 *    ends the `for await` silently, and `controller.abort()` also returns
 *    silently. Only a socket drop throws. So the iterator ending proves nothing.
 *    ONLY A TERMINAL EVENT PROVES COMPLETION; exhaustion without one is a
 *    dropped stream and triggers the reconnect path. SPEC § The SSE consumer
 *    specifies the reconnect procedure but never says what triggers it.
 *    See docs/DECISIONS.md D-022.
 *
 *   usage:  pnpm exec tsx src/events.ts tests/fixtures/session-events.jsonl
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { readFileSync } from "node:fs";
import { addUsage, emptyTally, type SpanUsage, type Tally } from "./cost.js";
import { TriageDecision } from "./decision.js";

/**
 * SPEC § Files writes `SessionEvent` and `AgentCustomToolUseEvent`. The SDK
 * prefixes everything `BetaManagedAgents…`, and — load-bearing — splits the
 * union in two: `list()` yields the 34 persisted members, `stream()` yields
 * those plus `event_start` and `event_delta`. Consume against the wider one.
 */
export type SessionEvent = BetaManagedAgentsSessionEvent;
export type StreamEvent = BetaManagedAgentsStreamSessionEvents;
export type AgentCustomToolUseEvent = BetaManagedAgentsAgentCustomToolUseEvent;

/**
 * SPEC § Bounded iteration names four terminal outcomes for the grader; these
 * five are the ones `span.outcome_evaluation_end.result` can carry. The SDK
 * types that field as plain `string` (events.d.ts:1004) despite its own
 * docstring enumerating exactly these, so the compiler gives no exhaustiveness
 * help and an unrecognised value has to survive.
 */
export type OutcomeResult =
  | "satisfied"
  | "needs_revision"
  | "max_iterations_reached"
  | "failed"
  | "interrupted";

/** The fields SPEC § The SSE consumer names as the grader instrumentation. */
export type OutcomeEvaluation = {
  outcomeId: string;
  iteration: number;
  result: OutcomeResult | (string & {});
  explanation: string;
  usage: SpanUsage;
};

/** SPEC § Files → `src/events.ts`, verbatim. */
export type ConsumerResult = {
  events: SessionEvent[];
  decision: TriageDecision | null;
  outcomeEvaluations: OutcomeEvaluation[];
  toolCalls: { name: string; durationMs: number }[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  terminatedBy: "end_turn" | "retries_exhausted" | "terminated" | "timeout";
};

export type TerminatedBy = ConsumerResult["terminatedBy"];

/** What a terminal event yields, before the timeout override is applied. */
type TerminalReason = Exclude<TerminatedBy, "timeout">;

/**
 * `session.error` with `type: 'billing_error'`. Under SPEC § Cost controls'
 * $5 hard workspace cap this is the failure that ends a build session, and the
 * SDK's own docstring for the error says retrying with the same credentials
 * will not succeed — so the consumer stops rather than draining to a terminal
 * event that may never come.
 *
 * `terminatedBy` has no value for it, which is why this is an exception rather
 * than a fifth member of that union. The events consumed up to the failure are
 * attached: on a spend-limit run they are the only record of what was bought.
 */
export class SpendLimitReached extends Error {
  readonly partial: ConsumerResult;
  constructor(message: string, partial: ConsumerResult) {
    super(message);
    this.name = "SpendLimitReached";
    this.partial = partial;
  }
}

// ---------------------------------------------------------------------------
// THE TERMINAL GATE
// ---------------------------------------------------------------------------

/**
 * The single decision point for "is this session over". Nothing else in this
 * file may end the loop.
 *
 * `session.thread_status_idle` is deliberately NOT here, and the Phase 2 trace
 * shows why: it arrives immediately BEFORE `session.status_idle`
 * (…03.017473Z vs …03.017475Z) carrying an identical
 * `stop_reason: {type: "end_turn"}`. A gate keyed on `stop_reason` alone, or on
 * a `type.endsWith("status_idle")` shortcut, fires one event early — and in a
 * multiagent session would fire on a child thread. reference.md:55: every
 * session emits the thread events for its primary thread.
 *
 * `session.deleted` IS here, and SPEC does not mention it. events.d.ts:650-652:
 * "Terminates any active event stream — no further events will be emitted for
 * this session." Without it the loop waits out the wall clock on a dead socket.
 * Raised as amendment A-5 in docs/DECISIONS.md rather than applied silently;
 * mapped to `terminated` because `terminatedBy` has no value of its own for it.
 *
 * `session.status_rescheduled` is NOT terminal — reference.md:49 calls it a
 * transient error the session is retrying automatically.
 */
export function terminalReason(event: StreamEvent): TerminalReason | null {
  switch (event.type) {
    case "session.status_terminated":
      return "terminated";

    case "session.deleted":
      return "terminated";

    case "session.status_idle":
      // Idle alone is not terminal. See the header, point 1.
      return event.stop_reason.type === "requires_action"
        ? null
        : event.stop_reason.type;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

const glyph = {
  note: " ·",
  toolOut: " →",
  toolIn: " ←",
  agent: " ⌁",
  grader: " ⧗",
  block: " ⚑",
  error: " !!",
  unknown: " ?",
} as const;

/**
 * Reads `type` and `id` off an event the union does not describe, without
 * asserting anything that may not be there.
 *
 * `event as { type: string; id: string }` is the cast that lies: it claims `id`
 * exists on members that provably lack it. Widening to an arbitrary record and
 * proving each field at runtime claims nothing.
 */
function describeUnknown(event: unknown): { type: string; id: string | null } {
  const record = event as Record<string, unknown>;
  return {
    type: typeof record["type"] === "string" ? record["type"] : "(no type)",
    id: typeof record["id"] === "string" ? record["id"] : null,
  };
}

const textOf = (
  content: readonly { type: string; text?: string }[] | undefined,
): string =>
  (content ?? [])
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join(" ");

class Trace {
  readonly events: SessionEvent[] = [];
  readonly outcomeEvaluations: OutcomeEvaluation[] = [];
  readonly toolCalls: { name: string; durationMs: number }[] = [];
  readonly seen: Set<string>;

  decision: TriageDecision | null = null;
  private readonly usage: Tally = emptyTally();

  /**
   * use-event id -> what we need to close it out when its result arrives.
   * Keyed on the id because that is what the result event back-references:
   * `agent.mcp_tool_result.mcp_tool_use_id` (verified in the Phase 2 trace) and
   * `agent.tool_result.tool_use_id` (events.d.ts:297).
   */
  private readonly pendingTools = new Map<
    string,
    { name: string; startedAt: number }
  >();

  constructor(
    private readonly log: (line: string) => void,
    seen?: Set<string>,
  ) {
    this.seen = seen ?? new Set<string>();
  }

  /**
   * NO DURATION FIELD EXISTS. A case-insensitive search of the reference set for
   * `duration`, `started_at`, `ended_at`, `elapsed` and `latency` returns
   * nothing, and every event in the Phase 2 trace carries exactly one time
   * field. So `durationMs` is DERIVED from the gap between two `processed_at`
   * stamps, and `processed_at` is a COMPLETION stamp
   * (events-and-streaming.md:22 — "set when the event finishes processing").
   *
   * That makes it honest for a tool call — the use event completes when the
   * model emits it, the result event completes when the result lands — but it
   * is not a platform-reported latency and must not be presented as one.
   * Adjacent events are co-stamped to the microsecond, so clamp at zero.
   */
  private closeToolCall(useEventId: string, at: string): void {
    const pending = this.pendingTools.get(useEventId);
    if (!pending) return;
    this.pendingTools.delete(useEventId);
    const durationMs = Math.max(0, Date.parse(at) - pending.startedAt);
    this.toolCalls.push({ name: pending.name, durationMs });
  }

  async handle(
    event: StreamEvent,
    onCustomToolUse?: (e: AgentCustomToolUseEvent) => Promise<void>,
  ): Promise<void> {
    // `event_start` / `event_delta` are filtered before this is reached, so
    // everything here is a persisted event and carries `id` + `processed_at`.
    this.events.push(event as SessionEvent);

    switch (event.type) {
      // ---- client-sent echoes ------------------------------------------
      case "user.message":
      case "user.interrupt":
      case "user.define_outcome":
      case "user.custom_tool_result":
      case "user.tool_confirmation":
      case "user.tool_result":
        // `processed_at` is INFORMATIONAL ONLY here — never a state input and
        // never a dedupe key. SPEC § The SSE consumer originally framed
        // client-sent events as always appearing twice, null first; amendment
        // A-2 (accepted 2026-08-04) corrects that to "null only while genuinely
        // queued behind earlier events". `event.id` is what handles repeats.
        this.log(`${glyph.note} ${event.type}`);
        break;

      // ---- agent output ------------------------------------------------
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            this.log(`${glyph.agent} agent: ${block.text.trim()}`);
          }
        }
        break;

      case "agent.thinking":
        // reference.md:33 — a progress signal, it carries no thinking content.
        this.log(`${glyph.note} agent.thinking`);
        break;

      // ---- tool calls --------------------------------------------------
      case "agent.tool_use":
        this.pendingTools.set(event.id, {
          name: event.name,
          startedAt: Date.parse(event.processed_at),
        });
        this.log(`${glyph.toolOut} tool  ${event.name}  ${JSON.stringify(event.input)}`);
        break;

      case "agent.tool_result":
        this.closeToolCall(event.tool_use_id, event.processed_at);
        this.log(
          `${glyph.toolIn} tool  is_error=${event.is_error ?? false}  ${textOf(event.content).slice(0, 200)}`,
        );
        break;

      case "agent.mcp_tool_use":
        this.pendingTools.set(event.id, {
          name: event.name,
          startedAt: Date.parse(event.processed_at),
        });
        this.log(
          `${glyph.toolOut} mcp   ${event.mcp_server_name}.${event.name}  ${JSON.stringify(event.input)}`,
        );
        break;

      case "agent.mcp_tool_result":
        this.closeToolCall(event.mcp_tool_use_id, event.processed_at);
        this.log(
          `${glyph.toolIn} mcp   is_error=${event.is_error ?? false}  ${textOf(event.content).slice(0, 200)}`,
        );
        break;

      case "agent.custom_tool_use": {
        this.log(`${glyph.block} custom_tool_use  ${event.name}`);
        // SPEC § Decision capture puts the reply and the is_error path in
        // run.ts; the consumer records the decision for ConsumerResult and
        // hands the event on. A payload that fails the schema leaves
        // `decision` null — it is the caller that gets to answer with
        // `is_error: true` so the agent can correct.
        const parsed = TriageDecision.safeParse(event.input);
        if (parsed.success) {
          this.decision = parsed.data;
        } else {
          this.log(
            `${glyph.error} custom tool payload failed TriageDecision: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`,
          );
        }
        if (onCustomToolUse) await onCustomToolUse(event);
        break;
      }

      // ---- token usage -------------------------------------------------
      case "span.model_request_end":
        // The AGENT's spend, and it covers the agent completely: with no grader
        // running, these spans reconcile to `session.usage` field for field
        // (docs/DECISIONS.md D-017). The grader's own usage block is
        // zero-filled, which is why cost.ts derives the grader share from
        // session.usage instead of reading it here.
        addUsage(this.usage, event.model_usage);
        this.log(
          `${glyph.note} model_request_end  in ${event.model_usage.input_tokens}` +
            ` out ${event.model_usage.output_tokens}` +
            ` cache r ${event.model_usage.cache_read_input_tokens}` +
            ` w ${event.model_usage.cache_creation_input_tokens}`,
        );
        break;

      // ---- grader ------------------------------------------------------
      case "span.outcome_evaluation_start":
      case "span.outcome_evaluation_ongoing":
        this.log(
          `${glyph.grader} grader  iteration ${event.iteration}  ${event.type.replace("span.outcome_evaluation_", "")}`,
        );
        break;

      case "span.outcome_evaluation_end":
        this.outcomeEvaluations.push({
          outcomeId: event.outcome_id,
          iteration: event.iteration,
          result: event.result,
          explanation: event.explanation,
          usage: event.usage,
        });
        this.log(
          `${glyph.grader} grader  iteration ${event.iteration}  ${event.result}  ${event.explanation.slice(0, 160)}`,
        );
        break;

      // ---- session lifecycle -------------------------------------------
      case "session.status_idle":
        this.log(`${glyph.note} session.status_idle  stop_reason=${event.stop_reason.type}`);
        break;

      case "session.status_running":
      case "session.status_rescheduled":
      case "session.status_terminated":
      case "session.deleted":
        this.log(`${glyph.note} ${event.type}`);
        break;

      case "session.thread_status_idle":
        // The decoy. Logged so the trace shows it arriving before the real
        // idle, never gated on. See `terminalReason`.
        this.log(
          `${glyph.note} session.thread_status_idle  stop_reason=${event.stop_reason?.type ?? "(none)"}  (not the gate)`,
        );
        break;

      case "session.error":
        this.log(`${glyph.error} session.error  ${event.error.type}: ${event.error.message}`);
        break;

      // ---- known, and deliberately uninteresting ------------------------
      // Named explicitly rather than left to `default:` so that "unknown event"
      // in the trace means the SDK union does not describe it — which is the
      // only reading under which the acceptance criterion says anything.
      case "span.model_request_start":
      case "session.thread_created":
      case "session.thread_status_running":
      case "session.thread_status_rescheduled":
      case "session.thread_status_terminated":
      case "session.updated":
      case "agent.thread_context_compacted":
      case "agent.thread_message_received":
      case "agent.thread_message_sent":
      case "system.message":
        this.log(`${glyph.note} ${event.type}`);
        break;

      default: {
        // SPEC § The SSE consumer: "Default branch logs {type, id} and
        // continues." Reached by fixture replay and by `events.list()`, both of
        // which are plain JSON. On the LIVE stream it is reached only by names
        // on the SDK's own SSE allowlist (core/streaming.js:56-101) that have no
        // TypeScript member — `agent.session_thread_message_received`,
        // `agent.session_thread_message_sent`, `session.thread_status_created`.
        // A genuinely novel type is dropped by that allowlist before it ever
        // reaches here. See docs/DECISIONS.md D-023.
        const { type, id } = describeUnknown(event);
        this.log(`${glyph.unknown} unknown event  type=${type} id=${id ?? "(none)"}`);
        break;
      }
    }
  }

  finish(terminatedBy: TerminatedBy): ConsumerResult {
    for (const [id, pending] of this.pendingTools) {
      this.log(
        `${glyph.unknown} tool ${pending.name} (${id}) never returned a result — omitted from toolCalls`,
      );
    }
    return {
      events: this.events,
      decision: this.decision,
      outcomeEvaluations: this.outcomeEvaluations,
      toolCalls: this.toolCalls,
      usage: {
        input: this.usage.input,
        output: this.usage.output,
        cacheRead: this.usage.cacheRead,
        cacheCreation: this.usage.cacheWrite,
      },
      terminatedBy,
    };
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * The seam that keeps `tests/events.test.ts` offline while still exercising the
 * production loop. `consumeSession` builds the real one from an `Anthropic`
 * client; a test builds one over an array.
 */
export type EventSource = {
  /** Open a fresh live stream. Called once at start, then once per reconnect. */
  live(): Promise<AsyncIterable<StreamEvent>>;
  /** Page the persisted event history, oldest first. */
  history(): AsyncIterable<SessionEvent>;
  /** Send `user.interrupt`. */
  interrupt(): Promise<void>;
  /** Abort any stream still open. */
  abort(): void;
};

/** How long after the wall clock expires to keep draining before giving up. */
const INTERRUPT_GRACE_MS = 30_000;

const DEFAULT_MAX_RECONNECTS = 3;

export async function consumeEvents(opts: {
  source: EventSource;
  deadlineMs: number;
  onCustomToolUse?: ((e: AgentCustomToolUseEvent) => Promise<void>) | undefined;
  log?: ((line: string) => void) | undefined;
  /**
   * Awaited once, immediately after the FIRST stream is open and before any
   * event is read. This is where the caller sends the event that starts the
   * work.
   *
   * STREAM FIRST, THEN SEND (SPEC § Session topology step 2;
   * events-and-streaming.md:369 — "Only events emitted after the stream is
   * opened are delivered"). Without this hook a caller can only fire the send
   * alongside `consumeSession()` and hope the stream wins the race, which is
   * exactly the race SPEC says not to run. Not called again on reconnect: the
   * work has already started by then, and history replay covers the gap.
   */
  onOpen?: (() => Promise<void>) | undefined;
  /**
   * Raw side effect per freshly-seen event, before it is handled. Exists so a
   * caller can persist the trace as it arrives rather than from the returned
   * `events` array — the run that throws is the run whose trace matters most.
   */
  onEvent?: ((e: StreamEvent) => void) | undefined;
  /** Pre-seeded ids. Exists so a test can prove the terminal check is not gated by the dedupe. */
  seenEventIds?: Set<string> | undefined;
  maxReconnects?: number | undefined;
}): Promise<ConsumerResult> {
  const { source, deadlineMs } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const trace = new Trace(log, opts.seenEventIds);

  let timedOut = false;

  // SPEC § Bounded iteration: on expiry send `user.interrupt`, drain to idle,
  // record the ticket as timed out. NOT an abort — an interrupted turn still
  // produces a clean `session.status_idle`, and abandoning the stream would
  // throw away the events between here and there.
  const softTimer = setTimeout(() => {
    timedOut = true;
    log(`${glyph.error} wall clock expired after ${deadlineMs}ms — sending user.interrupt`);
    void source.interrupt().catch((err: unknown) => {
      log(`${glyph.error} user.interrupt failed: ${String(err)}`);
    });
  }, deadlineMs);

  // If the interrupt does not produce a terminal event, stop waiting.
  const hardTimer = setTimeout(() => {
    log(`${glyph.error} no terminal event ${INTERRUPT_GRACE_MS}ms after interrupt — aborting stream`);
    source.abort();
  }, deadlineMs + INTERRUPT_GRACE_MS);

  /** Returns the terminal reason, or null if the iterable ran out first. */
  const drain = async (
    events: AsyncIterable<StreamEvent> | AsyncIterable<SessionEvent>,
  ): Promise<TerminalReason | null> => {
    for await (const event of events as AsyncIterable<StreamEvent>) {
      // Point 3 in the header: filter by type BEFORE touching `.id`.
      if (event.type === "event_start" || event.type === "event_delta") continue;

      const fresh = !trace.seen.has(event.id);
      if (fresh) {
        trace.seen.add(event.id);
        opts.onEvent?.(event);
        await trace.handle(event, opts.onCustomToolUse);

        if (event.type === "session.error" && event.error.type === "billing_error") {
          throw new SpendLimitReached(
            `SPEND LIMIT REACHED: ${event.error.message}. Retrying with the same ` +
              `credentials will not succeed.`,
            trace.finish("terminated"),
          );
        }
      }

      // ALWAYS, outside the freshness guard. Point 2 in the header: gating this
      // on `fresh` is the bug that makes a terminal event present in a replayed
      // history page invisible, and the loop never exits.
      const reason = terminalReason(event);
      if (reason) return reason;
    }
    return null;
  };

  try {
    const first = await source.live();
    if (opts.onOpen) await opts.onOpen();
    let reason = await drain(first);

    // Exhaustion without a terminal event means the stream went away, not that
    // the session finished. Point 4 in the header.
    for (let attempt = 1; reason === null && attempt <= maxReconnects; attempt++) {
      log(
        `${glyph.note} stream ended with no terminal event — reconnect ${attempt}/${maxReconnects}`,
      );

      // events-and-streaming.md:653-658, and the order is load-bearing: open the
      // new stream FIRST so nothing emitted during the handover is lost, THEN
      // page history, THEN tail.
      const next = await source.live();

      // The doc's samples only seed ids from history, which silently discards
      // everything that arrived while disconnected. Handle it instead; the
      // dedupe above makes replaying already-seen events free.
      reason = await drain(source.history());
      if (reason === null) reason = await drain(next);
    }

    if (reason === null && !timedOut) {
      throw new Error(
        `Stream ended with no terminal event after ${maxReconnects} reconnects. ` +
          `${trace.events.length} events consumed.`,
      );
    }

    // SPEC § Bounded iteration: "An interrupted turn ends with stop_reason:
    // end_turn, the same value a clean finish carries, so the driver tracks
    // that it sent the interrupt rather than inferring it."
    return trace.finish(timedOut ? "timeout" : (reason as TerminalReason));
  } finally {
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
    source.abort();
  }
}

/** The real `EventSource`, over the Managed Agents API. */
function apiSource(client: Anthropic, sessionId: string): EventSource {
  let open: { controller: AbortController } | null = null;
  return {
    async live() {
      // Note the await: `stream()` returns APIPromise<Stream<…>>, and the
      // promise is not itself async-iterable (events.d.ts:60).
      const stream = await client.beta.sessions.events.stream(sessionId);
      open = stream;
      return stream;
    },
    history() {
      // `order: 'asc'` is the SDK default (events.d.ts:1415-1418) but is pinned
      // explicitly: the page cursor encodes the order it was created with, and
      // reusing one under a different order is a 400.
      return client.beta.sessions.events.list(sessionId, { order: "asc" });
    },
    async interrupt() {
      await client.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.interrupt" }],
      });
    },
    abort() {
      open?.controller.abort();
      open = null;
    },
  };
}

/** SPEC § Files → `src/events.ts`, verbatim signature. */
export function consumeSession(opts: {
  client: Anthropic;
  sessionId: string;
  deadlineMs: number;
  onCustomToolUse: (e: AgentCustomToolUseEvent) => Promise<void>;
  log?: ((line: string) => void) | undefined;
  onEvent?: ((e: StreamEvent) => void) | undefined;
  /** Send the event that starts the work here — see `consumeEvents`. */
  onOpen?: (() => Promise<void>) | undefined;
}): Promise<ConsumerResult> {
  return consumeEvents({
    source: apiSource(opts.client, opts.sessionId),
    deadlineMs: opts.deadlineMs,
    onCustomToolUse: opts.onCustomToolUse,
    log: opts.log,
    onEvent: opts.onEvent,
    onOpen: opts.onOpen,
  });
}

// ---------------------------------------------------------------------------
// Fixture replay
// ---------------------------------------------------------------------------

/** One JSON object per line, as `src/run.ts` writes it. */
export function readEventsJsonl(path: string): StreamEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as StreamEvent);
}

/**
 * An `EventSource` that replays a fixed list once and has no history. Used by
 * the CLI below and by the fixture-replay test, so the offline path runs the
 * same `consumeEvents` loop the live path does.
 */
export function replaySource(events: readonly StreamEvent[]): EventSource {
  return {
    async live() {
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
    history() {
      return (async function* () {
        /* no history */
      })();
    },
    async interrupt() {
      /* nothing to interrupt */
    },
    abort() {
      /* nothing to abort */
    },
  };
}

// --- CLI -------------------------------------------------------------------
// The acceptance criterion's "prints a readable trace", made runnable offline.

async function main(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    console.error("usage: pnpm exec tsx src/events.ts <events.jsonl> [...]");
    process.exit(2);
  }

  const events = paths.flatMap((path) => readEventsJsonl(path));
  console.log(`── replay ${paths.join(" + ")} `.padEnd(72, "─"));
  console.log(`  ${events.length} events\n`);

  const result = await consumeEvents({
    source: replaySource(events),
    deadlineMs: 60_000,
  });

  console.log(`\n── ConsumerResult `.padEnd(72, "─"));
  const line = (k: string, v: string) => console.log(`  ${k.padEnd(22)}${v}`);
  line("terminatedBy", result.terminatedBy);
  line("events", String(result.events.length));
  line("decision", result.decision ? JSON.stringify(result.decision) : "null");
  line(
    "toolCalls",
    result.toolCalls.length === 0
      ? "(none)"
      : result.toolCalls.map((t) => `${t.name} ${t.durationMs}ms (derived)`).join(", "),
  );
  line(
    "outcomeEvaluations",
    result.outcomeEvaluations.length === 0
      ? "(none)"
      : result.outcomeEvaluations
          .map((o) => `#${o.iteration} ${o.result}`)
          .join(", "),
  );
  line(
    "usage",
    `in ${result.usage.input} / out ${result.usage.output}` +
      ` / cache r ${result.usage.cacheRead} w ${result.usage.cacheCreation}`,
  );
  console.log("─".repeat(72));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0")) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
