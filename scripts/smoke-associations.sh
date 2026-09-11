#!/usr/bin/env bash
# Post-deploy smoke test for the deep-link contract.
#
# Association files break on deploy, silently, and you find out days later when
# a customer says "the link doesn't open the app". This runs on every
# production deploy so you find out in ninety seconds instead.
#
# Usage: DOMAIN=pay.folusayo.com EXPECTED_APP_ID=ABCDE12345.com.folusayo.kobolink ./scripts/smoke-associations.sh
set -euo pipefail

: "${DOMAIN:?DOMAIN is required}"
: "${EXPECTED_APP_ID:?EXPECTED_APP_ID is required}"
: "${EXPECTED_PACKAGE:=com.folusayo.kobolink}"

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# --- 1. Our own server -------------------------------------------------------
code=$(curl -sS -o "$work/aasa.json" -w '%{http_code}' \
       "https://$DOMAIN/.well-known/apple-app-site-association")
[ "$code" = "200" ] || fail "AASA returned HTTP $code from our own server"

# A 301/302 anywhere in the chain fails Apple's validation outright. Follow
# redirects here so the count reflects the whole chain; the unfollowed fetch
# above already rejected a 3xx from the origin itself.
redirects=$(curl -sSL -o /dev/null -w '%{num_redirects}' \
            "https://$DOMAIN/.well-known/apple-app-site-association")
[ "$redirects" = "0" ] || fail "AASA is served through $redirects redirect(s); Apple requires none"

jq -e --arg id "$EXPECTED_APP_ID" \
   '.applinks.details[0].appIDs | index($id)' "$work/aasa.json" >/dev/null \
   || fail "AASA does not claim $EXPECTED_APP_ID"

jq -e '[.applinks.details[0].components[] | select(."/" == "/l/*")] | length > 0' \
   "$work/aasa.json" >/dev/null || fail "AASA does not claim the /l/* path"

jq -e '.applinks.details[0] | has("paths") | not' "$work/aasa.json" >/dev/null \
   || fail "AASA mixes the legacy paths array with components (TN3155 forbids this)"
pass "AASA served correctly by our origin"

# --- 2. Apple's CDN — the check that actually matters ------------------------
# Step 1 passing while this 404s is the real production failure: our file is
# fine but Apple's crawler is timing out, being geo-blocked, or getting an HTML
# challenge page from whatever sits in front of the domain. Nothing on our own
# infrastructure reveals that.
cdn_code=$(curl -sS -D "$work/cdn.head" -o "$work/cdn.json" -w '%{http_code}' \
           "https://app-site-association.cdn-apple.com/a/v1/$DOMAIN" || echo 000)

if [ "$cdn_code" != "200" ]; then
  echo "--- Apple CDN diagnostics ---" >&2
  grep -i '^apple-' "$work/cdn.head" >&2 || echo "(no Apple-* headers returned)" >&2
  fail "Apple's CDN has no valid copy of our AASA (HTTP $cdn_code)"
fi

if ! diff -q <(jq -S . "$work/aasa.json") <(jq -S . "$work/cdn.json") >/dev/null; then
  # The CDN can lag our server by up to ~24h, so a mismatch on a fresh deploy
  # is informational; a mismatch a day later is a genuine failure.
  printf '\033[33mwarn\033[0m  Apple CDN copy differs from ours (expected for up to 24h after a change)\n'
else
  pass "Apple's CDN copy matches ours"
fi

# --- 3. Android --------------------------------------------------------------
code=$(curl -sS -o "$work/assetlinks.json" -w '%{http_code}' \
       "https://$DOMAIN/.well-known/assetlinks.json")
[ "$code" = "200" ] || fail "assetlinks.json returned HTTP $code"
jq -e --arg pkg "$EXPECTED_PACKAGE" \
   '.[0].target.package_name == $pkg' "$work/assetlinks.json" >/dev/null \
   || fail "assetlinks.json does not name $EXPECTED_PACKAGE"
jq -e '.[0].target.sha256_cert_fingerprints | length > 0' "$work/assetlinks.json" >/dev/null \
   || fail "assetlinks.json carries no fingerprints"
# `all` over the array, not a length comparison against itself — the latter
# can never fail. Lowercase or truncated fingerprints verify locally and fail
# silently in production, which is the failure this line exists to catch.
jq -e '.[0].target.sha256_cert_fingerprints
       | all(test("^([0-9A-F]{2}:){31}[0-9A-F]{2}$"))' "$work/assetlinks.json" >/dev/null 2>&1 \
   || fail "assetlinks.json has a malformed or lowercase fingerprint"
pass "assetlinks.json served correctly"

# --- 4. The deep-link target itself renders ----------------------------------
if [ -n "${SMOKE_LINK_CODE:-}" ]; then
  body=$(curl -sS "https://$DOMAIN/l/$SMOKE_LINK_CODE")
  echo "$body" | grep -qi 'og:title' || fail "/l/$SMOKE_LINK_CODE has no Open Graph title"
  pass "deep-link target renders with a link-preview card"
fi

printf '\n\033[32mAll deep-link checks passed for %s\033[0m\n' "$DOMAIN"
