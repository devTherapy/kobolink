#!/usr/bin/env bash
# Builds the apps/api production image and proves, against THAT image:
#   1. every dependency npm installs into a workspace-NESTED node_modules
#      (package-lock.json pins nanoid 5 under apps/api and packages/contracts
#      while the hoisted root copy is nanoid 3, which only postcss/next want)
#      resolves to the locked version, from the api's context and from the
#      contracts package's context, as the runtime user;
#   2. `node dist/db/migrate.js` (the Fly release_command) applies migrations to
#      a real Postgres;
#   3. `node dist/main.js` actually boots and /api/health answers 200, which
#      round-trips the database. The release_command alone cannot show this: it
#      imports neither nanoid nor most of the app.
#
# Pre-deploy check; no Fly, no real credentials. The database is a throwaway
# container with a random password generated here and never printed.
#
# Usage: ./scripts/test-image-api.sh        (needs docker, node)
# Everything it creates is named kobolink-x3-* and removed on exit; it refuses
# to start if any of those names already exist, so it can never remove
# something it did not create.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

IMAGE="kobolink-x3-api-test"
API="kobolink-x3-api-test"
DB="kobolink-x3-pg-test"
NET="kobolink-x3-net-test"

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

command -v docker >/dev/null || fail "docker is required"
command -v node >/dev/null || fail "node is required"

# Exit-status checks, not `docker ... | grep -q`: under pipefail grep -q can
# close the pipe early and make a real match read as "not found", which would
# let the exit cleanup remove something this script did not create.
for name in "$API" "$DB"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    fail "a container named $name already exists; remove it yourself and re-run"
  fi
done
if docker network inspect "$NET" >/dev/null 2>&1; then
  fail "a network named $NET already exists; remove it yourself and re-run"
fi
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "an image tagged $IMAGE already exists; remove it yourself and re-run"
fi

work="$(mktemp -d)"
cleanup() {
  docker rm -f "$API" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# The locked major version of nanoid under apps/api, read from the lockfile so
# this test follows an intentional upgrade instead of hard-coding 5.
want_major="$(node -e '
  const l = require("./package-lock.json").packages;
  const a = l["apps/api/node_modules/nanoid"], c = l["packages/contracts/node_modules/nanoid"];
  if (!a || !c) { console.error("lockfile no longer nests nanoid under api/contracts"); process.exit(1); }
  console.log(a.version.split(".")[0] + " " + c.version.split(".")[0]);
')" || fail "could not read the locked nanoid versions"
api_major="${want_major% *}"
contracts_major="${want_major#* }"

echo "building $IMAGE..."
docker build -f apps/api/Dockerfile -t "$IMAGE" . >"$work/build.log" 2>&1 \
  || { tail -40 "$work/build.log" >&2; fail "docker build failed"; }
pass "image built"

# --- 1. nested dependencies resolve to the locked versions, as the runtime user
resolve_script='
  const { createRequire } = require("node:module");
  const fs = require("node:fs");
  const path = require("node:path");
  const [ctx, want] = process.argv.slice(1);
  let dir = path.dirname(createRequire(ctx).resolve("nanoid"));
  while (!fs.existsSync(path.join(dir, "package.json")) ||
         JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name !== "nanoid") {
    const up = path.dirname(dir);
    if (up === dir) { console.error("nanoid package.json not found"); process.exit(2); }
    dir = up;
  }
  const version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  console.log(ctx + " -> nanoid " + version + " (" + dir + ")");
  process.exit(version.split(".")[0] === want ? 0 : 1);
'
docker run --rm --entrypoint node "$IMAGE" -e "$resolve_script" \
  /app/apps/api/dist/main.js "$api_major" \
  || fail "apps/api does not resolve nanoid $api_major.x in the image (missing or wrong nested node_modules)"
docker run --rm --entrypoint node "$IMAGE" -e "$resolve_script" \
  /app/packages/contracts/dist/code.js "$contracts_major" \
  || fail "packages/contracts does not resolve nanoid $contracts_major.x in the image (missing or wrong nested node_modules)"
pass "nanoid resolves to the locked major from apps/api and packages/contracts"

# --- 2 + 3. migrate, then boot the real server against a real Postgres
docker network create "$NET" >/dev/null
pg_password="$(node -e 'console.log(require("node:crypto").randomBytes(18).toString("hex"))')"
docker run -d --name "$DB" --network "$NET" \
  -e "POSTGRES_PASSWORD=$pg_password" -e POSTGRES_DB=kobolink \
  postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$DB" pg_isready -U postgres -d kobolink >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$DB" pg_isready -U postgres -d kobolink >/dev/null 2>&1 || fail "throwaway Postgres did not start"
db_url="postgres://postgres:$pg_password@$DB:5432/kobolink"

docker run --rm --network "$NET" -e "DATABASE_URL=$db_url" "$IMAGE" node dist/db/migrate.js \
  || fail "node dist/db/migrate.js (the release_command) failed"
pass "release_command applied the migrations"

docker run -d --name "$API" --network "$NET" -e "DATABASE_URL=$db_url" "$IMAGE" >/dev/null
healthy=""
for _ in $(seq 1 60); do
  state="$(docker inspect "$API" --format '{{.State.Status}}')"
  if [ "$state" != "running" ]; then break; fi
  if docker exec "$API" wget -q -O /dev/null http://127.0.0.1:3001/api/health 2>/dev/null; then
    healthy=1; break
  fi
  sleep 1
done
if [ -z "$healthy" ]; then
  docker logs "$API" 2>&1 | tail -30 >&2 || true
  fail "node dist/main.js did not reach a healthy /api/health"
fi
pass "node dist/main.js boots and /api/health answers 200 against Postgres"

# Fly's private network (<app>.internal) is IPv6-only, so the server must
# accept connections on an IPv6 address, not just 0.0.0.0. This probes ::1
# inside the container, so it needs IPv6 loopback there: a host/Docker setup
# that disables IPv6 gives a false FAIL, never a false PASS.
docker exec "$API" wget -q -O /dev/null "http://[::1]:3001/api/health" \
  || fail "the api does not answer on IPv6 ([::1]:3001); Fly's .internal network would not reach it"
pass "the api answers on IPv6"

# The image must not run as root.
uid="$(docker exec "$API" id -u)"
[ "$uid" != "0" ] || fail "the api container runs as root (uid 0)"
pass "the api runs as a non-root user (uid $uid)"

printf '\n\033[32mAPI image checks passed\033[0m\n'
