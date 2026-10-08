#!/usr/bin/env bash
# Self-test for scripts/ios-real-api-smoke.sh's lifecycle (up / down / all). Needs NO Docker and starts NO real
# stack: `docker`, `node`, `npm` and `curl` are stubs on PATH, and everything happens inside a temp directory
# (a fake repo, a fake HOME, a fake TMPDIR), so even a script that goes wrong can only delete things in there.
#
# It proves the script only ever removes what it recorded itself creating:
#   a) an existing container with the script's name is NOT removed when `up` / `all` refuses to start;
#   b) `down` with no state record removes nothing;
#   c) a state dir that is `.`, relative, the repo, $HOME, or a directory without the script's marker is never
#      deleted;
#   d) a normal up / down removes exactly the recorded container (by id), its API process and its state dir,
#      and leaves a bystander container alone; a failed `up` cleans up what it had created;
#   e) `down` does not kill a process that merely has the recorded PID.
#
# Usage: ./scripts/test-ios-real-api-smoke.sh [path-to-script-under-test]   (default: the sibling script)
# Bash 3.2 compatible (macOS).
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="${1:-$here/ios-real-api-smoke.sh}"
[[ -f "$SCRIPT_UNDER_TEST" ]] || { echo "no such script: $SCRIPT_UNDER_TEST" >&2; exit 2; }
SCRIPT_UNDER_TEST="$(cd "$(dirname "$SCRIPT_UNDER_TEST")" && pwd)/$(basename "$SCRIPT_UNDER_TEST")"

tmp_base="${TMPDIR:-/tmp}"; tmp_base="${tmp_base%/}"
T="$(mktemp -d "$tmp_base/kobolink-x2-selftest.XXXXXX")"
case "$T" in /*/*) ;; *) echo "refusing odd temp dir: $T" >&2; exit 2;; esac
FAILED=0
LEFTOVER_PIDS=""
cleanup() {
  local p
  for p in $LEFTOVER_PIDS; do { kill "$p"; } 2>/dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT

ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; FAILED=1; }
check() { # check DESCRIPTION CONDITION-COMMAND...
  local what="$1"; shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}

# ---- the stubs ---------------------------------------------------------------------------------
STUB_BIN="$T/bin"; STUB_DIR="$T/stub"
mkdir -p "$STUB_BIN" "$STUB_DIR/containers"

cat > "$STUB_BIN/docker" <<'EOF'
#!/bin/bash
# A stand-in for docker: a directory of "containers" (file name = id, content = name) and a call log.
echo "$*" >> "$STUB_DIR/docker.log"
reg="$STUB_DIR/containers"
find_id() {
  local f id
  for f in "$reg"/*; do
    [ -e "$f" ] || continue
    id="$(basename "$f")"
    if [ "$id" = "$1" ] || [ "$(cat "$f")" = "$1" ]; then echo "$id"; return 0; fi
  done
  return 1
}
case "$1" in
  info|image|exec) exit 0 ;;
  container)
    shift
    [ "$1" = inspect ] || exit 1
    shift
    fmt=""
    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi
    id="$(find_id "$1")" || exit 1
    [ -n "$fmt" ] && echo "/$(cat "$reg/$id")"
    exit 0 ;;
  run)
    name=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "--name" ] && name="$a"
      prev="$a"
    done
    if find_id "$name" >/dev/null; then echo "Conflict. The container name is already in use" >&2; exit 125; fi
    id="$(openssl rand -hex 32)"
    echo "$name" > "$reg/$id"
    echo "$id"
    exit 0 ;;
  rm)
    shift
    for a in "$@"; do
      case "$a" in -*) ;; *) id="$(find_id "$a")" && rm -f "$reg/$id" ;; esac
    done
    exit 0 ;;
esac
exit 0
EOF
cat > "$STUB_BIN/node" <<'EOF'
#!/bin/bash
case "$*" in
  *migrate.js*) [ -n "${STUB_FAIL_MIGRATE:-}" ] && exit 1; exit 0 ;;
  *main.js*) exec -a "node dist/main.js" sleep 600 ;;
esac
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$STUB_BIN/npm"
printf '#!/bin/bash\nexit 0\n' > "$STUB_BIN/curl"
chmod +x "$STUB_BIN"/*

# ---- one fresh sandbox per case ----------------------------------------------------------------
new_sandbox() {
  rm -rf "$T/repo" "$T/home" "$T/tmp" "$T/foreign" "$STUB_DIR/containers" "$STUB_DIR/docker.log"
  mkdir -p "$T/repo/scripts" "$T/repo/node_modules" "$T/repo/apps/api/dist" "$T/repo/packages/contracts" \
    "$T/home" "$T/tmp" "$STUB_DIR/containers"
  : > "$STUB_DIR/docker.log"
  cp "$SCRIPT_UNDER_TEST" "$T/repo/scripts/ios-real-api-smoke.sh"
  chmod +x "$T/repo/scripts/ios-real-api-smoke.sh"
  echo "keep me" > "$T/repo/CANARY"
  STATE_DEFAULT="$T/tmp/kobolink-x2-state"
}

# run_script ARGS...   (in the fake repo, with the stubs first on PATH and a fake HOME / TMPDIR)
run_script() {
  ( cd "$T/repo" && env PATH="$STUB_BIN:$PATH" HOME="$T/home" TMPDIR="$T/tmp" STUB_DIR="$STUB_DIR" \
      KOBOLINK_X2_SKIP_BUILD=1 ${EXTRA_ENV:-} ./scripts/ios-real-api-smoke.sh "$@" ) > "$T/out.txt" 2>&1
}

add_container() { # add_container NAME ID
  echo "$1" > "$STUB_DIR/containers/$2"
}
container_exists() { [[ -e "$STUB_DIR/containers/$1" ]]; }
rm_calls() { grep -c '^rm ' "$STUB_DIR/docker.log"; }
state_get() { grep "^$1=" "$STATE_DEFAULT/stack.env" 2>/dev/null | head -1 | cut -d= -f2-; }
BYSTANDER_ID="$(printf 'b%.0s' $(seq 1 64))"
OTHER_ID="$(printf 'a%.0s' $(seq 1 64))"

echo "# (a) an existing container with the script's name is not removed when the script refuses"
for mode in up all; do
  new_sandbox
  add_container kobolink-x2-pg "$BYSTANDER_ID"
  run_script "$mode"; rc=$?
  check "$mode refuses (non-zero exit)" test "$rc" -ne 0
  check "$mode left the existing container alone" container_exists "$BYSTANDER_ID"
  check "$mode never called 'docker rm'" test "$(rm_calls)" -eq 0
  check "$mode left no state dir behind" test ! -e "$STATE_DEFAULT"
done

echo "# (b) down with no state record removes nothing"
new_sandbox
add_container kobolink-x2-pg "$BYSTANDER_ID"
run_script down
check "down did not remove the same-named container" container_exists "$BYSTANDER_ID"
check "down never called 'docker rm'" test "$(rm_calls)" -eq 0

echo "# (c) a state dir that is not the script's own is never deleted"
for case_name in dot relative repo home foreign; do
  new_sandbox
  case "$case_name" in
    dot) dir="." ;;
    relative) dir="state-here" ;;
    repo) dir="$T/repo" ;;
    home) dir="$T/home" ;;
    foreign) dir="$T/foreign"; mkdir -p "$dir"; echo "not yours" > "$dir/keep.txt" ;;
  esac
  [[ "$case_name" == home ]] && echo "mine" > "$T/home/keep.txt"
  EXTRA_ENV="KOBOLINK_X2_STATE_DIR=$dir" run_script up; rc_up=$?
  EXTRA_ENV="KOBOLINK_X2_STATE_DIR=$dir" run_script down; rc_down=$?
  check "[$case_name] the repo (canary) survived up + down" test -f "$T/repo/CANARY" -a -f "$T/repo/scripts/ios-real-api-smoke.sh"
  [[ "$case_name" == foreign ]] && check "[foreign] the foreign directory and its file survived" test -f "$T/foreign/keep.txt"
  [[ "$case_name" == home ]] && check "[home] the home directory survived" test -f "$T/home/keep.txt"
  check "[$case_name] up refused" test "$rc_up" -ne 0
  # Whatever `up` did, no container may be left running in the sandbox either.
  check "[$case_name] no container left behind" test -z "$(ls "$STUB_DIR/containers")"
  pid="$(cd "$T/repo" && grep '^API_PID=' "$dir/stack.env" 2>/dev/null | cut -d= -f2)"
  [[ -n "${pid:-}" ]] && LEFTOVER_PIDS="$LEFTOVER_PIDS $pid"
done

echo "# (d) a normal up / down removes exactly the recorded container, its API and its state dir"
new_sandbox
add_container other-service "$OTHER_ID"
run_script up; rc=$?
[[ "$rc" -eq 0 ]] || sed 's/^/    | /' "$T/out.txt"
check "up succeeds" test "$rc" -eq 0
cid="$(state_get CONTAINER_ID)"
pid="$(state_get API_PID)"
LEFTOVER_PIDS="$LEFTOVER_PIDS $pid"
check "the container id is recorded" test -n "$cid"
check "the recorded container exists" container_exists "$cid"
check "the API process is running" kill -0 "$pid"
run_script down; rc=$?
check "down succeeds" test "$rc" -eq 0
check "the recorded container is gone" test ! -e "$STUB_DIR/containers/$cid"
check "the bystander container is untouched" container_exists "$OTHER_ID"
check "exactly one 'docker rm', by the recorded id" test "$(rm_calls)" -eq 1 -a "$(grep -c "^rm -f -v $cid\$" "$STUB_DIR/docker.log")" -eq 1
check "the API process was stopped" test ! "$(kill -0 "$pid" 2>/dev/null && echo alive)"
check "the state dir is gone" test ! -e "$STATE_DEFAULT"
check "the repo is untouched" test -f "$T/repo/CANARY"

echo "# (d2) a failed up cleans up what it created, and only that"
new_sandbox
add_container other-service "$OTHER_ID"
EXTRA_ENV="STUB_FAIL_MIGRATE=1" run_script up; rc=$?
check "up fails" test "$rc" -ne 0
check "the container it created is gone" test "$(ls "$STUB_DIR/containers" | wc -l | tr -d ' ')" -eq 1
check "the bystander is untouched" container_exists "$OTHER_ID"
check "the state dir is gone" test ! -e "$STATE_DEFAULT"

echo "# (e) down does not kill a process that only has the recorded PID"
new_sandbox
run_script up
pid="$(state_get API_PID)"
LEFTOVER_PIDS="$LEFTOVER_PIDS $pid"
sed -i.bak 's/^API_START=.*/API_START=Thu Jan  1 00:00:00 1970/' "$STATE_DEFAULT/stack.env" && rm -f "$STATE_DEFAULT/stack.env.bak"
run_script down
check "a process whose start time differs from the record is left running" kill -0 "$pid"
kill "$pid" 2>/dev/null

echo
if [[ "$FAILED" == 0 ]]; then echo "all lifecycle self-tests passed ($SCRIPT_UNDER_TEST)"; else echo "SELF-TEST FAILED ($SCRIPT_UNDER_TEST)"; exit 1; fi
