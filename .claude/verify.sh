#!/usr/bin/env bash
#
# Stop hook gate.
#
# SPEC § Files: ".claude/verify.sh — Stop hook gate. Runs `pnpm -s test` only."
# SPEC § Verification: that suite is "Fully offline, zero spend, no network."
#
# It runs `pnpm -s test` and nothing else. Not typecheck, not lint, not a live
# call — the gate fires on every turn, so anything that touches the network or
# the API would bill the build for the act of writing about it, and SPEC
# § Cost controls' billing boundary says the Max subscription pays for Claude
# Code while API credits pay for the thing being built.
#
# Registered in ~/.claude/settings.json as a Stop hook:
#   if [ -x "${CLAUDE_PROJECT_DIR}/.claude/verify.sh" ]; then
#     exec "${CLAUDE_PROJECT_DIR}/.claude/verify.sh"
#   fi
#
# Exit codes are the hook contract, not a convention:
#   0  the turn may end
#   2  BLOCK the turn; everything on stderr is fed back so the failure can be
#      read and fixed rather than merely reported
#
# Until Phase 7 this suite could not run from a clean clone — `src/config.ts`
# validated the environment at module scope and `tests/env-file.test.ts` reached
# it through an import, so a missing `.env.local` failed the gate for a reason
# unrelated to the code under test. That is docs/DECISIONS.md D-028, and it is
# closed: `src/paths.ts` holds the path constants and imports nothing.

set -uo pipefail

cd "$(dirname "$0")/.." || {
  echo "verify.sh: cannot reach the repo root from $0" >&2
  exit 2
}

output="$(pnpm -s test 2>&1)"
rc=$?

if [ "$rc" -ne 0 ]; then
  {
    echo "BLOCKED by .claude/verify.sh — \`pnpm -s test\` exited $rc."
    echo "SPEC § Repo discipline: the Stop hook blocks a dirty turn."
    echo
    echo "$output"
  } >&2
  exit 2
fi

exit 0
