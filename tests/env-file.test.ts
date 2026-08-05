/**
 * `.env.local` is the only place the workspace-scoped API key exists, and keys
 * cannot be moved between workspaces — losing it means re-minting in the
 * Console. `upsertEnvFile` rewrites that file, so it gets a regression test.
 *
 * Beyond SPEC § Verification's three suites; added in Phase 2 alongside the
 * helper it covers. See docs/DECISIONS.md D-016.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertEnvFile } from "../src/env-file.js";

/** Resolved locally rather than imported from `config.ts`, for the reason this
 *  file's second describe block exists. `tests/events.test.ts` does the same. */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

const ORIGINAL = [
  "# Copy to .env.local and fill in.",
  "",
  "ANTHROPIC_API_KEY=sk-ant-api03-SECRET-VALUE",
  "ANTHROPIC_WORKSPACE_ID=wrkspc_01ABC",
  "",
  "# --- produced by Phase 2 ---",
  "ENVIRONMENT_ID=",
  "AGENT_ID=",
  "",
].join("\n");

let path = "";

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "envfile-")), ".env.local");
  writeFileSync(path, ORIGINAL, "utf8");
});

describe("upsertEnvFile", () => {
  it("fills an existing empty key in place", () => {
    const result = upsertEnvFile({ ENVIRONMENT_ID: "env_123" }, path);

    expect(result).toEqual({ updated: ["ENVIRONMENT_ID"], appended: [] });
    expect(readFileSync(path, "utf8")).toContain("\nENVIRONMENT_ID=env_123\n");
  });

  it("replaces an existing populated key rather than duplicating it", () => {
    upsertEnvFile({ ENVIRONMENT_ID: "env_first" }, path);
    upsertEnvFile({ ENVIRONMENT_ID: "env_second" }, path);

    const after = readFileSync(path, "utf8");
    expect(after).toContain("ENVIRONMENT_ID=env_second");
    expect(after.match(/^ENVIRONMENT_ID=/gm)).toHaveLength(1);
  });

  it("appends a key the file does not already have", () => {
    const result = upsertEnvFile({ VAULT_ID: "vlt_abc" }, path);

    expect(result).toEqual({ updated: [], appended: ["VAULT_ID"] });
    expect(readFileSync(path, "utf8")).toContain("VAULT_ID=vlt_abc");
  });

  it("preserves comments, blank lines, ordering, and untouched values", () => {
    upsertEnvFile({ AGENT_ID: "agent_9" }, path);

    const after = readFileSync(path, "utf8");
    expect(after).toContain("# Copy to .env.local and fill in.");
    expect(after).toContain("# --- produced by Phase 2 ---");
    expect(after).toContain("ANTHROPIC_API_KEY=sk-ant-api03-SECRET-VALUE");
    expect(after).toContain("ANTHROPIC_WORKSPACE_ID=wrkspc_01ABC");
    expect(after.indexOf("ANTHROPIC_API_KEY")).toBeLessThan(
      after.indexOf("ENVIRONMENT_ID"),
    );
  });

  it("never touches the API key across many writes", () => {
    for (let i = 0; i < 25; i++) {
      upsertEnvFile({ ENVIRONMENT_ID: `env_${i}`, [`NEW_${i}`]: `v${i}` }, path);
    }

    const after = readFileSync(path, "utf8");
    expect(after.match(/^ANTHROPIC_API_KEY=sk-ant-api03-SECRET-VALUE$/gm))
      .toHaveLength(1);
  });

  it("writes nothing when the target file does not exist", () => {
    expect(() =>
      upsertEnvFile({ AGENT_ID: "agent_1" }, join(tmpdir(), "nope", ".env")),
    ).toThrow();
  });

  it("refuses a value containing a newline, leaving the file untouched", () => {
    // Silent corruption, not key loss: writing "ok\nINJECTED=1" would append a
    // line the caller never asked for while dropping nothing, so the
    // dropped-key invariant alone does not catch it.
    const before = readFileSync(path, "utf8");

    expect(() => upsertEnvFile({ AGENT_ID: "ok\nINJECTED=1" }, path)).toThrow(
      /contains a newline/,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a key that is not a valid env identifier", () => {
    const before = readFileSync(path, "utf8");

    expect(() => upsertEnvFile({ "BAD KEY": "x" }, path)).toThrow(/invalid key/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

/**
 * docs/DECISIONS.md D-028. This suite is the one that made `pnpm -s test`
 * non-hermetic: it imported `upsertEnvFile`, which imported `ENV_PATH` from
 * `src/config.ts`, which runs `export const env = load()` at module scope and
 * throws unless four keys are present. So the whole suite failed at import
 * without `.env.local` — and SPEC § Verification makes this suite the Stop hook
 * gate, which therefore could not run from a clean clone or in CI.
 *
 * The fix is held here rather than by memory, because its failure signature is
 * invisible to anyone whose `.env.local` happens to exist — which is everyone
 * who has ever worked on this repo. A static import check catches the
 * regression on a machine where the runtime symptom cannot reproduce.
 */
describe("the offline suite stays hermetic (D-028)", () => {
  it("env-file.ts takes ENV_PATH from paths.ts, never from config.ts", () => {
    const source = readFileSync(join(SRC, "env-file.ts"), "utf8");

    expect(source).toMatch(/import\s*\{[^}]*\bENV_PATH\b[^}]*\}\s*from\s*"\.\/paths\.js"/);
    expect(source).not.toMatch(/from\s*"\.\/config\.js"/);
  });

  it("paths.ts imports only node: builtins and reads no environment", () => {
    const source = readFileSync(join(SRC, "paths.ts"), "utf8");

    const imports = [...source.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^node:/);
    }
    // A path constant derived from process.env would reintroduce the coupling
    // through the back door, with no import to notice.
    expect(source).not.toContain("process.env");
  });

  it("config.ts still re-exports both names, so existing callers are unchanged", () => {
    const source = readFileSync(join(SRC, "config.ts"), "utf8");

    expect(source).toMatch(/export\s*\{[^}]*\bENV_PATH\b[^}]*\}/);
    expect(source).toMatch(/export\s*\{[^}]*\bREPO_ROOT\b[^}]*\}/);
  });
});
