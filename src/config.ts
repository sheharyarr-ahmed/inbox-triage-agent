/**
 * Environment loading and validation.
 *
 * SPEC § Provisioning split: "All IDs land in `.env.local`, validated on load by
 * `src/config.ts`."
 *
 * The API key is read into this process only. It is never exported into a shell
 * that also runs `claude` — a globally visible ANTHROPIC_API_KEY makes Claude
 * Code bill API credits instead of the Max subscription, which breaks the
 * billing boundary the project depends on. `quickstart.md` shows a zero-argument
 * `new Anthropic()`; dotenv satisfies that constructor without the global export.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = resolve(REPO_ROOT, ".env.local");

loadDotenv({ path: ENV_PATH, quiet: true });

/**
 * `.env.example` ships every key present with an empty value, and `deploy.ts`
 * fills them in as each is produced. An empty string is not `undefined`, so
 * `.optional()` alone would reject a not-yet-populated key instead of treating
 * it as absent. Normalise blank to absent first.
 */
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalId = () =>
  z.preprocess(blankToUndefined, z.string().min(1).optional());
const optionalVersion = () =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());

/**
 * Three tiers, because SPEC's key list spans phases and a key that does not
 * exist yet is not an error — it is work that has not happened.
 */
const Env = z.object({
  // Required now.
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_WORKSPACE_ID: z.string().min(1),
  MCP_SERVER_URL: z.string().url(),
  MCP_SERVER_TOKEN: z.string().min(1),

  // Produced during Phase 2.
  ENVIRONMENT_ID: optionalId(),
  AGENT_ID: optionalId(),
  AGENT_VERSION: optionalVersion(),
  VAULT_ID: optionalId(),
  MEMORY_STORE_ID: optionalId(),

  // Deferred to the phase that creates their input artifact.
  TRIAGE_SKILL_ID: optionalId(),
  RUBRIC_FILE_ID: optionalId(),
});

export type Env = z.infer<typeof Env>;
export type OptionalEnvKey = {
  [K in keyof Env]-?: undefined extends Env[K] ? K : never;
}[keyof Env];

/** Which step produces each ID, so a missing one reads as "not built yet". */
const PRODUCED_BY: Record<OptionalEnvKey, string> = {
  ENVIRONMENT_ID: "Phase 2 — bash scripts/apply-control-plane.sh",
  AGENT_ID: "Phase 2 — bash scripts/apply-control-plane.sh",
  AGENT_VERSION: "Phase 2 — bash scripts/apply-control-plane.sh",
  VAULT_ID: "Phase 2 — pnpm deploy",
  MEMORY_STORE_ID: "Phase 2 — pnpm deploy",
  TRIAGE_SKILL_ID: "Phase 4 — pnpm deploy, once agent/skills/triage/SKILL.md exists",
  RUBRIC_FILE_ID: "Phase 6 — pnpm deploy, once agent/rubric.md exists",
};

function load(): Env {
  const parsed = Env.safeParse(process.env);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map(
    (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  throw new Error(
    `Invalid or missing values in ${ENV_PATH}:\n${lines.join("\n")}\n\n` +
      `See .env.example for what each key is and where it comes from.`,
  );
}

export const env = load();

/**
 * Assert that IDs produced by an earlier step are present, naming the step that
 * produces each missing one.
 */
export function requireIds<K extends OptionalEnvKey>(
  keys: readonly K[],
): { [P in K]: NonNullable<Env[P]> } {
  const missing = keys.filter((k) => env[k] === undefined);
  if (missing.length > 0) {
    const lines = missing.map((k) => `  ${k}  <- ${PRODUCED_BY[k]}`);
    throw new Error(
      `Not built yet. ${ENV_PATH} is missing:\n${lines.join("\n")}`,
    );
  }
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as {
    [P in K]: NonNullable<Env[P]>;
  };
}

/**
 * Console trace URL. SPEC § Verification assertion 1 requires this printed per
 * session, but **no page in `docs/reference/` documents the URL or any response
 * field carrying it** — `events-and-streaming.md` § Console observability
 * describes the tracing view only by navigation. Constructed from the workspace
 * ID and verified against the Console address bar on the first live run; the
 * confirmed template is recorded in docs/DECISIONS.md D-019.
 *
 * Note also that the tracing view is role-gated to Developers and Admins, which
 * ship-gate condition 6's screenshots depend on.
 */
export function consoleTraceUrl(sessionId: string): string {
  return `https://platform.claude.com/workspaces/${env.ANTHROPIC_WORKSPACE_ID}/sessions/${sessionId}`;
}
