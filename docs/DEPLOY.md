# Deploying Kobolink to Fly.io

Status: **prepared, not deployed.** Everything here is written and the images
build and run locally (see "What was verified"); no Fly account, app, secret or
DNS record exists yet. Decisions D8, D19, D20 in `DECISIONS.md` chose Fly.io.

Shape (DESIGN-SPEC §7): two Fly apps, one public hostname.

```
browser ── https://pay.folusayo.com ──▶ kobolink-web (public, Next.js, port 3000)
                                             │  /api/*  rewrite, baked in at build time
                                             ▼
                              http://kobolink-api.internal:3001   (private, NestJS)
                                             ▼
                                         Postgres
```

`kobolink-api` has no public service at all; it is reachable only from other
apps in the same Fly organisation over the private network.

## Owner-only checklist

These are the only steps nobody else can do. Everything after this list is
commands anyone with a token can run.

- [ ] **1. Create the Fly.io account and add payment** at https://fly.io (a
      card is required before machines can run). Install `flyctl` and run
      `fly auth login` on your machine.
- [ ] **2. Create a deploy token and store it as the GitHub secret
      `FLY_API_TOKEN`.** One secret has to cover two apps, so use an
      organisation-scoped token (after step 5, apps exist):
      `fly tokens create org --name github-deploy --expiry 8760h`, then
      GitHub -> Settings -> Secrets and variables -> Actions -> New repository
      secret -> `FLY_API_TOKEN`. (Per-app deploy tokens are narrower but would
      need two secrets; see "Follow-ups".) Until this secret exists the deploy
      workflow fails immediately with a clear message and deploys nothing.
- [ ] **3. Add the GitHub Actions variables** (Settings -> ... -> Variables):
      `DOMAIN` = `pay.folusayo.com`, `EXPECTED_APP_ID` =
      `<APPLE_TEAM_ID>.com.folusayo.kobolink`, optionally `SMOKE_LINK_CODE`.
- [ ] **4. Set the app secrets** (names below; real values from you):
      - api app: `DATABASE_URL`
      - web app: `APPLE_APP_ID` (`<APPLE_TEAM_ID>.com.folusayo.kobolink`, the
        10-character Team ID from your Apple Developer account; the handler
        refuses the `ABCDE12345` placeholder on purpose) and
        `ANDROID_SHA256_FINGERPRINTS` (uppercase, colon-separated, comma
        between several: the debug keystore AND the Play App Signing
        fingerprint)
      - There is no session or cookie signing secret: sessions are opaque
        random tokens looked up by hash (`apps/api/src/auth`), so nothing else
        is required. `NEXT_PUBLIC_IOS_APP_STORE_ID` is optional (a build arg in
        `apps/web/fly.toml`, added once the App Store id exists).
- [ ] **5. Choose the database** (see "Postgres" below) and create it.
- [ ] **6. Add the one DNS record for `pay`.** After `fly certs add
      pay.folusayo.com --app kobolink-web`, Fly prints the exact record. For a
      subdomain that is a **CNAME**: `pay` -> `kobolink-web.fly.dev` (alternative:
      `A`/`AAAA` records to the addresses from `fly ips list --app
      kobolink-web`). Only `pay` is touched; the apex and `www` of
      `folusayo.com` stay as they are. If DNS is on Cloudflare, use **DNS only
      (grey cloud)**: a proxy in front can hand Apple's crawler a challenge page,
      which is exactly what the smoke test's Apple-CDN check catches.

Not required but worth knowing: Apple's CDN fetches the association file
itself, so after the first deploy the iOS check can lag by minutes to hours
(see "Post-deploy checks").

## First-time setup (commands)

Run from the repository root, logged in with `fly auth login`. Nothing here
runs automatically.

```bash
# 1. Create the two apps (names are global on Fly; if taken, pick others and
#    update `app` in both fly.toml files and API_ORIGIN in apps/web/fly.toml).
fly apps create kobolink-api
fly apps create kobolink-web

# 2. Database: pick ONE option from "Postgres", then confirm kobolink-api has
#    the DATABASE_URL secret:
fly secrets list --app kobolink-api

# 3. App secrets. `fly secrets import` reads NAME=value lines from stdin, so
#    values stay out of your shell history. --stage defers the restart until
#    the first deploy.
fly secrets import --stage --app kobolink-web
#   (paste, then Ctrl-D)
#   APPLE_APP_ID=<TEAM_ID>.com.folusayo.kobolink
#   ANDROID_SHA256_FINGERPRINTS=AA:BB:...:FF,11:22:...:99

# 4. First deploy, api first. --ha=false: one machine per app (Fly defaults to
#    two on the first deploy; raise it later with `fly scale count`).
fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile --remote-only --ha=false
fly deploy . --config apps/web/fly.toml --dockerfile apps/web/Dockerfile --remote-only --ha=false

# 5. The certificate, then the DNS record (owner checklist step 6).
fly certs add pay.folusayo.com --app kobolink-web
fly certs show pay.folusayo.com --app kobolink-web     # repeat until "Issued"
```

The first api deploy runs `node dist/db/migrate.js` as its `release_command`
(a temporary machine built from the new image, with the app's secrets). If
that fails the deploy stops and nothing is replaced.

### Postgres

The api needs only `DATABASE_URL` (a `postgres://` URL); it holds no other
database configuration. Pick one, and keep it in the same region as the apps
(`lhr`). Plans and prices change; check https://fly.io/docs/postgres/ and
https://fly.io/pricing before choosing. This repo does not choose a paid plan
for you.

| Option | How | Notes |
|---|---|---|
| Fly Postgres (self-managed, a Fly app) | `fly postgres create --name kobolink-db --region lhr` then `fly postgres attach kobolink-db --app kobolink-api` | `attach` sets the `DATABASE_URL` secret for you. You operate it: backups, upgrades. |
| Fly managed Postgres | `fly mpg create` (see Fly's docs for current flags), then set the connection string it prints | Managed by Fly, billed separately. |
| Any external Postgres (Neon, Supabase, RDS, ...) | `fly secrets import --app kobolink-api` and paste `DATABASE_URL=postgres://...` | Add `?sslmode=require` as the provider documents. It must be reachable from Fly's network. |

Whatever you choose, never commit the URL. `drizzle/` migrations are applied
by the release command on every api deploy; to run them by hand:
`fly console --app kobolink-api -C "node dist/db/migrate.js"` (or
`fly deploy` again).

## Each deploy

Either from GitHub Actions (preferred, needs `FLY_API_TOKEN`) or by hand.

**GitHub Actions** (`.github/workflows/deploy.yml`) runs only on a manual
dispatch (Actions -> deploy -> Run workflow) or when a tag `v*` is pushed,
never on a pull request: it deploys the api, then the web app, then runs the
smoke test as a separate job.

```bash
git tag v0.1.0 && git push origin v0.1.0     # or use "Run workflow"
```

**By hand**, same order and same commands the workflow runs:

```bash
fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile --remote-only
fly deploy . --config apps/web/fly.toml --dockerfile apps/web/Dockerfile --remote-only
DOMAIN=pay.folusayo.com EXPECTED_APP_ID=<TEAM_ID>.com.folusayo.kobolink ./scripts/smoke-associations.sh
```

Rolling back: `fly releases --app kobolink-web` then
`fly deploy --image <previous image ref> --app kobolink-web` (the same for
the api). Migrations are forward-only on deploy; `apps/api/drizzle/*.down.sql`
exist but are never run automatically.

## Post-deploy checks

1. **`scripts/smoke-associations.sh`** (the workflow's `smoke` job). Checks the
   AASA is served unredirected and claims the app and `/l/*`, that **Apple's
   CDN** (`app-site-association.cdn-apple.com/a/v1/<domain>`) has ingested it,
   that `assetlinks.json` names the package with uppercase fingerprints, and
   (with `SMOKE_LINK_CODE`) that `/l/<code>` renders an Open Graph title.
   On a brand-new domain Apple's CDN can 404 for a while: re-run only the
   failed `smoke` job ("Re-run failed jobs") later; no redeploy is needed.
2. **M1's Android check**, on an emulator/device with the release or debug
   build installed, after the domain is live:
   `adb shell pm get-app-links com.folusayo.kobolink`
   expects `pay.folusayo.com: verified`. This is PLAN.md's M1 deferred check.
3. By hand: `curl -sI https://pay.folusayo.com/.well-known/apple-app-site-association`
   shows `200` and `content-type: application/json`, with no `location:`.

## Configuration reference

| Name | Where | Kind |
|---|---|---|
| `DATABASE_URL` | api | **secret** |
| `APPLE_APP_ID`, `ANDROID_SHA256_FINGERPRINTS` | web | **secret** (the values are public once served, but they are per-owner and must not be committed as placeholders) |
| `API_ORIGIN` | web | **build arg + env** in `apps/web/fly.toml` |
| `NEXT_PUBLIC_DASHBOARD_HEARTBEAT_MS` | web | build arg (inlined at build) |
| `DASHBOARD_HEARTBEAT_MS`, `PORT` | api | env in `apps/api/fly.toml` |
| `ANDROID_PACKAGE_NAME`, `NEXT_PUBLIC_LINK_DOMAIN` | web | env in `apps/web/fly.toml` |
| `FLY_API_TOKEN` | GitHub | **secret** |
| `DOMAIN`, `EXPECTED_APP_ID`, `SMOKE_LINK_CODE` | GitHub | variables |

Why `API_ORIGIN` is a **build** argument: Next evaluates `rewrites()` during
`next build` and freezes the result in `.next/routes-manifest.json`. Setting
`API_ORIGIN` only when the server starts would leave the proxy pointing at the
build-time default (`localhost:3001`) and every `/api/*` call would fail in
production. `scripts/test-image-associations.sh` proves the baked-in value is
the one that is used.

Why the heartbeat is 15000 and must stay under 30000: Next's `/api/*` proxy
drops a proxied connection that is idle for 30 seconds. The dashboard SSE
stream (`GET /api/stream/dashboard`) only stays up if a `heartbeat` event goes
through more often than that. The api and web values must be equal because the
browser treats 2.5x the interval of silence as a dead stream.

## Known risks (read before going live)

- **Login rate limiter and `TRUST_PROXY`.** `TRUST_PROXY` is deliberately unset.
  Requests reach the api through Next's proxy, so without it every user's
  per-IP bucket is the web machine's private address: one noisy client can
  exhaust the shared per-IP limit for everybody (the per-email limit still
  applies). Setting `TRUST_PROXY=1` makes the api use the leftmost
  `X-Forwarded-For` entry, which is only safe if the client-supplied header is
  overwritten rather than appended to somewhere upstream; Fly's documentation
  does not state which it does, so this was not guessed. Resolve before real
  traffic (see "Follow-ups").
- **One machine per app** (`--ha=false`) means a deploy or a crash is brief
  downtime for that app. The web app never auto-stops, on purpose (cold starts
  and Apple's CDN fetch).
- **Org-wide token.** The single `FLY_API_TOKEN` is organisation-scoped.

## What was verified (and what only written)

Verified locally on the built images: the web image serves both association
files unredirected as `application/json` with exact JSON and proxies `/api/*`
to the build-time origin (`scripts/test-image-associations.sh`); the api image
runs as non-root, applies migrations with `node dist/db/migrate.js` against a
real Postgres, listens on IPv6 as well as IPv4 (needed for `.internal`), and
answers its healthcheck. Only written, never executed: both `fly.toml` files,
`.github/workflows/deploy.yml`, every `fly` command above, DNS, certificates,
the smoke test against the real domain, and the Android `adb` check.

## Follow-ups

- Decide `TRUST_PROXY` (above), e.g. by having Next forward Fly's
  `Fly-Client-IP` and the api reading only that.
- Per-app deploy tokens (two secrets) instead of one org token.
- A staging app pair and a `workflow_dispatch` input to pick the target.
- Scale the apps out (`fly scale count 2`) once the database is HA.
