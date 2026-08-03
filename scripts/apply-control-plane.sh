#!/usr/bin/env bash
#
# Apply the committed control-plane definitions.
#
# SPEC § Provisioning split: control plane through the `ant` CLI, data plane
# through the SDK. That is why agent/*.yaml are committed files applied by a
# CLI rather than arguments to agents.create() in TypeScript.
#
# This exists as a script, which SPEC § Files does not list, because
# `ant beta:agents create` is NOT idempotent — it mints a new agent on every
# invocation and silently accumulates orphans. The create-vs-update branch has
# to live somewhere reproducible from a clean clone. See docs/DECISIONS.md D-016.
#
#   usage:  bash scripts/apply-control-plane.sh
#
# Safe to re-run. First run creates and records IDs in .env.local; every run
# after that updates in place and bumps AGENT_VERSION.

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env.local"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found. Copy .env.example." >&2; exit 1; }

# Read a value out of .env.local without exporting anything. SPEC § Provisioning
# split: never `export ANTHROPIC_API_KEY` in a shell that also runs `claude` — a
# globally visible key makes Claude Code bill API credits instead of the Max
# subscription.
read_env() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true
}

# Persist through the shared writer so the "never drop a key" invariant has one
# implementation (src/env-file.ts, covered by tests/env-file.test.ts).
persist() {
  pnpm exec tsx src/env-file.ts "$@"
}

ANT_KEY="$(read_env ANTHROPIC_API_KEY)"
[ -n "$ANT_KEY" ] || { echo "error: ANTHROPIC_API_KEY is empty in $ENV_FILE" >&2; exit 1; }

# The key goes in a per-command environment rather than `--api-key`, which SPEC's
# example uses: a command-line argument is visible in `ps` to every user on the
# box. This is still not a shell export — it exists only for the `ant` process.
ant_() { ANTHROPIC_API_KEY="$ANT_KEY" command ant "$@"; }

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
ENVIRONMENT_ID="$(read_env ENVIRONMENT_ID)"

if [ -z "$ENVIRONMENT_ID" ]; then
  echo "environment: creating from agent/environment.yaml"
  ENVIRONMENT_ID="$(ant_ beta:environments create \
    --transform id --raw-output < agent/environment.yaml)"
  persist "ENVIRONMENT_ID=$ENVIRONMENT_ID"
else
  # Environments are not versioned, so there is no optimistic-concurrency check
  # to pass here. Updates affect new containers only; sessions already running
  # keep the configuration they started with (environments.md:560).
  echo "environment: updating $ENVIRONMENT_ID in place"
  ant_ beta:environments update --environment-id "$ENVIRONMENT_ID" \
    --transform id --raw-output < agent/environment.yaml > /dev/null
fi
echo "ENVIRONMENT_ID=$ENVIRONMENT_ID"

# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------
AGENT_ID="$(read_env AGENT_ID)"
AGENT_VERSION="$(read_env AGENT_VERSION)"

if [ -z "$AGENT_ID" ]; then
  echo "agent: creating from agent/agent.yaml"
  agent_json="$(ant_ beta:agents create --format json < agent/agent.yaml)"
else
  # --version is optimistic concurrency: the request fails if it does not match
  # the server's current version. That is what we want for an interactive apply
  # — a mismatch means someone changed the agent behind us.
  echo "agent: updating $AGENT_ID from version ${AGENT_VERSION:-unknown}"
  if [ -z "$AGENT_VERSION" ]; then
    echo "error: AGENT_ID is set but AGENT_VERSION is empty in $ENV_FILE." >&2
    echo "       Recover with: ant beta:agents retrieve --agent-id $AGENT_ID --transform version --raw-output" >&2
    exit 1
  fi
  agent_json="$(ant_ beta:agents update --agent-id "$AGENT_ID" \
    --version "$AGENT_VERSION" --format json < agent/agent.yaml)"
fi

AGENT_ID="$(jq -r '.id' <<< "$agent_json")"
AGENT_VERSION="$(jq -r '.version' <<< "$agent_json")"
persist "AGENT_ID=$AGENT_ID" "AGENT_VERSION=$AGENT_VERSION"

echo "AGENT_ID=$AGENT_ID"
echo "AGENT_VERSION=$AGENT_VERSION"

# Surface the field this whole phase turns on, so a regression is visible here
# rather than as a stalled session in Phase 4. See docs/DECISIONS.md D-012.
mcp_policy="$(jq -r '
  (.tools // [])
  | map(select(.type == "mcp_toolset"))
  | map(.default_config.permission_policy.type // "UNSET")
  | join(",")
' <<< "$agent_json")"
echo "mcp_toolset permission_policy: ${mcp_policy:-none}"

if [ "$mcp_policy" != "always_allow" ]; then
  echo "error: expected mcp_toolset permission_policy always_allow, got '${mcp_policy:-none}'." >&2
  echo "       Phase 4 will stall awaiting approval on every MCP call (D-012)." >&2
  exit 1
fi
