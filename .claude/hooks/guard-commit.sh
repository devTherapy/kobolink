#!/usr/bin/env bash
# Two things no agent should be able to do:
#   1. commit or push to main
#   2. commit while the gate is red
#
# Exit 2 denies the tool call and hands the message back to the agent.
set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | python3 -c \
  'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)"

case "$cmd" in
  *"git commit"*|*"git push"*) ;;
  *) exit 0 ;;
esac

# An empty repository has no commits and therefore no history to protect.
if ! git rev-parse HEAD >/dev/null 2>&1; then exit 0; fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Refused: you are on '$branch'. Every feature goes on its own branch — 'feat/<ID>-<slug>' — and reaches main through a reviewed PR. That audit trail is the point of the workflow." >&2
  exit 2
fi

case "$cmd" in
  *"git commit"*)
    if ! npm run --silent typecheck >/dev/null 2>&1; then
      echo "Refused: 'npm run typecheck' fails. Fix it before committing — a red commit makes the PR trail useless for bisecting." >&2
      exit 2
    fi
    if ! npm run --silent lint >/dev/null 2>&1; then
      echo "Refused: 'npm run lint' fails. Fix it before committing." >&2
      exit 2
    fi
    ;;
esac
exit 0
