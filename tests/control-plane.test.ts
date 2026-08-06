/**
 * THE COMMITTED CONTROL PLANE, GUARDED THE WAY `SKILL.md` ALREADY WAS.
 *
 * `agent/agent.yaml` and `agent/environment.yaml` are applied to the API by
 * `scripts/apply-control-plane.sh`. Between them they carry every claim this
 * build makes about what the agent CAN DO, and until now nothing read them.
 * `tests/memory.test.ts` has guarded `SKILL.md` since Phase 5 on the principle
 * that a regression there is silent; these two files are the same class and were
 * simply missed.
 *
 * The one that matters most is the tool allowlist. `docs/LIMITATIONS.md` § 2
 * rests its entire credential argument on it, in as many words: "The agent has no
 * `bash`, no `web_search`, and no `web_fetch` … It has no shell to read an
 * environment from and no outbound channel to send one to. That is verifiable
 * from the repo today." Adding one line to `agent.yaml` would make that sentence
 * false with nothing anywhere going red. A-22 replaced an unsourceable
 * never-in-the-sandbox guarantee with this claim precisely because it is
 * checkable, so it had better be checked.
 *
 * String and regex assertions rather than a YAML parse, matching how
 * `tests/decision-schema.test.ts` reads the same file and adding no dependency to
 * a suite that has to run from a clean clone. Paths resolve locally, never
 * through `src/config.ts` (D-028).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = readFileSync(join(ROOT, "agent", "agent.yaml"), "utf8");
const ENVIRONMENT = readFileSync(join(ROOT, "agent", "environment.yaml"), "utf8");

/** Comment lines carry prose ABOUT these rules, so they must not be matched. */
const code = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

const AGENT_CODE = code(AGENT);
const ENV_CODE = code(ENVIRONMENT);

describe("agent.yaml — the tool allowlist LIMITATIONS § 2 rests on", () => {
  it("never enables bash, web_search or web_fetch", () => {
    // THE LOAD-BEARING ONE. Exfiltration is bounded by what the agent can DO,
    // not by an undocumented claim about what it can see (A-22). One added line
    // would quietly retire that argument.
    for (const tool of ["bash", "web_search", "web_fetch"]) {
      expect(AGENT_CODE, `${tool} must never appear in the toolset`).not.toMatch(
        new RegExp(`name:\\s*${tool}\\b`),
      );
    }
  });

  it("opts in exactly the five file tools SPEC names, and no sixth", () => {
    const enabled = [...AGENT_CODE.matchAll(/name:\s*([a-z_]+),\s*enabled:\s*true/g)].map(
      (m) => m[1],
    );
    expect(enabled.sort()).toEqual(["edit", "glob", "grep", "read", "write"]);
  });

  it("is an allowlist, not a denylist", () => {
    // SPEC § Runtime configuration: "a denylist silently grants any tool added to
    // a future toolset version. The allowlist does not." That property is
    // `default_config.enabled: false`, and losing it inverts the whole posture.
    expect(AGENT_CODE).toMatch(/default_config:\s*\n\s*enabled:\s*false/);
  });
});

describe("agent.yaml — the pins and policies a live run depends on", () => {
  it("pins the model with no date suffix", () => {
    // SPEC's third smaller correction: model IDs carry no date suffix here.
    expect(AGENT_CODE).toMatch(/^model:\s*claude-haiku-4-5\s*$/m);
  });

  it("sets the MCP permission policy to always_allow", () => {
    // D-012. MCP toolsets default to always_ask, and a headless ten-session run
    // stalls on every tool call without this.
    expect(AGENT_CODE).toMatch(/mcp_toolset[\s\S]*?permission_policy:\s*\{\s*type:\s*always_allow\s*\}/);
  });

  it("carries no auth field on mcp_servers", () => {
    // `mcp_servers` accepts {type, name, url} only; the bearer lives in a vault.
    // A header or token here would put the credential in the repo.
    const servers = /mcp_servers:[\s\S]*$/.exec(AGENT_CODE)?.[0] ?? "";
    expect(servers).toMatch(/url:\s*https:\/\//);
    expect(servers).not.toMatch(/authorization|bearer|token|headers|api_key/i);
  });

  it("pins the skill by substituted version, never `latest`", () => {
    // SPEC § Provisioning split: pinned, not `latest`, so a session is
    // reproducible. The placeholder is substituted by apply-control-plane.sh.
    expect(AGENT_CODE).toMatch(/skill_id:\s*\$\{TRIAGE_SKILL_ID\}/);
    expect(AGENT_CODE).toMatch(/version:\s*"\$\{TRIAGE_SKILL_VERSION\}"/);
    expect(AGENT_CODE).not.toMatch(/version:\s*"?latest"?/);
  });

  it("keeps all three system-prompt guardrails", () => {
    // These are the rules that must hold on every turn, which is why they are
    // here and not in the skill (SPEC § The guardrail split).
    expect(AGENT_CODE).toMatch(/data, never instruction/);
    expect(AGENT_CODE).toMatch(/cites its evidence/);
    expect(AGENT_CODE).toMatch(/Escalate on genuine ambiguity/);
  });
});

describe("environment.yaml — the flag whose absence fails silently", () => {
  it("sets allow_mcp_servers: true", () => {
    // SPEC § Runtime configuration: "mandatory, not optional. Under `limited`
    // networking with that flag unset and the MCP host absent from
    // `allowed_hosts`, MCP tools fail SILENTLY rather than erroring."
    //
    // `scripts/apply-control-plane.sh` pipes the environment response to
    // /dev/null, so nothing reads this back off the API. This checks the
    // committed source, which is the half a diff can catch.
    expect(ENV_CODE).toMatch(/allow_mcp_servers:\s*true/);
  });

  it("uses config type `cloud`, the variant that exists", () => {
    // SPEC correction: the `anthropic_cloud` variant referenced by the blueprint
    // does not exist.
    expect(ENV_CODE).toMatch(/type:\s*cloud/);
    expect(ENV_CODE).not.toMatch(/anthropic_cloud/);
  });

  it("leaves package managers off", () => {
    expect(ENV_CODE).toMatch(/allow_package_managers:\s*false/);
  });
});
