/**
 * Token accounting and the per-run dollar estimate SPEC § Cost controls #1
 * requires.
 *
 * Two honest limits on that number, both recorded in docs/DECISIONS.md D-017:
 *
 * 1. NO MODEL ATTRIBUTION. Neither `span.model_request_end.model_usage` nor
 *    `span.outcome_evaluation_end.usage` carries a model identifier — both are
 *    the same four-integer shape. The grader runs on a model the caller does not
 *    choose (SPEC correction #3: `user.define_outcome` has no grader-model
 *    parameter) and no reference page names it. So agent spend is priced
 *    exactly, and grader spend is reported as a bounded range under a stated
 *    assumption rather than as a single fabricated figure.
 *
 * 2. POSSIBLE DOUBLE COUNTING. It is undocumented whether the grader's own model
 *    requests also emit `span.model_request_end`. If they do, summing both event
 *    families over-counts. `sessions.retrieve().usage` is an independent
 *    cumulative total, so printing it alongside resolves the question from real
 *    data — see `reconcile()`.
 */

/** Dollars per million tokens. */
export type Rates = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}>;

/** claude-api skill, 2026-08-03. Cache read is 0.1x input, write 1.25x (5m TTL). */
export const HAIKU_4_5: Rates = {
  input: 1.0,
  output: 5.0,
  cacheRead: 0.1,
  cacheWrite: 1.25,
};

/** Ceiling for the grader range only. Not a claim about which model grades. */
export const OPUS_5: Rates = {
  input: 5.0,
  output: 25.0,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

/**
 * The span-level usage shape, shared by `span.model_request_end.model_usage`
 * and `span.outcome_evaluation_end.usage`. Flat — unlike the session-level
 * `usage`, whose `cache_creation` nests two TTL buckets.
 */
export type SpanUsage = Readonly<{
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}>;

export type Tally = {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export const emptyTally = (): Tally => ({
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export function addUsage(tally: Tally, u: SpanUsage): void {
  tally.calls += 1;
  tally.input += u.input_tokens;
  tally.output += u.output_tokens;
  tally.cacheRead += u.cache_read_input_tokens;
  tally.cacheWrite += u.cache_creation_input_tokens;
}

export const totalTokens = (t: Tally): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite;

export function price(t: Tally, r: Rates): number {
  return (
    (t.input * r.input +
      t.output * r.output +
      t.cacheRead * r.cacheRead +
      t.cacheWrite * r.cacheWrite) /
    1_000_000
  );
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const int = (n: number) => n.toLocaleString("en-US");

/** Session-level cumulative usage. Note the differing `cache_creation` shape. */
export type SessionUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
};

export function sessionTotal(u: SessionUsage | undefined): number {
  if (!u) return 0;
  const cc = u.cache_creation;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (cc?.ephemeral_5m_input_tokens ?? 0) +
    (cc?.ephemeral_1h_input_tokens ?? 0)
  );
}

/**
 * Print the cost block.
 *
 * MEASURED IN PHASE 2, 2026-08-03 — this changes how the number is computed:
 *
 *   `span.outcome_evaluation_end.usage` came back ALL ZEROS on all three
 *   evaluations of the smoke run, while the grader demonstrably spent ~10.4k
 *   tokens. `define-outcomes.md:619` shows a populated example, so the field is
 *   specified; the platform is simply not filling it in. Summing the two span
 *   families as SPEC § Cost controls #1 directs therefore UNDER-reports — the
 *   smoke run's spans said $0.0116 against a true spend ~2.7x that.
 *
 * So `session.usage` is the authoritative total, and the grader's share is
 * DERIVED by subtracting the agent spans from it rather than read from the
 * grader's own events. The agent share stays exact: `span.model_request_end`
 * is populated and the agent model is pinned in agent.yaml.
 *
 * See docs/DECISIONS.md D-017.
 */
export function report(opts: {
  agent: Tally;
  grader: Tally;
  session?: SessionUsage | undefined;
  label?: string;
}): void {
  const { agent, grader, session } = opts;
  const agentCost = price(agent, HAIKU_4_5);

  const line = (k: string, v: string) => console.log(`  ${k.padEnd(34)}${v}`);

  console.log(`\n── cost ${opts.label ? `· ${opts.label} ` : ""}${"─".repeat(40)}`);
  line(
    `agent  (${agent.calls} model request${agent.calls === 1 ? "" : "s"})`,
    `${int(totalTokens(agent))} tok  in ${int(agent.input)} / out ${int(agent.output)}${agent.cacheRead + agent.cacheWrite > 0 ? ` / cache r ${int(agent.cacheRead)} w ${int(agent.cacheWrite)}` : ""}`,
  );
  line("  at claude-haiku-4-5", `${usd(agentCost)}   exact — model pinned in agent.yaml`);

  if (!session) {
    line("grader", "unknown — no session.usage available");
    console.log("─".repeat(56));
    return;
  }

  // Derived, because the grader's own usage block is not populated.
  const sIn = session.input_tokens ?? 0;
  const sOut = session.output_tokens ?? 0;
  const gIn = Math.max(0, sIn - agent.input);
  const gOut = Math.max(0, sOut - agent.output);
  const graderTally: Tally = {
    calls: grader.calls,
    input: gIn,
    output: gOut,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const graderLo = price(graderTally, HAIKU_4_5);
  const graderHi = price(graderTally, OPUS_5);

  const reportedGraderTokens = totalTokens(grader);
  line(
    `grader (${grader.calls} evaluation${grader.calls === 1 ? "" : "s"})`,
    `${int(gIn + gOut)} tok  in ${int(gIn)} / out ${int(gOut)}   DERIVED from session.usage`,
  );
  if (grader.calls > 0 && reportedGraderTokens === 0) {
    line(
      "",
      "span.outcome_evaluation_end.usage reported 0 — not usable, see D-017",
    );
  }
  line(
    "  bracketed, model unknown",
    grader.calls === 0
      ? "n/a"
      : `${usd(graderLo)} .. ${usd(graderHi)}   Haiku floor .. Opus 5 ceiling`,
  );

  line(
    "session.usage (authoritative)",
    `${int(sessionTotal(session))} tok  in ${int(sIn)} / out ${int(sOut)}`,
  );
  line("RUN TOTAL", `${usd(agentCost + graderLo)} .. ${usd(agentCost + graderHi)}`);

  const graderShare =
    sessionTotal(session) > 0
      ? Math.round(((gIn + gOut) / sessionTotal(session)) * 100)
      : 0;
  line("grader share of tokens", `${graderShare}%`);
  console.log("─".repeat(56));
}
