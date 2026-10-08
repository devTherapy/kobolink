#!/usr/bin/env bash
# Starts the REAL apps/api against a REAL Postgres on this machine, and runs the
# exact calls the iOS client makes (curl level) against it. Feature X2, iOS half.
#
# Why: the iOS app was built against stubs (I0-I5). Its generated models cannot
# see a header the OpenAPI document does not declare (Retry-After, Set-Cookie),
# a status code the server changed, a replay that stopped returning the stored
# body, or a rule the zod validator enforces that the spec cannot express. This
# script is the cheap, headless tripwire for those. It is OPT-IN: not part of
# `npm test`, and not wired into CI (GitHub macOS runners are a follow-up).
#
# Usage
#   ./scripts/ios-real-api-smoke.sh            up + check + down (the default)
#   ./scripts/ios-real-api-smoke.sh up         start Postgres + API, print the base URL, leave them running
#   ./scripts/ios-real-api-smoke.sh check      run the contract checks against a stack started by `up`
#   ./scripts/ios-real-api-smoke.sh down       stop and remove what `up` recorded creating
#   ./scripts/ios-real-api-smoke.sh status     is it up, and where
# The lifecycle is tested without Docker by ./scripts/test-ios-real-api-smoke.sh.
#
# Needs: docker (daemon running), node 22, npm, npm dependencies installed
# (`npm ci --ignore-scripts`), curl, jq, python3, openssl (lsof is used when present). Uses the
# postgres:17-alpine image already pulled for the e2e suite; it pulls nothing else.
#
# What it creates, and ONLY this:
#   - one container named kobolink-x2-pg (postgres:17-alpine), made with `docker create`, labelled
#     kobolink.x2=<a random run token>, its id recorded, then started; bound to 127.0.0.1 on a random free port
#   - one node process: apps/api `node dist/main.js` on a free port (never 3000/3001). apps/api reads only PORT, so
#     it listens on ALL interfaces for as long as the run lasts
#   - a state directory with the API log and a state file recording the two things above.
#
# The state directory: KOBOLINK_X2_STATE_DIR, else $TMPDIR/kobolink-x2-state; with neither set the script refuses
# (it never falls back to a shared /tmp). Repeated and trailing slashes are removed once, up front. The path must be
# absolute and dot-free, and its PARENT must exist; the parent is resolved with `cd -P`, and the resolved ("physical")
# path is what is used from then on and what is checked: it must not be `/`, $HOME or a parent of $HOME, and not the
# repository (also resolved) or anything above or inside it. The path itself must not exist, not even as a symlink
# (a dangling one included). The script creates it with mode 700, owned by you, and drops a marker file in it.
#
# What it removes, and ONLY this (`down`, the exit of `all`, or a failed `up`):
#   - the container whose full ID the state file records, only if it is still named kobolink-x2-pg AND still carries
#     the recorded run label (never one found by name),
#   - the API process whose PID the state file records, only if its start time and command still match,
#   - the state directory, only if it is a real directory (not a symlink) at the resolved path, owned by you, mode
#     700, and carries the script's own marker.
# `down` prints what it did and what it declined to do. With no state file, `down` removes nothing. If `up` finds a
# container already named kobolink-x2-pg, a state path, or a busy API port, it refuses and touches none of them.
# `check` refuses (before it registers anyone) unless the recorded PID is alive, unchanged and is the listener on
# the API port.
#
# Secrets: the database password and the test users' passwords are throwaway values generated at run time
# (`openssl rand`) for a database bound to 127.0.0.1. They are never written to a tracked file or printed, and they
# are NOT stored in the state directory. While the run lasts the database password is visible to other local users
# on the `docker create` command line (`ps`) and in `docker inspect` and the node environment, and bearer tokens and
# passwords are on `curl` command lines. Do not run it on a shared machine.
#
# The API's per-IP limiter counts every register and every login, successful or not, 20 per 15 minutes. `check`
# uses 10 of them and RealAPIIntegrationTests (mobile/ios) uses 12, so `check` followed by the Swift suite, or
# the Swift suite twice, on ONE stack fails at its setup with a 429. Use a fresh stack (`down`, `up`) for each.
#
# Env
#   KOBOLINK_X2_STATE_DIR   see above
#   KOBOLINK_X2_SKIP_BUILD  1 = reuse apps/api/dist and packages/contracts/dist as they are
#   KOBOLINK_X2_API_PORT    force the API port (default: a free random one); it must be free
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PG_NAME="kobolink-x2-pg"
IMAGE="postgres:17-alpine"
LABEL_KEY="kobolink.x2"
MARKER_TEXT="kobolink-x2 smoke state v1"

if [[ -n "${KOBOLINK_X2_STATE_DIR:-}" ]]; then
  STATE_DIR="$KOBOLINK_X2_STATE_DIR"
elif [[ -n "${TMPDIR:-}" ]]; then
  STATE_DIR="$TMPDIR/kobolink-x2-state"
else
  STATE_DIR=""
fi
# Repeated and trailing slashes, once, before anything is derived from the path (text only; no filesystem access).
STATE_DIR="$(printf '%s' "$STATE_DIR" | sed -e 's#//*#/#g' -e 's#/*$##')"
STATE="$STATE_DIR/stack.env"
MARKER="$STATE_DIR/.kobolink-x2-state"
STATE_PROBLEM=""

# Set to 1 only once this process has created something it must clean up on exit.
TEARDOWN_ON_EXIT=0
# What teardown actually did, one line each.
DONE_MSGS=""

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }
record() { DONE_MSGS="$DONE_MSGS$1"$'\n'; }

need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

# port_is_free PORT: nothing is bound to it on loopback or on all interfaces.
port_is_free() {
  python3 - "$1" <<'PY'
import socket, sys
port = int(sys.argv[1])
for host in ("127.0.0.1", "0.0.0.0"):
    s = socket.socket()
    try:
        s.bind((host, port))
    except OSError:
        sys.exit(1)
    finally:
        s.close()
PY
}

# ---------------------------------------------------------------------------
# State directory rules
# ---------------------------------------------------------------------------

state_problem() { STATE_PROBLEM="$1"; return 1; }

# init_state_paths: validate the state path and replace it with its resolved ("physical") form. Every command calls
# this first; nothing below touches STATE_DIR before it has returned 0.
init_state_paths() {
  local p="$STATE_DIR"
  [[ -n "$p" ]] || { state_problem "neither KOBOLINK_X2_STATE_DIR nor TMPDIR is set (this script never falls back to a shared /tmp)"; return 1; }
  case "$p" in /*) ;; *) state_problem "'$p' is not an absolute path"; return 1 ;; esac
  case "$p" in */./*|*/../*|*/.|*/..) state_problem "'$p' has a dot segment"; return 1 ;; esac
  local parent base physparent phys
  parent="$(dirname "$p")"; base="$(basename "$p")"
  [[ -d "$parent" ]] || { state_problem "the parent directory '$parent' does not exist"; return 1; }
  physparent="$(cd -P "$parent" 2>/dev/null && pwd -P)" || { state_problem "cannot resolve '$parent'"; return 1; }
  if [[ "$physparent" == "/" ]]; then phys="/$base"; else phys="$physparent/$base"; fi
  case "$phys" in /*/*) ;; *) state_problem "'$phys' is too close to /"; return 1 ;; esac
  if [[ -L "$phys" ]]; then state_problem "'$phys' is a symlink"; return 1; fi

  local physhome=""
  if [[ -n "${HOME:-}" && -d "$HOME" ]]; then physhome="$(cd -P "$HOME" 2>/dev/null && pwd -P || true)"; fi
  if [[ -n "$physhome" ]]; then
    if [[ "$phys" == "$physhome" || "$physhome/" == "$phys/"* ]]; then
      state_problem "'$phys' is your home directory or a parent of it"; return 1
    fi
  fi
  if [[ "$phys/" == "$root/"* || "$root/" == "$phys/"* ]]; then
    state_problem "'$phys' is the repository, inside it, or above it"; return 1
  fi

  STATE_DIR="$phys"
  STATE="$STATE_DIR/stack.env"
  MARKER="$STATE_DIR/.kobolink-x2-state"
  return 0
}

# state_dir_is_ours: a real directory at the resolved path, owned by us, mode 700, with our marker.
state_dir_is_ours() {
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || return 1
  [[ -O "$STATE_DIR" ]] || return 1
  [[ "$(ls -ld "$STATE_DIR" | cut -c1-10)" == "drwx------" ]] || return 1
  [[ "$(cd -P "$STATE_DIR" 2>/dev/null && pwd -P)" == "$STATE_DIR" ]] || return 1
  [[ "$(cat "$MARKER" 2>/dev/null || true)" == "$MARKER_TEXT" ]] || return 1
  return 0
}

remove_state_dir() {
  if [[ ! -e "$STATE_DIR" && ! -L "$STATE_DIR" ]]; then return 0; fi
  if state_dir_is_ours; then
    rm -rf -- "$STATE_DIR"
    record "removed the state dir $STATE_DIR"
  else
    record "not removing $STATE_DIR (not a plain directory of yours, mode 700, carrying this script's marker)"
  fi
}

# state_get KEY: one value from the state file, read without executing it.
state_get() {
  [[ -f "$STATE" ]] || return 0
  grep "^$1=" "$STATE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

state_set() { # state_set KEY VALUE  (append, or replace)
  local key="$1" value="$2"
  if grep -q "^$key=" "$STATE" 2>/dev/null; then
    local tmp; tmp="$(grep -v "^$key=" "$STATE" || true)"
    { [[ -n "$tmp" ]] && printf '%s\n' "$tmp"; printf '%s=%s\n' "$key" "$value"; } > "$STATE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$STATE"
  fi
}

# load_state: the values `check` needs, validated.
load_state() {
  [[ -f "$STATE" ]] || fail "no stack is up (no $STATE); run: $0 up"
  API_PORT="$(state_get API_PORT)"
  [[ "$API_PORT" =~ ^[0-9]+$ ]] || fail "$STATE has no usable API_PORT"
  BASE_URL="http://localhost:$API_PORT"
}

# api_is_ours PID START PORT: the recorded process is alive, is the one we started (start time and command), and,
# when lsof is available, is the listener on PORT. Never trusts a health check from whatever answers on the port.
api_is_ours() {
  local pid="$1" start="$2" port="$3"
  [[ "$pid" =~ ^[0-9]+$ && -n "$start" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(ps -p "$pid" -o lstart= 2>/dev/null || true)" == "$start" ]] || return 1
  [[ "$(ps -p "$pid" -o command= 2>/dev/null || true)" == *"dist/main.js"* ]] || return 1
  if command -v lsof >/dev/null 2>&1; then
    local listeners
    listeners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    case $'\n'"$listeners"$'\n' in *$'\n'"$pid"$'\n'*) ;; *) return 1 ;; esac
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Teardown: only what the state file records
# ---------------------------------------------------------------------------
teardown_recorded() {
  if [[ ! -f "$STATE" ]] || ! state_dir_is_ours; then remove_state_dir; return 0; fi

  local pid start cid token
  pid="$(state_get API_PID)"; start="$(state_get API_START)"; cid="$(state_get CONTAINER_ID)"; token="$(state_get RUN_TOKEN)"

  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    if kill -0 "$pid" 2>/dev/null; then
      # The recorded PID may have been reused: it is ours only if the start time we recorded and the command match.
      if [[ -n "$start" && "$(ps -p "$pid" -o lstart= 2>/dev/null || true)" == "$start" \
            && "$(ps -p "$pid" -o command= 2>/dev/null || true)" == *"dist/main.js"* ]]; then
        kill "$pid" 2>/dev/null || true
        local _
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
        if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
        record "stopped the API (pid $pid)"
      else
        record "not killing pid $pid (its start time or command no longer matches what was recorded)"
      fi
    else
      record "the API (pid $pid) was no longer running"
    fi
  fi

  if [[ "$cid" =~ ^[0-9a-f]{64}$ ]]; then
    if docker container inspect "$cid" >/dev/null 2>&1; then
      local name label
      name="$(docker container inspect --format '{{.Name}}' "$cid" 2>/dev/null || true)"
      label="$(docker container inspect --format '{{index .Config.Labels "kobolink.x2"}}' "$cid" 2>/dev/null || true)"
      if [[ "$name" == "/$PG_NAME" && -n "$token" && "$label" == "$token" ]]; then
        docker rm -f -v "$cid" >/dev/null
        record "removed container ${cid:0:12} ($PG_NAME)"
      else
        record "not removing container ${cid:0:12} (its name or run label does not match what was recorded)"
      fi
    else
      record "container ${cid:0:12} was already gone"
    fi
  fi
  remove_state_dir
}

on_exit() {
  rm -f "${H:-}" "${B:-}" 2>/dev/null || true
  if [[ "$TEARDOWN_ON_EXIT" == "1" ]]; then
    TEARDOWN_ON_EXIT=0
    teardown_recorded >/dev/null 2>&1 || true
  fi
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------
cmd_up() {
  need docker; need node; need npm; need curl; need jq; need python3; need openssl
  init_state_paths || fail "the state path is not acceptable: $STATE_PROBLEM"
  docker info >/dev/null 2>&1 || fail "the docker daemon is not running"

  # Every refusal happens BEFORE anything is created, and with TEARDOWN_ON_EXIT still 0, so a refusal removes nothing.
  if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
    fail "$STATE_DIR already exists (a stack from an earlier 'up', or something else); run '$0 down' for a stack this script started, or choose another KOBOLINK_X2_STATE_DIR. Nothing was touched."
  fi
  # Exit-status check, not `docker ps | grep`: under pipefail grep -q can close the pipe early.
  if docker container inspect "$PG_NAME" >/dev/null 2>&1; then
    fail "a container named $PG_NAME already exists; remove it yourself and re-run. Nothing was touched."
  fi
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "$IMAGE is not pulled; run: docker pull $IMAGE"
  [[ -d "$root/node_modules" ]] || fail "run: npm ci --ignore-scripts"

  local pg_port api_port db_password run_token
  pg_port="$(free_port)"
  api_port="${KOBOLINK_X2_API_PORT:-$(free_port)}"
  [[ "$api_port" =~ ^[0-9]+$ ]] || fail "KOBOLINK_X2_API_PORT must be a number"
  case "$api_port" in 3000|3001) fail "refusing to use port $api_port (the dev servers' ports)";; esac
  port_is_free "$api_port" || fail "port $api_port is already in use by another process; this script will not start its API there and will not talk to whatever is listening. Nothing was touched."
  db_password="$(openssl rand -hex 16)"
  run_token="$(openssl rand -hex 12)"

  # From here on this process owns what it creates, and tears down exactly that if it fails.
  mkdir -m 700 "$STATE_DIR" || fail "could not create $STATE_DIR"
  umask 077
  printf '%s\n' "$MARKER_TEXT" > "$MARKER" || fail "could not write the marker in $STATE_DIR; leaving it alone"
  state_dir_is_ours || fail "$STATE_DIR is not the plain directory (yours, mode 700) it was just created as; leaving it alone"
  TEARDOWN_ON_EXIT=1
  {
    echo "PG_PORT=$pg_port"
    echo "API_PORT=$api_port"
    echo "RUN_TOKEN=$run_token"
  } > "$STATE"

  note "creating $PG_NAME on 127.0.0.1:$pg_port"
  local cid
  # create -> record the id -> start: whatever happens at `start` (a port taken, a daemon error), the container
  # exists, is recorded, and is removed by the failed run's teardown.
  cid="$(docker create --name "$PG_NAME" --label "$LABEL_KEY=$run_token" \
    -e POSTGRES_USER=kobolink -e POSTGRES_PASSWORD="$db_password" -e POSTGRES_DB=kobolink \
    -p "127.0.0.1:$pg_port:5432" "$IMAGE")" || fail "docker create failed"
  [[ "$cid" =~ ^[0-9a-f]{64}$ ]] || fail "docker create did not print a container id"
  state_set CONTAINER_ID "$cid"
  docker start "$cid" >/dev/null || fail "docker start failed"

  local i
  for i in $(seq 1 60); do
    if docker exec "$cid" pg_isready -U kobolink -d kobolink >/dev/null 2>&1; then break; fi
    sleep 1
    [[ "$i" == 60 ]] && fail "postgres did not become ready"
  done

  if [[ "${KOBOLINK_X2_SKIP_BUILD:-}" != "1" ]]; then
    note "building packages/contracts and apps/api"
    (cd "$root" && npm run build -w packages/contracts >"$STATE_DIR/build.log" 2>&1 && npm run build -w apps/api >>"$STATE_DIR/build.log" 2>&1) \
      || { tail -30 "$STATE_DIR/build.log" >&2; fail "build failed (log: $STATE_DIR/build.log)"; }
  fi

  note "applying migrations (node dist/db/migrate.js)"
  (cd "$root/apps/api" && DATABASE_URL="postgres://kobolink:$db_password@127.0.0.1:$pg_port/kobolink" node dist/db/migrate.js) \
    >"$STATE_DIR/migrate.log" 2>&1 || { cat "$STATE_DIR/migrate.log" >&2; fail "migrations failed"; }

  note "starting apps/api on port $api_port"
  # No NODE_ENV: the API's default is the production-shaped one (the web cookie is `Secure`). Mobile
  # clients get a bearer token in the body and no cookie, so this does not matter to them.
  # `cd` is its own statement: `cd x && cmd &` backgrounds the whole AND-list as a subshell, and `$!`
  # would then be that subshell (which also keeps the caller's pipe open), not node.
  (
    cd "$root/apps/api"
    DATABASE_URL="postgres://kobolink:$db_password@127.0.0.1:$pg_port/kobolink" PORT="$api_port" \
      nohup node dist/main.js >"$STATE_DIR/api.log" 2>&1 </dev/null &
    echo $! > "$STATE_DIR/api.pid"
  )
  local api_pid api_start
  api_pid="$(cat "$STATE_DIR/api.pid")"
  [[ "$api_pid" =~ ^[0-9]+$ ]] || fail "could not read the API pid"
  api_start="$(ps -p "$api_pid" -o lstart= 2>/dev/null || true)"
  state_set API_PID "$api_pid"
  state_set API_START "$api_start"

  # Wait for OUR process to say it is listening; a crash (EADDRINUSE, a bad env) is a failure even if some other
  # server happens to answer on the port.
  for i in $(seq 1 60); do
    kill -0 "$api_pid" 2>/dev/null || { tail -20 "$STATE_DIR/api.log" >&2; fail "the API exited before it was ready"; }
    if grep -q "listening on port $api_port" "$STATE_DIR/api.log" 2>/dev/null; then break; fi
    sleep 1
    [[ "$i" == 60 ]] && fail "the API did not log that it is listening on port $api_port"
  done
  api_is_ours "$api_pid" "$api_start" "$api_port" || fail "the process listening on port $api_port is not the API this script started"
  for i in $(seq 1 30); do
    if curl -fsS "http://localhost:$api_port/api/health" >/dev/null 2>&1; then
      # Up and recorded: from here the stack is the caller's, and stays unless `down` (or `all`'s exit) removes it.
      TEARDOWN_ON_EXIT=0
      pass "API healthy at http://localhost:$api_port (pid $api_pid, postgres on 127.0.0.1:$pg_port)"
      note "state: $STATE_DIR   log: $STATE_DIR/api.log   (the API listens on all interfaces until you run 'down')"
      return 0
    fi
    sleep 1
  done
  fail "the API did not answer /api/health"
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------
cmd_down() {
  need docker
  init_state_paths || fail "the state path is not acceptable: $STATE_PROBLEM"
  if [[ ! -f "$STATE" ]]; then
    note "no state file at $STATE: nothing was recorded, so nothing is removed"
    return 0
  fi
  state_dir_is_ours || fail "$STATE_DIR is not a directory this script created (a plain directory of yours, mode 700, with its marker): refusing to touch it"
  teardown_recorded
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && note "$line"
  done <<EOF
$DONE_MSGS
EOF
  pass "down finished"
}

cmd_status() {
  init_state_paths || fail "the state path is not acceptable: $STATE_PROBLEM"
  if [[ -f "$STATE" ]]; then
    load_state
    echo "up: $BASE_URL (api pid $(state_get API_PID), postgres 127.0.0.1:$(state_get PG_PORT))"
  else
    echo "down"
  fi
}

# ---------------------------------------------------------------------------
# check: the exact calls the iOS client makes
# ---------------------------------------------------------------------------
H="$(mktemp -t kobolink-x2-h.XXXXXX)"   # last response headers
B="$(mktemp -t kobolink-x2-b.XXXXXX)"   # last response body
trap on_exit EXIT

# req METHOD PATH [curl args...]  -> sets STATUS; headers in $H, body in $B.
# Every call sends exactly what the app sends. The app's session never sends cookies.
req() {
  local method="$1" path="$2"; shift 2
  STATUS="$(curl -sS -o "$B" -D "$H" -w '%{http_code}' -X "$method" "$BASE_URL$path" \
    -H 'Accept: application/json' "$@")"
}
header() { # header NAME -> value of a response header (case-insensitive), empty if absent
  awk -F': ' -v n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" 'tolower($1)==n {sub(/\r$/,"",$2); print $2}' "$H" | tail -1
}
body() { jq -r "$1" "$B"; }
expect_status() { [[ "$STATUS" == "$1" ]] || { cat "$B" >&2; echo >&2; fail "$2: expected HTTP $1, got $STATUS"; }; }
expect_json() { # expect_json LABEL JQ-EXPR  (the expression must be true)
  jq -e "$2" "$B" >/dev/null 2>&1 || { cat "$B" >&2; echo >&2; fail "$1: body does not satisfy: $2"; }
}
expect_no_header() { [[ -z "$(header "$1")" ]] || fail "$2: unexpected $1 header: $(header "$1")"; }
json() { jq -nc "$@"; }
newkey() { printf 'x2-%s' "$(openssl rand -hex 12)"; }
rand_pw() { printf 'Pw%s' "$(openssl rand -hex 8)"; }
rand_phone() { printf '+23480%08d' $(( (RANDOM * 32768 + RANDOM) % 100000000 )); }

cmd_check() {
  need curl; need jq; need openssl
  init_state_paths || fail "the state path is not acceptable: $STATE_PROBLEM"
  load_state
  # Before any request: whatever answers on the port must be the API process this script started, or the checks
  # would register users on (and send passwords to) a server that is not ours.
  api_is_ours "$(state_get API_PID)" "$(state_get API_START)" "$API_PORT" \
    || fail "the process on port $API_PORT is not the API this script started (recorded pid $(state_get API_PID)): refusing to talk to it. Run '$0 down' and 'up' again."
  curl -fsS "$BASE_URL/api/health" >/dev/null || fail "no API at $BASE_URL"
  local tag; tag="$(openssl rand -hex 4)"
  local m_email="merchant-$tag@example.test" c_email="customer-$tag@example.test"
  local m_pw c_pw; m_pw="$(rand_pw)"; c_pw="$(rand_pw)"
  local m_phone c_phone; m_phone="$(rand_phone)"; c_phone="$(rand_phone)"

  # -- health ---------------------------------------------------------------
  req GET /api/health
  expect_status 200 "GET /api/health"
  pass "health 200"

  # -- register (not an app call: sets up the two users) ----------------------
  req POST /api/auth/register -H 'Content-Type: application/json' \
    -d "$(json --arg e "$m_email" --arg p "$m_pw" --arg ph "$m_phone" '{email:$e,password:$p,displayName:"Smoke Merchant",phone:$ph,role:"merchant",client:"mobile"}')"
  expect_status 201 "register merchant"
  req POST /api/auth/register -H 'Content-Type: application/json' \
    -d "$(json --arg e "$c_email" --arg p "$c_pw" --arg ph "$c_phone" '{email:$e,password:$p,displayName:"Smoke Customer",phone:$ph,role:"customer",client:"mobile"}')"
  expect_status 201 "register customer"
  pass "registered a merchant and a customer (mobile)"

  # -- login: wrong password, then success (client: mobile) -------------------
  req POST /api/auth/login -H 'Content-Type: application/json' \
    -d "$(json --arg e "$m_email" '{email:$e,password:"definitely-wrong-pw",client:"mobile"}')"
  expect_status 401 "login with a wrong password"
  expect_json "wrong password" '.code=="unauthenticated" and (.message|type=="string")'
  expect_no_header set-cookie "wrong-password login"
  pass "login wrong password -> 401 unauthenticated"

  req POST /api/auth/login -H 'Content-Type: application/json' \
    -d "$(json --arg e "$m_email" --arg p "$m_pw" '{email:$e,password:$p,client:"mobile"}')"
  expect_status 200 "login"
  expect_json "login body" '(.token|type=="string" and length>=32) and .user.role=="merchant" and (.user.id|type=="string") and (.session.expiresAt|test("^[0-9]{4}-.*Z$"))'
  expect_no_header set-cookie "mobile login (a bearer client must not receive a cookie)"
  local m_token; m_token="$(body .token)"
  req POST /api/auth/login -H 'Content-Type: application/json' \
    -d "$(json --arg e "$c_email" --arg p "$c_pw" '{email:$e,password:$p,client:"mobile"}')"
  expect_status 200 "customer login"
  local c_token; c_token="$(body .token)"
  pass "login (mobile) -> 200, token in body, no Set-Cookie"

  req GET /api/auth/me -H "Authorization: Bearer $m_token"
  expect_status 200 "GET /api/auth/me"
  expect_json "me" '.user.email=="'"$m_email"'"'
  req GET /api/auth/me -H "Authorization: Bearer not-a-real-token-not-a-real-token-0000"
  expect_status 401 "me with a bad token"
  expect_json "me 401" '.code=="unauthenticated"'
  pass "me: 200 with the token, 401 unauthenticated with a bad one"

  # -- merchant creates links (not an app call) -------------------------------
  req POST /api/links -H "Authorization: Bearer $m_token" -H 'Content-Type: application/json' \
    -d '{"title":"Smoke fixed","amountKobo":250000,"isReusable":true}'
  expect_status 201 "create fixed link"
  local fixed; fixed="$(body .code)"
  req POST /api/links -H "Authorization: Bearer $m_token" -H 'Content-Type: application/json' \
    -d '{"title":"Smoke open","description":"any amount","isReusable":true}'
  expect_status 201 "create open link"
  local open; open="$(body .code)"
  req POST /api/links -H "Authorization: Bearer $m_token" -H 'Content-Type: application/json' \
    -d '{"title":"Smoke single","amountKobo":100000}'
  expect_status 201 "create single-use link"
  local single; single="$(body .code)"
  req POST /api/links -H "Authorization: Bearer $m_token" -H 'Content-Type: application/json' \
    -d '{"title":"Smoke disabled","amountKobo":100000,"isReusable":true}'
  expect_status 201 "create the link to disable"
  local disabled; disabled="$(body .code)"
  req PATCH "/api/links/$disabled/status" -H "Authorization: Bearer $m_token" -H 'Content-Type: application/json' -d '{"status":"disabled"}'
  expect_status 200 "disable link"

  # -- public link: no Authorization, no cookie -------------------------------
  req GET "/api/links/$fixed/public"
  expect_status 200 "public link"
  expect_json "public fixed" '.state=="payable" and .link.code=="'"$fixed"'" and .link.amountKobo==250000 and .link.currency=="NGN" and (.link.merchantName|type=="string") and (.link|has("expiresAt")) and (.link|has("description"))'
  req GET "/api/links/$open/public"
  expect_json "public open" '.link.amountKobo==null and .state=="payable"'
  req GET "/api/links/$disabled/public"
  expect_status 200 "public disabled link"
  expect_json "public disabled" '.state=="disabled"'
  req GET "/api/links/ZZZZZZZZ/public"
  expect_status 404 "public unknown link"
  expect_json "public unknown" '.code=="not_found"'
  pass "public link: payable fixed + open amount, disabled state, 404 not_found"

  # -- initialize + verify: the payer's calls ---------------------------------
  local key; key="$(newkey)"
  local init_body; init_body="$(json --arg c "$fixed" '{code:$c,amountKobo:250000,payerName:"Ada Payer",payerEmail:"ada@example.test"}')"
  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $key" -d "$init_body"
  expect_status 201 "initialize"
  expect_json "initialize" '(.reference|type=="string" and length>0) and .status=="pending" and .amountKobo==250000 and .code=="'"$fixed"'" and .currency=="NGN" and (.createdAt|test("\\.[0-9]{3}Z$"))'
  local ref first_init; ref="$(body .reference)"; first_init="$(jq -S . "$B")"
  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $key" -d "$init_body"
  expect_status 201 "initialize replay"
  [[ "$(jq -S . "$B")" == "$first_init" ]] || fail "initialize replay (same key) did not return the stored original"
  pass "initialize: 201 pending; the same key replays the stored original (same reference)"

  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $key" \
    -d "$(json --arg c "$fixed" '{code:$c,amountKobo:250000,payerName:"Someone Else",payerEmail:"ada@example.test"}')"
  expect_status 422 "initialize same key, different body"
  expect_json "idempotency_mismatch" '.code=="idempotency_mismatch" and .moneyMoved==false'
  req POST /api/checkout/initialize -H 'Content-Type: application/json' -d "$init_body"
  expect_status 400 "initialize without a key"
  expect_json "no key" '.code=="validation_failed" and .moneyMoved==false'
  pass "initialize: same key + other body -> 422 idempotency_mismatch; no key -> 400 validation_failed"

  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg c "$fixed" '{code:$c,amountKobo:250001,payerName:"Ada Payer",payerEmail:"ada@example.test"}')"
  expect_status 422 "amount_mismatch"
  expect_json "amount_mismatch" '.code=="amount_mismatch" and .moneyMoved==false'
  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg c "$disabled" '{code:$c,amountKobo:100000,payerName:"Ada Payer",payerEmail:"ada@example.test"}')"
  expect_status 409 "link_not_payable"
  expect_json "link_not_payable" '.code=="link_not_payable" and .state=="disabled" and .moneyMoved==false'
  pass "initialize: amount_mismatch is 422 and link_not_payable(disabled) is 409, both moneyMoved false"

  local vkey; vkey="$(newkey)"
  req POST /api/checkout/verify -H 'Content-Type: application/json' -H "Idempotency-Key: $vkey" -d "$(json --arg r "$ref" '{reference:$r}')"
  expect_status 200 "verify"
  expect_json "verify success" '.payment.status=="success" and .payment.moneyMoved==true and .payment.reference=="'"$ref"'" and .payment.amountKobo==250000 and (.payment.createdAt|type=="string")'
  local first_verify; first_verify="$(jq -S . "$B")"
  req POST /api/checkout/verify -H 'Content-Type: application/json' -H "Idempotency-Key: $vkey" -d "$(json --arg r "$ref" '{reference:$r}')"
  [[ "$(jq -S . "$B")" == "$first_verify" ]] || fail "verify replay (same key) did not return the stored original"
  req POST /api/checkout/verify -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" -d "$(json --arg r "$ref" '{reference:$r}')"
  [[ "$(jq -S . "$B")" == "$first_verify" ]] || fail "verify of a decided reference under a NEW key did not return the original payment"
  pass "verify: success + moneyMoved true; replay and a new key both return the original"

  req POST /api/checkout/verify -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" -d '{"reference":"kbl_ZZZZZZZZZZ"}'
  expect_status 404 "verify unknown reference"
  expect_json "verify unknown" '.code=="not_found" and .moneyMoved==false'
  pass "verify: unknown reference -> 404 not_found, moneyMoved false"

  # Declined path
  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg c "$open" '{code:$c,amountKobo:70000,payerName:"Fay Ledger",payerEmail:"fail@example.test"}')"
  expect_status 201 "initialize (decline)"
  local dref; dref="$(body .reference)"
  req POST /api/checkout/verify -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" -d "$(json --arg r "$dref" '{reference:$r}')"
  expect_status 200 "verify (decline)"
  expect_json "verify declined" '.payment.status=="failed" and .payment.moneyMoved==false and (.payment.failureReason|type=="string")'
  pass "verify: fail@ -> 200 status failed, moneyMoved false, failureReason present"

  # Single-use link already paid
  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg c "$single" '{code:$c,amountKobo:100000,payerName:"Ada Payer",payerEmail:"ada@example.test"}')"
  local sref; sref="$(body .reference)"
  req POST /api/checkout/verify -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" -d "$(json --arg r "$sref" '{reference:$r}')"
  expect_json "single-use verify" '.payment.status=="success"'
  req GET "/api/links/$single/public"
  expect_json "public paid" '.state=="already-paid"'
  req POST /api/checkout/initialize -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg c "$single" '{code:$c,amountKobo:100000,payerName:"Ada Payer",payerEmail:"ada@example.test"}')"
  expect_status 409 "initialize on a paid single-use link"
  expect_json "already paid" '.code=="link_not_payable" and .moneyMoved==false'
  pass "single-use link: paid once, then public state already-paid and initialize is 409 link_not_payable"

  # -- wallet (bearer token) --------------------------------------------------
  req GET /api/wallet
  expect_status 401 "wallet without a token"
  req GET /api/wallet -H "Authorization: Bearer $c_token"
  expect_status 200 "wallet"
  expect_json "wallet" '.currency=="NGN" and .balanceKobo==0 and (.accountId|type=="string") and (.asOf|type=="string")'
  req POST /api/wallet/topup -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" -d '{"amountKobo":1000000}'
  expect_status 201 "topup"
  expect_json "topup" '.wallet.balanceKobo==1000000 and .transaction.kind=="topup" and .transaction.amountKobo==1000000'
  pass "wallet: 401 unauthenticated without a token; 200 with; topup 201"

  local tkey; tkey="$(newkey)"
  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $tkey" \
    -d "$(json --arg p "$m_phone" '{toPhone:$p,amountKobo:300000}')"
  expect_status 201 "transfer without a note (the note key is omitted)"
  expect_json "transfer" '.wallet.balanceKobo==700000 and .transaction.kind=="transfer" and .transaction.amountKobo==-300000 and .transaction.note==null and (.transaction.counterparty|type=="string")'
  local first_transfer; first_transfer="$(jq -S . "$B")"
  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $tkey" \
    -d "$(json --arg p "$m_phone" '{toPhone:$p,amountKobo:300000}')"
  expect_status 201 "transfer replay"
  [[ "$(jq -S . "$B")" == "$first_transfer" ]] || fail "transfer replay (same key) did not return the stored original"
  req GET /api/wallet -H "Authorization: Bearer $c_token"
  expect_json "no double post" '.balanceKobo==700000'
  pass "transfer without a note: 201; replay returns the stored original; balance moved once"

  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg p "$m_phone" '{toPhone:$p,amountKobo:50000,note:"Lunch money"}')"
  expect_status 201 "transfer with a note"
  expect_json "transfer note" '.transaction.note=="Lunch money" and .wallet.balanceKobo==650000'
  # What the validator does with the shapes a client could plausibly send for "no note".
  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg p "$m_phone" '{toPhone:$p,amountKobo:10000,note:null}')"
  note "note:null is HTTP $STATUS ($(jq -c '.code // "created"' "$B")) -- the app omits the key, so it never sends this"
  [[ "$STATUS" == "400" ]] || fail "contract changed: note:null is now accepted ($STATUS); the I5 omission rule could be relaxed, update the README"
  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg p "$m_phone" '{toPhone:$p,amountKobo:10000,note:""}')"
  note "note:\"\" is HTTP $STATUS"
  pass "transfer with a note: 201 and the note is echoed; note:null is rejected 400 (omission is required)"

  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg p "$m_phone" '{toPhone:$p,amountKobo:999999999}')"
  expect_status 422 "insufficient funds"
  expect_json "insufficient" '.code=="insufficient_funds" and .moneyMoved==false'
  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d '{"toPhone":"+2348099999999","amountKobo":10000}'
  expect_status 404 "unknown recipient"
  expect_json "unknown recipient" '.code=="not_found"'
  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg p "$c_phone" '{toPhone:$p,amountKobo:10000}')"
  expect_status 400 "transfer to self"
  expect_json "self" '.code=="validation_failed" and (.fields.toPhone|length>0)'
  pass "transfer errors: insufficient_funds 422, unknown recipient 404 not_found, self 400 with fields.toPhone"

  req GET "/api/wallet/transactions?limit=20" -H "Authorization: Bearer $c_token"
  expect_status 200 "transactions"
  expect_json "transactions" '(.items|length)>=3 and (.items[0].createdAt|test("Z$")) and has("nextCursor")'
  pass "wallet transactions: at least 3 rows (topup + 2 transfers), nextCursor present"

  # Pagination as the app asks for it: limit=20, then the opaque nextCursor sent back percent-encoded.
  for i in $(seq 1 20); do
    req POST /api/wallet/topup -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" -d '{"amountKobo":10000}'
    expect_status 201 "topup $i"
  done
  req GET "/api/wallet/transactions?limit=20" -H "Authorization: Bearer $c_token"
  expect_json "page 1" '(.items|length)==20 and (.nextCursor|type=="string")'
  local cursor; cursor="$(body .nextCursor)"
  req GET "/api/wallet/transactions?limit=20&cursor=$(jq -rn --arg c "$cursor" '$c|@uri')" -H "Authorization: Bearer $c_token"
  expect_status 200 "page 2"
  expect_json "page 2" '(.items|length)>=3 and .nextCursor==null'
  pass "wallet transactions: page 1 has 20 and a cursor; the cursor (percent-encoded) returns the remainder and a null cursor"

  # A whitespace-only note is trimmed by the server's schema to "" and echoed as "" (not null, not omitted). The app
  # treats a blank note as no note; this only reports what the server does so a change is noticed.
  req POST /api/wallet/transfer -H "Authorization: Bearer $c_token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(newkey)" \
    -d "$(json --arg p "$m_phone" '{toPhone:$p,amountKobo:10000,note:"   "}')"
  expect_status 201 "transfer with a whitespace-only note"
  note "whitespace-only note is stored and returned as $(jq -c .transaction.note "$B") (the app shows no note for \"\")"

  # -- login rate limit (a throwaway email: 5 failures lock THAT email, not the users above) --
  local rl_email="ratelimit-$tag@example.test" i
  for i in 1 2 3 4 5; do
    req POST /api/auth/login -H 'Content-Type: application/json' \
      -d "$(json --arg e "$rl_email" '{email:$e,password:"wrong-wrong-wrong",client:"mobile"}')"
    expect_status 401 "rate-limit attempt $i"
  done
  req POST /api/auth/login -H 'Content-Type: application/json' \
    -d "$(json --arg e "$rl_email" '{email:$e,password:"wrong-wrong-wrong",client:"mobile"}')"
  expect_status 429 "sixth attempt"
  expect_json "429 body" '.code=="rate_limited"'
  [[ "$(header retry-after)" =~ ^[0-9]+$ ]] || fail "429 carries no numeric Retry-After header (got '$(header retry-after)')"
  pass "login rate limit: 6th failure -> 429 rate_limited with Retry-After: $(header retry-after) s"

  # -- logout -----------------------------------------------------------------
  req POST /api/auth/logout -H "Authorization: Bearer $c_token"
  expect_status 204 "logout"
  req GET /api/auth/me -H "Authorization: Bearer $c_token"
  expect_status 401 "me after logout"
  pass "logout: 204, and the revoked token is 401 afterwards"

  echo
  printf '\033[32mAll contract checks passed against %s\033[0m\n' "$BASE_URL"
}

cmd_all() {
  # `up` refuses (and removes nothing) if anything of the script's already exists, and tears down what it created if
  # it fails part way. Only once it has succeeded is the stack ours to remove on exit, success or not.
  cmd_up
  TEARDOWN_ON_EXIT=1
  cmd_check
}

case "${1:-all}" in
  up) cmd_up ;;
  check) cmd_check ;;
  down) cmd_down ;;
  status) cmd_status ;;
  all) cmd_all ;;
  *) echo "usage: $0 [up|check|down|status|all]" >&2; exit 2 ;;
esac
