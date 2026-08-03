/**
 * Data-plane provisioning — the four steps SPEC § Provisioning split lists as
 * "what the CLI path does not cover", each guarded by an existence check so
 * re-running is safe.
 *
 * Two run in Phase 2 because their inputs exist; two are written and skip with
 * a logged reason because theirs do not:
 *
 *   2. vault + static_bearer credential  RUNS   — needs MCP_SERVER_TOKEN
 *   3. memory store                      RUNS   — needs a description string
 *   1. custom skill                      skips  — needs agent/skills/triage/SKILL.md (Phase 4)
 *   4. rubric file upload                skips  — needs agent/rubric.md (Phase 6)
 *
 * The control plane (agent, environment) is NOT here — it is committed YAML
 * applied by scripts/apply-control-plane.sh through the `ant` CLI.
 *
 *   usage:  pnpm deploy
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ENV_PATH, REPO_ROOT, env } from "./config.js";
import { upsertEnvFile } from "./env-file.js";

const SKILL_DIR = resolve(REPO_ROOT, "agent/skills/triage");
const SKILL_MD = resolve(SKILL_DIR, "SKILL.md");
const RUBRIC_MD = resolve(REPO_ROOT, "agent/rubric.md");

const produced: Record<string, string> = {};

const ok = (s: string) => console.log(`  ✓ ${s}`);
const skip = (step: string, why: string) => {
  console.log(`  – ${step}`);
  console.log(`      skipped: ${why}`);
};

async function main(): Promise<void> {
  const client = new Anthropic();
  console.log("── deploy ".padEnd(56, "─"));

  // -------------------------------------------------------------------------
  // 1. Custom skill — Phase 4.
  // -------------------------------------------------------------------------
  if (env.TRIAGE_SKILL_ID) {
    ok(`skill        ${env.TRIAGE_SKILL_ID} (already provisioned)`);
  } else if (!existsSync(SKILL_MD)) {
    skip(
      "skill",
      `agent/skills/triage/SKILL.md does not exist yet. Phase 4 writes the ` +
        `decision procedure, packages this directory, POSTs /v1/skills, then ` +
        `pins version "1" on the agent.`,
    );
  } else {
    // Phase 4 fills this in: package SKILL_DIR, create the skill and a version,
    // capture skill_id. Pinned rather than "latest" so a session is reproducible.
    throw new Error(
      `${SKILL_MD} exists but skill provisioning is not implemented yet (Phase 4).`,
    );
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
    produced["VAULT_ID"] = vault.id;
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
    produced["MEMORY_STORE_ID"] = store.id;
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
  if (Object.keys(produced).length > 0) {
    upsertEnvFile(produced, ENV_PATH);
    for (const [k, v] of Object.entries(produced)) {
      console.log(`  .env.local  set     ${k}=${v}`);
    }
  } else {
    console.log("\n  nothing to write — all provisioned resources already recorded");
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
