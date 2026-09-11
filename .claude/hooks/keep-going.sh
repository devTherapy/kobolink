#!/usr/bin/env bash
# Stop hook: fires when the agent finishes a turn.
#
# If PLAN.md still has unfinished work, push back once and tell it what is left.
# Exit 2 blocks the stop. Claude Code allows at most 8 consecutive blocks, so
# this is a nudge, not the loop engine — `/goal` in RUN.md is the loop engine.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f PLAN.md ] || exit 0

# grep -c prints 0 AND exits 1 when there are no matches, so `|| echo 0` would
# append a second line and break the arithmetic below. Use `|| true`.
remaining=$(grep -cE '\| (todo|in-progress) \|' PLAN.md 2>/dev/null || true)
remaining=${remaining:-0}
[ "$remaining" -eq 0 ] 2>/dev/null && exit 0
case "$remaining" in ''|*[!0-9]*) exit 0 ;; esac

state="${CLAUDE_PROJECT_DIR:-.}/.claude/.keepgoing"
n=$(cat "$state" 2>/dev/null || echo 0)
if [ "$n" -ge 5 ]; then rm -f "$state"; exit 0; fi
echo $((n + 1)) > "$state"

ready=$(grep -E '\| todo \|' PLAN.md | sed -E 's/^\| ([A-Z][0-9]+) \| ([^|]{0,52}).*/  \1  \2/' | head -6)
cat >&2 <<MSG
PLAN.md still lists $remaining unfinished features. Do not stop.

Next up:
$ready

Continue the loop in RUN.md: pick the ready set, dispatch, review, merge, log,
repeat. If something is genuinely blocked, mark that row 'blocked' in PLAN.md
with the reason — then a stop is legitimate.
MSG
exit 2
