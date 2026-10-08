#!/usr/bin/env bash
# Self-test for scripts/ios-real-api-smoke.sh's lifecycle (up / down / all / check's guard). Needs NO Docker and
# starts NO real stack: `docker`, `node`, `npm` and `curl` are stubs on PATH, and everything happens inside a temp
# directory (a fake repo, a fake HOME, a fake TMPDIR), so even a script that goes wrong can only delete things in there.
#
# It proves the script only ever removes what it recorded creating, and only ever creates where it may:
#   a) an existing container with the script's name is NOT removed when `up` / `all` refuses to start;
#   b) `down` with no state record removes nothing;
#   c) a state dir that is `.`, relative, the repo, $HOME, or a directory without the script's marker is never
#      deleted or written into;
#   c2) a state path reached through a symlink (the last component with a trailing slash, a dangling one, or a
#      symlinked PARENT that leads into the repo) is refused, and nothing is created or deleted through it;
#   d) a normal up / down removes exactly the recorded container (by id, after checking its name and run label), its
#      API process and its state dir, and leaves a bystander container alone; a failed `up` cleans up what it created,
#      including a container that was created but could not start;
#   e) `down` does not kill a process that merely has the recorded PID, and does not remove a container whose label
#      differs from the recorded run token; it says what it did not do;
#   f) `up` refuses a busy API port, does not accept a server that is not its own process, and `check` refuses before
#      registering anyone on a server that is not the recorded process;
#   g) no TMPDIR and no KOBOLINK_X2_STATE_DIR: refuses rather than falling back to a shared /tmp.
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
LISTENER_PID=""

# Stop only the processes the stubs recorded (pid|start time), and only if that pid still has that start time.
cleanup() {
  local line pid start now
  if [[ -f "$STUB_DIR/pids" ]]; then
    while IFS='|' read -r pid start; do
      [[ -n "$pid" ]] || continue
      now="$(ps -p "$pid" -o lstart= 2>/dev/null || true)"
      if [[ -n "$now" && "$now" == "$start" ]]; then { kill "$pid"; } 2>/dev/null; fi
    done < "$STUB_DIR/pids"
  fi
  if [[ -n "$LISTENER_PID" ]]; then { kill "$LISTENER_PID"; } 2>/dev/null; fi
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
mkdir -p "$STUB_BIN" "$STUB_DIR/containers" "$STUB_DIR/labels"

cat > "$STUB_BIN/docker" <<'EOF'
#!/bin/bash
# A stand-in for docker: a directory of "containers" (file name = id, content = name), their labels, and a call log.
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
make_container() { # make_container ARGS... : --name N and any --label K=V
  local name="" label="" prev="" a
  for a in "$@"; do
    [ "$prev" = "--name" ] && name="$a"
    [ "$prev" = "--label" ] && label="${a#*=}"
    prev="$a"
  done
  if find_id "$name" >/dev/null; then echo "Conflict. The container name is already in use" >&2; return 125; fi
  local id; id="$(openssl rand -hex 32)"
  echo "$name" > "$reg/$id"
  echo "$label" > "$STUB_DIR/labels/$id"
  echo "$id"
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
    case "$fmt" in
      "") ;;
      *Labels*) cat "$STUB_DIR/labels/$id" ;;
      *) echo "/$(cat "$reg/$id")" ;;
    esac
    exit 0 ;;
  create|run) shift; make_container "$@"; exit $? ;;
  start) [ -n "${STUB_FAIL_START:-}" ] && { echo "port is already allocated" >&2; exit 1; }; exit 0 ;;
  rm)
    shift
    for a in "$@"; do
      case "$a" in -*) ;; *) id="$(find_id "$a")" && rm -f "$reg/$id" "$STUB_DIR/labels/$id" ;; esac
    done
    exit 0 ;;
esac
exit 0
EOF
cat > "$STUB_BIN/node" <<'EOF'
#!/bin/bash
# `node dist/db/migrate.js` and `node dist/main.js`. The "API" really listens on $PORT (so the script's listener
# check is exercised) and logs the line Nest logs; its argv0 is "node dist/main.js" like the real command line.
case "$*" in
  *migrate.js*) [ -n "${STUB_FAIL_MIGRATE:-}" ] && exit 1; exit 0 ;;
  *main.js*)
    echo "$$|$(ps -p $$ -o lstart= 2>/dev/null)" >> "$STUB_DIR/pids"
    [ -n "${STUB_NODE_CRASH:-}" ] && { echo "Error: listen EADDRINUSE: address already in use :::$PORT" >&2; exit 1; }
    exec -a "node dist/main.js" python3 -c 'import os,socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(os.environ["PORT"]))); s.listen(1)
print("[Bootstrap] listening on port " + os.environ["PORT"]); sys.stdout.flush()
time.sleep(600)' ;;
esac
exit 0
EOF
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
echo "$*" >> "$STUB_DIR/curl.log"
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$STUB_BIN/npm"
chmod +x "$STUB_BIN"/*

# ---- one fresh sandbox per case ----------------------------------------------------------------
new_sandbox() {
  rm -rf "$T/repo" "$T/home" "$T/tmp" "$T/foreign" "$T/outside" "$STUB_DIR/containers" "$STUB_DIR/labels" "$STUB_DIR/docker.log" "$STUB_DIR/curl.log"
  mkdir -p "$T/repo/scripts" "$T/repo/node_modules" "$T/repo/apps/api/dist" "$T/repo/packages/contracts" \
    "$T/home" "$T/tmp" "$STUB_DIR/containers" "$STUB_DIR/labels"
  : > "$STUB_DIR/docker.log"; : > "$STUB_DIR/curl.log"
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
run_script_without_tmpdir() {
  ( cd "$T/repo" && env -u TMPDIR -u KOBOLINK_X2_STATE_DIR PATH="$STUB_BIN:$PATH" HOME="$T/home" STUB_DIR="$STUB_DIR" \
      KOBOLINK_X2_SKIP_BUILD=1 ./scripts/ios-real-api-smoke.sh "$@" ) > "$T/out.txt" 2>&1
}

add_container() { # add_container NAME ID
  echo "$1" > "$STUB_DIR/containers/$2"
  echo "" > "$STUB_DIR/labels/$2"
}
container_exists() { [[ -e "$STUB_DIR/containers/$1" ]]; }
rm_calls() { grep -c '^rm ' "$STUB_DIR/docker.log"; }
created_containers() { ls "$STUB_DIR/containers" | wc -l | tr -d ' '; }
# state_get KEY (from the default state dir, wherever it physically is)
state_get() { grep "^$1=" "$STATE_DEFAULT/stack.env" 2>/dev/null | head -1 | cut -d= -f2-; }
BYSTANDER_ID="$(printf 'b%.0s' $(seq 1 64))"
OTHER_ID="$(printf 'a%.0s' $(seq 1 64))"
output_mentions() { grep -q "$1" "$T/out.txt"; }

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

echo "# (c) a state dir that is not the script's own is never deleted or written into"
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
  check "[$case_name] no container left behind" test "$(created_containers)" -eq 0
done

echo "# (c2) a state path reached through a symlink is refused: nothing is created or deleted through it"
for case_name in trailing-slash dangling-trailing-slash symlinked-parent; do
  new_sandbox
  mkdir -p "$T/outside"
  echo "outside, not ours" > "$T/outside/keep.txt"
  case "$case_name" in
    # A dangling link INTO the repo: `mkdir lnk/` would create repo/inside, and `rm -rf lnk/` would delete it.
    trailing-slash) ln -s "$T/repo/inside" "$T/tmp/lnk"; dir="$T/tmp/lnk/" ;;
    dangling-trailing-slash) ln -s "$T/outside/not-there-yet" "$T/tmp/lnk"; dir="$T/tmp/lnk/" ;;
    symlinked-parent) ln -s "$T/repo" "$T/tmp/lnk"; dir="$T/tmp/lnk/newdir" ;;
  esac
  EXTRA_ENV="KOBOLINK_X2_STATE_DIR=$dir" run_script up; rc_up=$?
  created_in_repo=0; [[ -e "$T/repo/inside" || -e "$T/repo/newdir" ]] && created_in_repo=1
  EXTRA_ENV="KOBOLINK_X2_STATE_DIR=$dir" run_script down
  check "[$case_name] up refused" test "$rc_up" -ne 0
  check "[$case_name] up created nothing in the repo through the link" test "$created_in_repo" -eq 0
  check "[$case_name] nothing was deleted through the link" test -f "$T/outside/keep.txt" -a -f "$T/repo/CANARY"
  check "[$case_name] the dangling target was not created" test ! -e "$T/outside/not-there-yet"
  check "[$case_name] the symlink itself is still there" test -L "$T/tmp/lnk"
  check "[$case_name] no container left behind" test "$(created_containers)" -eq 0
done

echo "# (d) a normal up / down removes exactly the recorded container, its API and its state dir"
new_sandbox
add_container other-service "$OTHER_ID"
run_script up; rc=$?
[[ "$rc" -eq 0 ]] || sed 's/^/    | /' "$T/out.txt"
check "up succeeds" test "$rc" -eq 0
cid="$(state_get CONTAINER_ID)"
pid="$(state_get API_PID)"
check "the container id is recorded" test -n "$cid"
check "a run token is recorded and is the container's label" test -n "$(state_get RUN_TOKEN)" -a "$(cat "$STUB_DIR/labels/$cid" 2>/dev/null)" = "$(state_get RUN_TOKEN)"
check "the recorded container exists" container_exists "$cid"
check "the API process is running" kill -0 "$pid"
check "the state dir is owner-only" test "$(ls -ld "$STATE_DEFAULT" | cut -c1-10)" = "drwx------"
run_script down; rc=$?
check "down succeeds" test "$rc" -eq 0
check "down says it removed the container, stopped the API and removed the state dir" bash -c "grep -q 'removed container' '$T/out.txt' && grep -q 'stopped the API' '$T/out.txt' && grep -q 'removed the state dir' '$T/out.txt'"
check "the recorded container is gone" test ! -e "$STUB_DIR/containers/$cid"
check "the bystander container is untouched" container_exists "$OTHER_ID"
check "exactly one 'docker rm', by the recorded id" test "$(rm_calls)" -eq 1 -a "$(grep -c "^rm -f -v $cid\$" "$STUB_DIR/docker.log")" -eq 1
check "the API process was stopped" test ! "$(kill -0 "$pid" 2>/dev/null && echo alive)"
check "the state dir is gone" test ! -e "$STATE_DEFAULT"
check "the repo is untouched" test -f "$T/repo/CANARY"

echo "# (d2) a failed up cleans up what it created, and only that"
for failure in STUB_FAIL_MIGRATE STUB_FAIL_START STUB_NODE_CRASH; do
  new_sandbox
  add_container other-service "$OTHER_ID"
  EXTRA_ENV="$failure=1" run_script up; rc=$?
  check "[$failure] up fails" test "$rc" -ne 0
  check "[$failure] the container it created is gone" test "$(created_containers)" -eq 1
  check "[$failure] the bystander is untouched" container_exists "$OTHER_ID"
  check "[$failure] the state dir is gone" test ! -e "$STATE_DEFAULT"
done

echo "# (e) down is exact about what it does and does not do"
new_sandbox
run_script up
pid="$(state_get API_PID)"; cid="$(state_get CONTAINER_ID)"
sed -i.bak 's/^API_START=.*/API_START=Thu Jan  1 00:00:00 1970/' "$STATE_DEFAULT/stack.env" && rm -f "$STATE_DEFAULT/stack.env.bak"
sed -i.bak 's/^RUN_TOKEN=.*/RUN_TOKEN=someone-elses-token/' "$STATE_DEFAULT/stack.env" && rm -f "$STATE_DEFAULT/stack.env.bak"
run_script down
check "a process whose start time differs from the record is left running" kill -0 "$pid"
check "a container whose label differs from the recorded run token is left alone" container_exists "$cid"
check "down says it did not kill the process" output_mentions "not killing pid"
check "down says it did not remove the container" output_mentions "not removing container"
check "down does not claim it removed the container or stopped the API" bash -c "! grep -q 'removed container' '$T/out.txt' && ! grep -q 'stopped the API' '$T/out.txt'"

echo "# (f) a server that is not the script's own process is not accepted, and nobody is registered on it"
new_sandbox
python3 -c 'import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 0)); print(s.getsockname()[1], flush=True); s.listen(1); time.sleep(120)' > "$T/busy-port.txt" &
LISTENER_PID=$!
disown "$LISTENER_PID" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -s "$T/busy-port.txt" ]] && break; sleep 0.3; done
busy="$(cat "$T/busy-port.txt")"
EXTRA_ENV="KOBOLINK_X2_API_PORT=$busy" run_script up; rc=$?
check "up refuses a busy API port" test "$rc" -ne 0
check "up created nothing for it" test "$(created_containers)" -eq 0 -a ! -e "$STATE_DEFAULT"
check "up never asked the foreign server anything" test ! -s "$STUB_DIR/curl.log"
new_sandbox
run_script up
sed -i.bak 's/^API_START=.*/API_START=Thu Jan  1 00:00:00 1970/' "$STATE_DEFAULT/stack.env" && rm -f "$STATE_DEFAULT/stack.env.bak"
: > "$STUB_DIR/curl.log"
run_script check; rc=$?
check "check refuses when the recorded process is not the running one" test "$rc" -ne 0
check "check made no request (so it registered nobody)" test ! -s "$STUB_DIR/curl.log"

echo "# (g) no TMPDIR and no state dir given: refuse, do not fall back to a shared /tmp"
new_sandbox
run_script_without_tmpdir up; rc=$?
check "up refuses" test "$rc" -ne 0
check "up created nothing" test "$(created_containers)" -eq 0

echo
if [[ "$FAILED" == 0 ]]; then echo "all lifecycle self-tests passed ($SCRIPT_UNDER_TEST)"; else echo "SELF-TEST FAILED ($SCRIPT_UNDER_TEST)"; exit 1; fi
