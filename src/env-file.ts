/**
 * Safe upsert into `.env.local`.
 *
 * That file holds the only copy of the workspace-scoped API key, and keys
 * cannot move between workspaces — a careless rewrite is unrecoverable. So the
 * write is byte-preserving for every line it does not own, and it refuses to
 * write at all unless every key present before is still present after.
 *
 * Used by scripts/apply-control-plane.sh (control plane) and src/deploy.ts
 * (data plane), so the invariant has exactly one implementation.
 *
 * CLI:  pnpm exec tsx src/env-file.ts KEY=value [KEY=value ...]
 */

import { readFileSync, writeFileSync } from "node:fs";

// From `./paths.js`, not `./config.js`. `config.ts` validates the environment at
// module scope and throws without it, which made this module — and therefore
// `tests/env-file.test.ts` — unrunnable from a clean clone. The Stop hook gate
// runs this suite, so the gate could not run either. See docs/DECISIONS.md D-028.
import { ENV_PATH } from "./paths.js";

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Keys assigned in the file, in order of appearance. */
function keysIn(content: string): string[] {
  const found: string[] = [];
  for (const line of content.split("\n")) {
    const m = KEY_LINE.exec(line);
    if (m?.[1]) found.push(m[1]);
  }
  return found;
}

/**
 * Replace the value of each key already assigned in the file; append any key
 * that is not. Comments, blank lines, ordering, and untouched values survive
 * byte-for-byte.
 */
/**
 * `path` is deliberately REQUIRED and has no default. An earlier draft defaulted
 * it to ENV_PATH; a test that failed to pass its temp path silently wrote the
 * real `.env.local` instead. The invariant below caught the key, but the write
 * should never have been possible. Callers name the file they mean.
 */
export function upsertEnvFile(
  updates: Readonly<Record<string, string>>,
  path: string,
): { updated: string[]; appended: string[] } {
  // A newline in a key or value injects lines into the file. The dropped-key
  // invariant below does NOT catch that — nothing is lost, something is added —
  // so it has to be rejected up front. Found by the test for this function.
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Refusing to write ${path}: invalid key ${JSON.stringify(key)}.`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(
        `Refusing to write ${path}: value for ${key} contains a newline.`,
      );
    }
  }

  const before = readFileSync(path, "utf8");
  const pending = new Map(Object.entries(updates));
  const updated: string[] = [];

  const lines = before.split("\n").map((line) => {
    const key = KEY_LINE.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    updated.push(key);
    return `${key}=${value}`;
  });

  const appended = [...pending.keys()];
  if (appended.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    for (const [key, value] of pending) lines.push(`${key}=${value}`);
    lines.push("");
  }

  const after = lines.join("\n");

  // The invariant. A rewrite that drops a key is the failure mode this guards
  // against, and losing ANTHROPIC_API_KEY means re-minting it in the Console.
  const lost = keysIn(before).filter((k) => !keysIn(after).includes(k));
  if (lost.length > 0) {
    throw new Error(
      `Refusing to write ${path}: the rewrite would drop ${lost.join(", ")}. ` +
        `File left untouched.`,
    );
  }

  writeFileSync(path, after, "utf8");
  return { updated, appended };
}

// --- CLI -------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: tsx src/env-file.ts KEY=value [KEY=value ...]");
    process.exit(2);
  }

  const updates: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      console.error(`not a KEY=value pair: ${arg}`);
      process.exit(2);
    }
    updates[arg.slice(0, eq)] = arg.slice(eq + 1);
  }

  const { updated, appended } = upsertEnvFile(updates, ENV_PATH);
  for (const k of updated) console.log(`  .env.local  set     ${k}`);
  for (const k of appended) console.log(`  .env.local  added   ${k}`);
}
