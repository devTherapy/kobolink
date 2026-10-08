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
#   ./scripts/ios-real-api-smoke.sh down       stop and remove only what `up` created
#   ./scripts/ios-real-api-smoke.sh status     is it up, and where
#
# Needs: docker (daemon running), node 22, npm dependencies installed
# (`npm ci --ignore-scripts`), curl, jq, python3. Uses the postgres:17-alpine
# image already pulled for the e2e suite; it pulls nothing else.
#
# What it creates, and ONLY this (everything is named kobolink-x2-*):
#   - one container  kobolink-x2-pg   (postgres:17-alpine, bound to 127.0.0.1 on a random free port)
#   - one node process: apps/api `node dist/main.js` on a random free port (never 3000/3001)
#   - a state directory (default $TMPDIR/kobolink-x2-state, mode 700) with the API log and the
#     generated credentials. NOTHING secret is ever written inside the repository.
# `down` removes the container by that exact name, kills the API by the PID it recorded, and deletes the
# state directory. It never touches other containers, volumes, networks or images.
#
# Credentials (database password, test users' passwords) are generated at run time by `openssl rand`
# and live only in the state directory. They are not printed.
#
# Env
#   KOBOLINK_X2_STATE_DIR   where state lives (default "${TMPDIR:-/tmp}/kobolink-x2-state")
#   KOBOLINK_X2_SKIP_BUILD  1 = reuse apps/api/dist and packages/contracts/dist as they are
#   KOBOLINK_X2_API_PORT    force the API port (default: a free random one)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${KOBOLINK_X2_STATE_DIR:-${TMPDIR:-/tmp}/kobolink-x2-state}"
PG_NAME="kobolink-x2-pg"
IMAGE="postgres:17-alpine"
STATE="$STATE_DIR/stack.env"

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }

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

load_state() {
  [[ -f "$STATE" ]] || fail "no stack is up (no $STATE); run: $0 up"
  # shellcheck disable=SC1090
  source "$STATE"
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------
cmd_up() {
  need docker; need node; need curl; need jq; need python3; need openssl
  docker info >/dev/null 2>&1 || fail "the docker daemon is not running"
  if [[ -f "$STATE" ]]; then fail "a stack is already up (see $STATE); run: $0 down"; fi
  # Exit-status check, not `docker ps | grep`: under pipefail grep -q can close the pipe early.
  if docker container inspect "$PG_NAME" >/dev/null 2>&1; then
    fail "a container named $PG_NAME already exists; remove it yourself and re-run (this script only removes what it created)"
  fi
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "$IMAGE is not pulled; run: docker pull $IMAGE"
  [[ -d "$root/node_modules" ]] || fail "run: npm ci --ignore-scripts"

  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"

  local pg_port api_port db_password
  pg_port="$(free_port)"
  api_port="${KOBOLINK_X2_API_PORT:-$(free_port)}"
  case "$api_port" in 3000|3001) fail "refusing to use port $api_port (the dev servers' ports)";; esac
  db_password="$(openssl rand -hex 16)"

  # Written first so a failed `up` can still be torn down by `down`.
  umask 077
  {
    echo "PG_PORT=$pg_port"
    echo "API_PORT=$api_port"
    echo "API_PID="
    echo "DB_PASSWORD=$db_password"
    echo "DATABASE_URL=postgres://kobolink:$db_password@127.0.0.1:$pg_port/kobolink"
    echo "BASE_URL=http://localhost:$api_port"
  } > "$STATE"

  note "starting $PG_NAME on 127.0.0.1:$pg_port"
  docker run -d --name "$PG_NAME" \
    -e POSTGRES_USER=kobolink -e POSTGRES_PASSWORD="$db_password" -e POSTGRES_DB=kobolink \
    -p "127.0.0.1:$pg_port:5432" "$IMAGE" >/dev/null

  local i
  for i in $(seq 1 60); do
    if docker exec "$PG_NAME" pg_isready -U kobolink -d kobolink >/dev/null 2>&1; then break; fi
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
  local api_pid; api_pid="$(cat "$STATE_DIR/api.pid")"
  sed -i.bak "s/^API_PID=.*/API_PID=$api_pid/" "$STATE" && rm -f "$STATE.bak"

  for i in $(seq 1 60); do
    if curl -fsS "http://localhost:$api_port/api/health" >/dev/null 2>&1; then
      pass "API healthy at http://localhost:$api_port (pid $api_pid, postgres on 127.0.0.1:$pg_port)"
      note "state: $STATE_DIR   log: $STATE_DIR/api.log"
      return 0
    fi
    kill -0 "$api_pid" 2>/dev/null || { tail -20 "$STATE_DIR/api.log" >&2; fail "the API exited before it was ready"; }
    sleep 1
  done
  fail "the API did not answer /api/health"
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------
cmd_down() {
  if [[ -f "$STATE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE"
    if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
      # Only the process we recorded, and only if it still looks like our node.
      if ps -p "$API_PID" -o command= | grep -q "dist/main.js"; then
        kill "$API_PID" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.5; done
        kill -0 "$API_PID" 2>/dev/null && kill -9 "$API_PID" 2>/dev/null || true
      fi
    fi
  fi
  # Exactly our container name; `up` refuses to start when one exists, so this is always ours.
  if docker container inspect "$PG_NAME" >/dev/null 2>&1; then
    docker rm -f -v "$PG_NAME" >/dev/null
  fi
  rm -rf "$STATE_DIR"
  pass "stopped and removed $PG_NAME, the API process and $STATE_DIR"
}

cmd_status() {
  if [[ -f "$STATE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE"
    echo "up: $BASE_URL (api pid $API_PID, postgres 127.0.0.1:$PG_PORT)"
  else
    echo "down"
  fi
}

# ---------------------------------------------------------------------------
# check: the exact calls the iOS client makes
# ---------------------------------------------------------------------------
H="$(mktemp -t kobolink-x2-h.XXXXXX)"   # last response headers
B="$(mktemp -t kobolink-x2-b.XXXXXX)"   # last response body
trap 'rm -f "$H" "$B"' EXIT

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
  load_state
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
  # Tear down on any exit of the default mode, success or not.
  trap 'cmd_down >/dev/null 2>&1 || true; rm -f "$H" "$B"' EXIT
  cmd_up
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
