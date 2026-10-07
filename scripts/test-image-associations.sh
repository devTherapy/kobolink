#!/usr/bin/env bash
# Builds the apps/web production image and proves, against THAT image (not
# `next dev`, not a unit test), that:
#   1. /.well-known/apple-app-site-association and /.well-known/assetlinks.json
#      answer 200 with application/json and NO redirect, with the exact JSON
#      shape the smoke test and Apple/Google expect;
#   2. the browser-facing /api/* rewrite goes to the API_ORIGIN baked in at
#      BUILD time (Next freezes rewrites during `next build`; setting
#      API_ORIGIN only at runtime would silently not work);
#   3. the server-side fetches of /l/[code] go to the RUNTIME API_ORIGIN
#      (apps/web/src/lib/api.ts reads process.env.API_ORIGIN per request).
#
# 2 and 3 are told apart on purpose: the image is built with one stub API as
# API_ORIGIN and run with a DIFFERENT stub as API_ORIGIN, so each stub's
# request log shows which setting each path really used. In production
# fly.toml sets both, to the same value.
#
# It is a pre-deploy check: no Fly, no real credentials. The Apple/Android
# values below are obvious placeholders for a throwaway container; TESTTEAM00
# is not the repo's rejected ABCDE12345 placeholder, so the handler is willing
# to serve it.
#
# Usage: ./scripts/test-image-associations.sh        (needs docker, node, curl)
# Everything it creates is named kobolink-x3-* and is removed on exit; it never
# touches any other container or image.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

IMAGE="kobolink-x3-web-test"
CONTAINER="kobolink-x3-web-test"
APPLE_APP_ID_PLACEHOLDER="TESTTEAM00.com.folusayo.kobolink"
# 32 bytes of 00 — shaped like a SHA-256 fingerprint, obviously not a real one.
FINGERPRINT_PLACEHOLDER="$(node -e 'console.log(Array(32).fill("00").join(":"))')"

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

command -v docker >/dev/null || fail "docker is required"
command -v node >/dev/null || fail "node is required"

# Never clobber something we did not create.
# (Exit-status checks, not `docker ... | grep -q`: under pipefail grep -q can
# close the pipe early and make a real match read as "not found".)
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  fail "a container named $CONTAINER already exists; remove it yourself and re-run"
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "an image tagged $IMAGE already exists; remove it yourself and re-run (the exit cleanup runs docker rmi on that tag)"
fi

work="$(mktemp -d)"
stub_pids=()
cleanup() {
  for pid in "${stub_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# A stand-in for apps/api on a free host port, so the checks need no database.
# Answers GET /api/health the way the real controller does, 404s everything
# else, and logs every request path to <name>-requests so the test can prove
# which requests really reached which stub. Sets <name>_port.
start_stub() { # <name>
  local name="$1"
  : >"$work/$name-requests"
  node -e '
    const http = require("node:http");
    const fs = require("node:fs");
    const s = http.createServer((req, res) => {
      fs.appendFileSync(process.argv[1], req.url + "\n");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") return res.end(JSON.stringify({ status: "ok" }));
      res.statusCode = 404;
      res.end(JSON.stringify({ code: "not_found", message: "stub" }));
    });
    s.listen(0, "0.0.0.0", () => { console.log(s.address().port); });
  ' "$work/$name-requests" >"$work/$name-port" &
  local pid=$!
  disown "$pid"
  stub_pids+=("$pid")
  for _ in $(seq 1 50); do
    if [ -s "$work/$name-port" ]; then break; fi
    sleep 0.1
  done
  [ -s "$work/$name-port" ] || fail "could not start the $name API stub"
  printf -v "${name}_port" '%s' "$(cat "$work/$name-port")"
}
start_stub build   # baked into the image at build time (the /api/* rewrite)
start_stub runtime # passed to the container at run time (server-side fetches)

echo "building $IMAGE (build-time API_ORIGIN = http://host.docker.internal:$build_port)..."
docker build -f apps/web/Dockerfile \
  --build-arg "API_ORIGIN=http://host.docker.internal:$build_port" \
  -t "$IMAGE" . >"$work/build.log" 2>&1 \
  || { tail -40 "$work/build.log" >&2; fail "docker build failed"; }
image_mb=$(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0f", $1/1000000}')
pass "image built (${image_mb} MB)"

docker run -d --name "$CONTAINER" \
  --add-host=host.docker.internal:host-gateway \
  -p 127.0.0.1::3000 \
  -e "APPLE_APP_ID=$APPLE_APP_ID_PLACEHOLDER" \
  -e "ANDROID_PACKAGE_NAME=com.folusayo.kobolink" \
  -e "ANDROID_SHA256_FINGERPRINTS=$FINGERPRINT_PLACEHOLDER" \
  -e "API_ORIGIN=http://host.docker.internal:$runtime_port" \
  "$IMAGE" >/dev/null
host_port="$(docker port "$CONTAINER" 3000/tcp | head -1 | sed 's/.*://')"
base="http://127.0.0.1:$host_port"

ready=""
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$base/.well-known/assetlinks.json"; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then
  docker logs "$CONTAINER" >&2 || true
  fail "container did not start serving within 60s"
fi

# Fetch WITHOUT following redirects (no -L): a 3xx here is the failure.
check() { # <path> <expected-json-file>
  local path="$1" expected="$2" code
  code=$(curl -sS -o "$work/body.json" -D "$work/headers" -w '%{http_code}' "$base$path")
  [ "$code" = "200" ] || fail "$path returned HTTP $code (a redirect or 503 here breaks the app association)"
  if grep -qi '^location:' "$work/headers"; then fail "$path sent a Location header"; fi
  grep -qi '^content-type: application/json' "$work/headers" \
    || fail "$path content-type is not application/json: $(grep -i '^content-type' "$work/headers")"
  node -e '
    const fs = require("node:fs");
    const { isDeepStrictEqual } = require("node:util");
    const [got, want] = process.argv.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    process.exit(isDeepStrictEqual(got, want) ? 0 : 1);
  ' "$work/body.json" "$expected" \
    || { echo "got: $(cat "$work/body.json")" >&2; fail "$path JSON shape differs from the expected document"; }
  pass "$path -> 200, application/json, no redirect, exact JSON"
}

cat >"$work/aasa.expected.json" <<JSON
{"applinks":{"details":[{"appIDs":["$APPLE_APP_ID_PLACEHOLDER"],"components":[
  {"/":"/l/*","comment":"Payment link"},
  {"/":"/.well-known/*","exclude":true,"comment":"Association files"}]}]}}
JSON
cat >"$work/assetlinks.expected.json" <<JSON
[{"relation":["delegate_permission/common.handle_all_urls"],"target":{
  "namespace":"android_app","package_name":"com.folusayo.kobolink",
  "sha256_cert_fingerprints":["$FINGERPRINT_PLACEHOLDER"]}}]
JSON

check /.well-known/apple-app-site-association "$work/aasa.expected.json"
check /.well-known/assetlinks.json "$work/assetlinks.expected.json"

# The rewrite: /api/health on the web container must come back from the BUILD
# stub, and the runtime stub (the container's API_ORIGIN) must not have seen it.
body=$(curl -sS "$base/api/health" || true)
[ "$body" = '{"status":"ok"}' ] \
  || fail "/api/health through the web image did not reach the build-time API_ORIGIN (got: ${body:-nothing})"
grep -qx '/api/health' "$work/build-requests" \
  || fail "the build-time stub never received GET /api/health"
if grep -qx '/api/health' "$work/runtime-requests"; then
  fail "the /api/* rewrite followed the RUNTIME API_ORIGIN; it should be frozen at build time"
fi
pass "/api/* proxies to the API_ORIGIN baked in at build time (not the runtime value)"

# /l/[code] is a server component: it validates the code, then fetches the
# link from process.env.API_ORIGIN at request time. ABCDEFGH is a valid
# 8-character code from the real alphabet, so the page genuinely makes that
# server-side fetch; the stub answers 404, which must render Next's not-found
# page (404), not crash (500) on a module missing from the traced tree.
code=$(curl -sS -o /dev/null -w '%{http_code}' "$base/l/ABCDEFGH")
[ "$code" = "404" ] || fail "/l/ABCDEFGH returned HTTP $code, expected the 404 not-found page"
grep -qx '/api/links/ABCDEFGH/public' "$work/runtime-requests" \
  || fail "the runtime stub never received GET /api/links/ABCDEFGH/public; the server-side fetch did not use the runtime API_ORIGIN"
if grep -qx '/api/links/ABCDEFGH/public' "$work/build-requests"; then
  fail "the server-side fetch went to the build-time stub; it should use the runtime API_ORIGIN"
fi
# Capture the log to a file first: `docker logs | grep -q` is a pipe under
# pipefail and can misreport (SIGPIPE) exactly like the guards above.
docker logs "$CONTAINER" >"$work/container.log" 2>&1 || true
if grep -qE 'Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND' "$work/container.log"; then
  cat "$work/container.log" >&2
  fail "the web container logged a missing module"
fi
pass "/l/ABCDEFGH fetched /api/links/ABCDEFGH/public from the runtime API_ORIGIN, rendered 404, no missing-module errors"

printf '\n\033[32mImage association checks passed\033[0m\n'
