/**
 * Data-plane provisioning — the four steps SPEC § Provisioning split lists as
 * "what the CLI path does not cover", each guarded by an existence check so
 * re-running is safe.
 *
 * Three run; one is written and skips with a logged reason because its input
 * does not exist yet:
 *
 *   1. custom skill                      RUNS   — Phase 4, needs agent/skills/triage/SKILL.md
 *   2. vault + static_bearer credential  RUNS   — needs MCP_SERVER_TOKEN
 *   3. memory store                      RUNS   — needs a description string
 *   4. rubric file upload                skips  — needs agent/rubric.md (Phase 6)
 *
 * The control plane (agent, environment) is NOT here — it is committed YAML
 * applied by scripts/apply-control-plane.sh through the `ant` CLI.
 *
 *   usage:  pnpm provision
 */

import Anthropic, { toFile, type Uploadable } from "@anthropic-ai/sdk";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ENV_PATH, REPO_ROOT, env } from "./config.js";
import { upsertEnvFile } from "./env-file.js";

/** Skills are immutable; an edited SKILL.md needs a new version, explicitly. */
const newSkillVersion = parseArgs({
  options: { "new-skill-version": { type: "boolean", default: false } },
}).values["new-skill-version"];

const SKILL_DIR = resolve(REPO_ROOT, "agent/skills/triage");
const SKILL_MD = resolve(SKILL_DIR, "SKILL.md");
const RUBRIC_MD = resolve(REPO_ROOT, "agent/rubric.md");

const produced: Record<string, string> = {};

const ok = (s: string) => console.log(`  ✓ ${s}`);
const skip = (step: string, why: string) => {
  console.log(`  – ${step}`);
  console.log(`      skipped: ${why}`);
};

/**
 * Write an id to `.env.local` the moment the API returns it, not in a batch at
 * the end.
 *
 * An earlier draft collected everything in `produced` and wrote once after all
 * four steps. Any throw between a create call and that write orphaned the
 * resource: it existed on the server, the repo had no record of it, and the
 * next run's existence check took the create branch again and minted a second
 * one. That is precisely the non-idempotency docs/DECISIONS.md D-016 exists to
 * prevent, reproduced one layer down. `upsertEnvFile` is already the single
 * shared writer and is covered by tests/env-file.test.ts, so calling it per
 * resource costs nothing.
 */
/**
 * Package `agent/skills/triage/` for upload.
 *
 * skills.md:22 — "A custom skill is a directory containing a SKILL.md file plus
 * any supporting files, uploaded to your workspace as a zip archive or as
 * individual files." skills.md:191 — bundles go straight to the Skills API, NOT
 * through the Files API.
 *
 * Individual files rather than a zip: Node ships no zip writer, and shelling out
 * to `zip` would add an undeclared toolchain dependency to a step that has to
 * work from a clean clone. The SDK's TypeScript sample shows the zip form, but
 * `files: Array<Uploadable>` documents the constraint that decides the naming —
 * "All files must be in the same top-level directory and must include a SKILL.md
 * file at the root of that directory".
 *
 * THE FOLDER NAME MUST EQUAL THE `name` IN SKILL.md's FRONTMATTER. Measured, not
 * documented: uploading under `triage/` returned 400 "The folder name 'triage'
 * must match the skill name 'triaging-support-tickets' in SKILL.md." That
 * constraint appears in none of the eighteen pages in docs/reference/. The repo
 * directory stays `agent/skills/triage/` as SPEC § Files specifies; the upload
 * folder is DERIVED from the frontmatter so the two cannot drift into that 400.
 *
 * Dotfiles are excluded: `.gitkeep` held this directory in git before Phase 4
 * filled it, and skill-authoring-best-practices.md's security guidance is to
 * "review all files bundled in the Skill". A bundle carries only what the model
 * is meant to read.
 */
async function bundle(): Promise<{ files: Uploadable[]; names: string[] }> {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(SKILL_MD, "utf8"));
  const skillName = frontmatter?.[1]?.match(/^name:[ \t]*(\S+)/m)?.[1];
  if (!skillName) throw new Error(`${SKILL_MD} has no \`name\` in its YAML frontmatter.`);

  const names = readdirSync(SKILL_DIR)
    .filter((n) => !n.startsWith("."))
    .sort();
  const files = await Promise.all(
    names.map(async (name) =>
      toFile(readFileSync(resolve(SKILL_DIR, name)), `${skillName}/${name}`),
    ),
  );
  return { files, names };
}

const record = (key: string, value: string): void => {
  produced[key] = value;
  upsertEnvFile({ [key]: value }, ENV_PATH);
  console.log(`  .env.local  set     ${key}=${value}`);
};

async function main(): Promise<void> {
  const client = new Anthropic();
  console.log("── deploy ".padEnd(56, "─"));

  // -------------------------------------------------------------------------
  // 1. Custom skill — Phase 4.
  // -------------------------------------------------------------------------
  if (env.TRIAGE_SKILL_ID && !newSkillVersion) {
    ok(`skill        ${env.TRIAGE_SKILL_ID} (already provisioned)`);
    console.log(
      `      pinned at version ${env.TRIAGE_SKILL_VERSION ?? "(unrecorded)"}. ` +
        `Edited SKILL.md? re-run with --new-skill-version`,
    );
  } else if (env.TRIAGE_SKILL_ID) {
    // Skills are immutable once uploaded, so an edited SKILL.md needs a new
    // VERSION rather than an update in place. Explicit rather than automatic:
    // provisioning is safe to re-run precisely because it does not mint
    // resources on its own initiative, and a version created on every run would
    // be the same accumulate-silently failure D-016 records for agents.
    const { files, names } = await bundle();
    const version = await client.beta.skills.versions.create(env.TRIAGE_SKILL_ID, { files });
    ok(`skill        ${env.TRIAGE_SKILL_ID} version ${version.version}`);
    console.log(`      uploaded ${names.length} file(s): ${names.join(", ")}`);
    record("TRIAGE_SKILL_VERSION", version.version);
  } else if (!existsSync(SKILL_MD)) {
    skip(
      "skill",
      `agent/skills/triage/SKILL.md does not exist yet. Phase 4 writes the ` +
        `decision procedure, packages this directory, POSTs /v1/skills, then ` +
        `pins version "1" on the agent.`,
    );
  } else {
    const { files, names } = await bundle();
    const skill = await client.beta.skills.create({
      files,
      display_title: "Inbox triage decision procedure",
    });

    // Pinned, not `latest`, so a session is reproducible (SPEC § Provisioning
    // split). The literal is whatever create returned: custom skill versions are
    // epoch-timestamp strings, NOT "1" as SPEC § Runtime configuration states.
    // skills-guide.md:50, custom-skill column: "Epoch timestamp:
    // `1759178010641129` or `latest`". See amendment A-9.
    if (!skill.latest_version) {
      throw new Error(
        `skill ${skill.id} was created but returned latest_version: null, so ` +
          `there is no version to pin. Inspect with ` +
          `\`ant beta:skills:versions list --skill-id ${skill.id}\`.`,
      );
    }

    ok(`skill        ${skill.id}`);
    console.log(`      uploaded ${names.length} file(s): ${names.join(", ")}`);
    record("TRIAGE_SKILL_ID", skill.id);
    record("TRIAGE_SKILL_VERSION", skill.latest_version);
  }

  // -------------------------------------------------------------------------
  // 2. Vault + static_bearer credential.
  //
  // The credential never enters the sandbox. The MCP tool call leaves the
  // container, an Anthropic-side proxy fetches the token from the vault and
  // attaches it, and the request reaches Vercel authenticated. Prompt injection
  // in a ticket cannot exfiltrate a secret the sandbox never held.
  // -------------------------------------------------------------------------
  if (env.VAULT_ID) {
    const creds = await client.beta.vaults.credentials.list(env.VAULT_ID);
    const urls = creds.data
      .map((c) =>
        c.auth.type === "static_bearer" ? c.auth.mcp_server_url : undefined,
      )
      .filter((u): u is string => u !== undefined);
    ok(`vault        ${env.VAULT_ID} (already provisioned)`);
    console.log(
      `      credentials: ${urls.length > 0 ? urls.join(", ") : "(none matching static_bearer)"}`,
    );
  } else {
    const vault = await client.beta.vaults.create({
      display_name: "inbox-triage-mcp",
    });
    await client.beta.vaults.credentials.create(vault.id, {
      display_name: "support-records bearer",
      auth: {
        type: "static_bearer",
        token: env.MCP_SERVER_TOKEN,
        // Matched against the agent's mcp_servers[].url. Normalisation lowercases
        // scheme and host and strips default ports and trailing slashes, but a
        // differing path or subdomain does NOT match, and an unmatched
        // credential means the connection is attempted UNAUTHENTICATED rather
        // than failing loudly (mcp-connector.md:368).
        mcp_server_url: env.MCP_SERVER_URL,
      },
    });
    record("VAULT_ID", vault.id);
    ok(`vault        ${vault.id}`);
    console.log(`      static_bearer keyed to ${env.MCP_SERVER_URL}`);
  }

  // -------------------------------------------------------------------------
  // 3. Memory store. Description is written for the model, not for humans —
  //    it is injected into the agent's system prompt when the store is attached.
  // -------------------------------------------------------------------------
  if (env.MEMORY_STORE_ID) {
    const store = await client.beta.memoryStores.retrieve(env.MEMORY_STORE_ID);
    ok(`memory store ${store.id} (already provisioned)`);
  } else {
    const store = await client.beta.memoryStores.create({
      name: "inbox-triage-accounts",
      description:
        "Per-account history from previous support tickets. Before deciding a " +
        "ticket, check whether a file exists for the account and read it. After " +
        "submitting your decision, write or update that account's file with the " +
        "ticket ID, the category, the disposition, and one line of context a " +
        "future ticket would need. Never write credentials, tokens, or keys here.",
    });
    record("MEMORY_STORE_ID", store.id);
    ok(`memory store ${store.id}`);
    // memory.md: the mount path is the display name slugified, but it must be
    // READ from `mount_path` on the session's memory-store resource rather than
    // constructed — writes anywhere else under /mnt/memory/ land in
    // container-local scratch and are lost silently when the session ends.
    console.log(`      read mount_path off the session resource, never construct it`);
  }

  // -------------------------------------------------------------------------
  // 4. Rubric file — Phase 6.
  // -------------------------------------------------------------------------
  if (env.RUBRIC_FILE_ID) {
    ok(`rubric file  ${env.RUBRIC_FILE_ID} (already provisioned)`);
  } else if (!existsSync(RUBRIC_MD)) {
    skip(
      "rubric file",
      `agent/rubric.md does not exist yet. Phase 6 writes the five criteria and ` +
        `uploads once through the Files API so all ten sessions grade against a ` +
        `byte-identical document.`,
    );
  } else {
    throw new Error(
      `${RUBRIC_MD} exists but rubric upload is not implemented yet (Phase 6).`,
    );
  }

  // -------------------------------------------------------------------------
  // Each id was already persisted by `record()` as it was returned; this is a
  // summary, not the write.
  if (Object.keys(produced).length === 0) {
    console.log("\n  nothing written — all provisioned resources already recorded");
  }
  console.log("─".repeat(56));
}

main().catch((err) => {
  if (err instanceof Anthropic.APIError) {
    console.error(`\n!! deploy failed  status=${err.status} request-id=${err.requestID ?? "none"}`);
    console.error(`   ${err.message}`);
    console.error(`   raw: ${JSON.stringify(err.error ?? null, null, 2)}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
