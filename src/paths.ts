/**
 * Repo paths, and nothing else.
 *
 * **Deviates from SPEC § Files**, which enumerates `src/` and lists no paths
 * module. It exists to close docs/DECISIONS.md D-028: `pnpm -s test` was offline
 * but NOT hermetic, and SPEC § Verification makes that suite the Stop hook gate.
 *
 * The chain that broke it: `tests/env-file.test.ts` imports one symbol from
 * `src/env-file.ts`, which imported `ENV_PATH` from `src/config.ts`, which runs
 * `export const env = load()` at module scope and throws unless four keys are
 * present. So the suite could not run from a clean clone or in CI — it failed at
 * import, before a single assertion.
 *
 * D-028 named three fixes and called this one smallest: split the constant so
 * `env-file.ts` does not import the validating module. `config.ts` re-exports
 * both names, so every existing caller is untouched and keeps its fail-fast
 * behaviour; only the definitions moved.
 *
 * The rule this file has to keep: **no imports beyond `node:`, and no side
 * effects.** Both values derive from `import.meta.url` alone and read no
 * environment. `src/grader.ts:62-64` keeps the same rule for the same reason.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = resolve(REPO_ROOT, ".env.local");
