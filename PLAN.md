# Kobolink — build plan

**This file is the shared memory of the build.** Every agent reads it before
starting and updates its own rows when it finishes. It is the only place the
current state of the whole project is written down.

Status values: `todo` · `in-progress` · `in-review` (PR open) · `done` · `blocked`

---

## 1. How the work is split

Three domains, one agent each, plus an orchestrator that dispatches and verifies.

| Domain | Owns | Agent |
|---|---|---|
| **Backend** | `apps/api` — NestJS, Drizzle, Postgres, auth, ledger, SSE | `backend` |
| **Frontend** | `apps/web` — Next.js, screens, `/l/[code]`, `/.well-known/*` | `frontend` |
| **Mobile** | `mobile/ios`, `mobile/android` — native apps, deep links | `ios`, `android` |
| **Cross-cutting** | monorepo, `packages/contracts`, CI, hosting, release | `orchestrator` |

`/.well-known/*` and the server-rendered `/l/[code]` page belong to **frontend**,
not backend — they must be served by the host the universal link names.

---

## 2. The sequencing that makes parallel work possible

```
  WAVE 0  ────────────────  orchestrator alone
  X0 monorepo + CI + hooks
  X1 packages/contracts      ← THE BLOCKER. Nothing starts until this lands.

  WAVE 1  ────────────────  three agents in parallel, each against mocks
  B0 B1 B2 B3 B4        F0 F1 F2 F3        M0 M1
       │                     │                │
  WAVE 2  ────────────────  still parallel
  B5 B6 B7              F4 F5 F6 F7 F8     M2 M3 M4
       │                     │                │
  WAVE 3  ────────────────  orchestrator reassembles
  X2 integration · X3 hosting + domain · X4 release
```

**Why this works.** `packages/contracts` defines every request and response
shape as a Zod schema before any of it is implemented. Backend implements
against it; frontend builds against MSW handlers generated from it; mobile builds
against Swift/Kotlin models generated from the same OpenAPI document. Nobody waits
for anybody. When the pieces meet in Wave 3, they already agree — or they fail to
compile, which is the point.

**The rule that keeps it honest:** a contract change is its own PR, raised by the
orchestrator, and every domain agent re-runs its gate after it merges. No agent
edits `packages/contracts` directly.

---

## 3. Backend — `apps/api`

| ID | Feature | Depends | Done when | Status |
|---|---|---|---|---|
| B0 | NestJS skeleton, Drizzle wiring, Testcontainers harness, `/api/health` | X1 | An integration test boots the app against a real Postgres container and gets 200 | done |
| B1 | Schema + migrations: `users`, `sessions`, `ledger_accounts`, `ledger_entries`, `links`, `idempotency_keys` | B0 | `drizzle-kit` migration runs clean up and down; a seed script populates a merchant | done |
| B2 | Auth: register, login, logout, session guard, argon2id, login rate limit | B1 | Integration tests cover wrong password, unknown user, expired session, revoked session, rate limit trip | done |
| B3 | Links API: create (with collision retry), list, get, update status | B2 | A link created via the API is readable by code; a second merchant gets 404, not 403 | done |
| B4 | Public link resolution `GET /api/links/:code/public`, unauthenticated | B3 | Returns only fields the checkout page renders; disabled/expired/paid resolve to the right state | done |
| B5 | Payments as **ledger postings**: initialize, verify, idempotency | B4 | Entries balance to zero; replaying the same idempotency key is a no-op, not a double charge | done |
| B6 | SSE `/api/stream/dashboard` fed by Postgres `LISTEN/NOTIFY` | B5 | Two subscribers both receive an event; a dropped connection reconnects; heartbeat keeps proxies from killing it | done |
| B7 | OpenAPI document generated from the Zod schemas | B5 | Spec validates; `packages/contracts` and the spec cannot disagree | done |
| B8 | **Phase 2** — wallet accounts, balance derivation, P2P transfer, QR payload | B5 | Transfer is atomic; insufficient funds rejected; balance = sum of entries | done — QR payload is a pure encoder with no route yet, since `packages/contracts` has no QR endpoint; the paying side needs none (transfer already takes the two fields a scanned payload decodes to) |

| B9 | `GET /api/dashboard/stats` — `DashboardStats` for the signed-in merchant, derived from ledger entries | B5 | Integration test: totals equal the sum of the merchant's ledger postings; another merchant's postings are excluded; signed-out is 401; the route is in the OpenAPI manifest | done |

**Non-negotiables.** Money is integer kobo. Every movement is a ledger posting —
no `payments` table with a status column. One `users` table with roles, never a
`merchants` table. Clients never write ledger rows.

---

## 4. Frontend — `apps/web`

| ID | Feature | Depends | Done when | Status |
|---|---|---|---|---|
| F0 | Next.js app, design tokens, MSW harness, RTL setup | X1 | A component test renders against a mocked endpoint with no backend running | done |
| F1 | UI kit from the tokens: Button, Field, Pill, Card, Table, EmptyState, Skeleton | F0 | Every component renders all seven states; `web-design-guidelines` pass is clean | done |
| F2 | Auth screens, session handling, route protection | F1 | Signed-out access to `/dashboard` redirects; a bad password shows the error beside the field | done |
| F3 | Dashboard: stat strip, links table | F2 | Matches the canvas at 375 / 768 / 1024 / 1440; empty and loading states present | done — verified against MSW only at merge; the real stats endpoint landed in B9. 375px shows only the Link column without scrolling (see PR-LOG Follow-ups); the canvas is not in the repo |
| F4 | Create-link drawer | F3 | Validation errors are inline; a duplicate code retries invisibly | done |
| F5 | Link detail: QR, copy, status toggle with optimistic UI, payments table | F3 | Toggle rolls back visibly when the request fails | done — rollback pinned by a held-PATCH test; QR checked structurally, not scanned with a phone |
| F6 | Public checkout `/l/[code]` — **server component**, `generateMetadata`, all non-payable states | F0 | The rendered HTML contains the OG title before any JS runs | done |
| F7 | SSE client → live dashboard | F3 | A payment in another tab moves the numbers without a reload; the stream survives a network blip | done — verified with fake-EventSource tests and a browser check against a stand-in API (payment moves numbers, drop → Reconnecting → Live); exercised against the real `apps/api` stream through the Next proxy by F9 (live, payment moves numbers without reload) |
| F8 | `/.well-known/apple-app-site-association` + `assetlinks.json` route handlers | F0 | Unit tests assert the exact JSON; served unredirected as `application/json` | done |
| F9 | E2E: create link → pay in a fresh context → dashboard updates | F5 F6 F7 | Green on desktop and mobile Playwright projects | done — real Postgres + built API + built web + Chromium (Desktop Chrome, Pixel 7), no MSW; found and fixed an SSE open delay through the Next proxy (first byte now written at once); no decline-path or reconnect-after-blip e2e, Chromium only |

**Non-negotiables.** `/l/[code]` is server-rendered — a client-rendered checkout
has no WhatsApp preview card. The association files are route handlers, never
static files. No component ships with half its states.

---

## 5. Mobile — `mobile/ios`, `mobile/android`

| ID | Feature | Depends | Done when | Status |
|---|---|---|---|---|
| M0 | Scaffold both apps; generate Swift + Kotlin models from the OpenAPI document; API client | B7 | A model change in contracts regenerates and breaks the build if incompatible | done — Android half only (Kotlin models via openapi-generator, Retrofit client), verified the acceptance bar with a real contract-field rename that broke `compileDebugKotlin`; iOS deferred, no Xcode available in this environment |
| M1 | Deep-link wiring: Associated Domains + `autoVerify` intent filter, URL parsing, routing | M0 F8 | Android: `adb shell pm get-app-links com.folusayo.kobolink` reports verified on the emulator | done — Android half only. Code and unit tests merged; the adb verification needs an emulator and the hosted assetlinks.json, so it is deferred to X3. iOS deferred (no Xcode) |
| M2 | Login | M0 B2 | Token stored in Keychain / EncryptedSharedPreferences, never in plain storage | done — Android half only (iOS deferred). Code and 60 JVM tests merged; the instrumented durability test (`connectedDebugAndroidTest`) compiles but has never run, no AVD available; run it when an emulator exists |
| M3 | Checkout screen — the deep-link landing | M1 B4 | Tapping a link opens the app on the right link; Dark Mode and large Dynamic Type both hold | blocked for good — four reviewer BLOCKs (D24 lifted the cap once; it is not lifted again). Round 4 fixed the cold-start slot (one slot per link on the device) but the reviewer found: sign-out does not clear the payer's name, email and amount from the checkout form (`CheckoutFormState.bind(code)` only resets on a code change), so the next person who opens the same link sees them and can send that exact request under a NEW key while the earlier outcome is unknown; and an attempt made while the session is Resolving or Offline is saved with no owner, so the owner-scoped clear on sign-out and on a user change never removes it. Branch `feat/M3-android-checkout` (PR #47, head 7d67abb) holds everything else the reviewers verified (parser parity with contracts, cancellation tests, encrypted per-link slot, backup exclusions, no silent OkHttp retry, Recents). The fixes are small: reset the form on sign-out and user change, and re-own a null-owner slot when the user is confirmed. Needs a decision to lift the cap again |
| M4 | Result states: paid, failed, expired, disabled, already paid | M3 B5 | Every failure names what went wrong and whether money moved | blocked — depends on M3 (blocked) |
| M5 | **Phase 2** — wallet home, send money, scan QR | B8 | — | blocked — three review rounds, three BLOCKs, all on one theme: after a payment's outcome is unknown, a refusal that only applies to the replay (401, a validation 400) or a local storage-write failure is read as proof the original never posted, so the pending record is cleared, the screen says "No money was taken" and a fresh idempotency key is offered (double-pay). Rounds 1-2 fixed null-note on the wire, key dropped on Back, OkHttp silent retry, in-memory-only pending store; branch `feat/M5-android-wallet` (PR #52, head ab6affd) holds the work and all fixes. Fix direction from the reviewer: once an attempt has been sent with an unknown outcome, only a success, or a reply that came back through the idempotency layer, may clear it; every other refusal or local failure keeps Unknown + the same key. Decision D4 (DECISIONS.md): one more attempt with a fresh isolated android agent after M3 and M4 are done; if blocked again M5 stays blocked and ships without the Phase 2 wallet |
| I0 | iOS scaffold (SwiftUI app in `mobile/ios`); Swift models generated from the OpenAPI document; API client. Android half tracked in M0 | B7 | A model change in contracts regenerates and breaks the build if incompatible | done — Xcode 26.3 / iPhone 17: 43 Swift Testing tests + 16 tooling tests; rename proof (`ApiError.message` renamed in the spec, `xcodebuild build` fails); generation runs on every build from a symlink to `apps/api/openapi.json`; never run against the real API; no iOS CI job yet (needs a macOS runner) |
| I1 | iOS deep-link wiring: custom scheme `kobolink://l/{code}` now (needs no entitlement, works in the Simulator), universal-link handling and `applinks:pay.folusayo.com` wired behind it for when a paid Apple Developer account exists; URL parsing, routing; anything unrecognised opens in `SFSafariViewController`. Android half tracked in M1 | I0 F8 | In the Simulator `xcrun simctl openurl booted kobolink://l/{code}` lands on the right link; the parser agrees with contracts' `parseLinkCode` on encoded characters | done — Xcode 26.3 / iPhone 17: 98 Swift tests; parser is a WHATWG byte parser checked against contracts' `parseLinkCode` on a committed 14,172-row table (0 more-permissive cases in 3.5M fuzz inputs); `simctl openurl kobolink://l/{code}` cold and warm start, Dark Mode and AX XXXL checked. Deliberately stricter than the row text: only https on `pay.folusayo.com` (no port or 443) and `kobolink://l/{code}` are links; any other URL goes to the invalid screen, not Safari. Universal-link entitlement is Release-only (a free personal team cannot add Associated Domains); the https path and `onContinueUserActivity` were never run in the Simulator |
| I2 | iOS login. Android half tracked in M2 | I0 B2 | Token stored in the Keychain, never in plain storage (`UserDefaults`, files) | done — Xcode 26.3 / iPhone 17: 193 package tests + 8 tests of the real Keychain in a hosted test target; the app was run against a local stub (login errors, 429 retry-after, expiry, offline resume, reinstall purge, a link over an offline session). Token only in a Keychain generic password (AfterFirstUnlockThisDeviceOnly, not synchronizable); the password is cleared on submit; no silent login retry. Never run against the real API; AutoFill and a locked-Keychain device untested |
| I3 | iOS checkout screen, the deep-link landing. Android half tracked in M3 | I1 B4 | Opening a link lands on the right link; Dark Mode and large Dynamic Type both hold (Simulator screenshots, device named) | done after three review rounds — Xcode 26.3 / iPhone 17: 383 package tests + 22 hosted real-Keychain tests, 25 mutation proofs; Kobo helper checked against contracts' money tests (100+ format, 600+ parse); payer calls carry no token (allow-list compared to the spec's `security`); one Keychain slot per link per device written before the POST leaves; sign-out is gated by a persisted obligation naming (link, key) entries; Start a New Payment opens an empty form; an unreadable obligation has a confirmed 'Reset Checkout Data' exit. Run only against a local stub; never against the real API; VoiceOver by ear, a physical device and iPad untested; the 'Payment started' screen is a stub until I4 |
| I4 | iOS result states: paid, failed, expired, disabled, already paid. Android half tracked in M4 | I3 B5 | Every failure names what went wrong and whether money moved | done — Xcode 26.3 / iPhone 17: 452 package tests + 23 hosted Keychain tests, 7 mutation proofs; verify is the only thing that settles a pending slot (200 success with moneyMoved true, 200 failed with moneyMoved false, or 404/409 with moneyMoved false, for the same reference, link and amount); everything else keeps the slot and offers Check Again; pending is re-asked 2, 4, 8 s then waits for the person; a settled result survives Back and relaunch and is removed on dismissal; expired / disabled / already paid copy matches the web word for word; run against a local stub only. Caveat in PR-LOG: on this simulated gateway verify IS the charge, and the app verifies automatically when a link is reopened with a started payment |
| I5 | **Phase 2** iOS wallet home, send money, scan QR. Android half tracked in M5 (blocked; read its row first) | I2 B8 | — | in review (round 1 fixes pushed) — PR #86: Xcode 26.3 / iPhone 17: 625 package + 43 hosted tests, 18 + 15 mutation proofs; run only against a local stub; a real camera, a physical device, iPad and VoiceOver by ear untested; top-up UI not built |

**iOS is tracked in the I-rows above** (decision D7/D18 in DECISIONS.md: Xcode 26.3 is active, so the earlier "iOS deferred" notes on M0-M2 no longer hold for later work; the M-rows stay Android-only). I2-I5 carry the M5 lessons: a retried payment never gets a new idempotency key, a pending payment is persisted (Keychain) before the request leaves, there is no silent transport retry, and 'no money was taken' is only said when a server refusal proves it. One `xcodebuild`/Simulator run at a time; delete DerivedData and shut the Simulator down afterwards.

**Platform constraints, already established.** iOS universal links need a paid
Apple Developer account; until then M1 ships the custom URL scheme
(`kobolink://l/{code}`) which needs no entitlement and works in the Simulator.
Android is free end to end on the emulator. Neither platform can be built from a
cloud session — these run on the Mac.

**Design.** Native idiom per platform, from the mobile canvas. iOS: SF Pro at
Dynamic Type sizes, semantic system colours, SF Symbols, inset grouped forms.
Android: Material 3, Roboto at the M3 scale, outlined fields, pill buttons.
They are deliberately not the same design and neither is the web page.

---

## 6. Cross-cutting — orchestrator

| ID | Feature | Depends | Done when | Status |
|---|---|---|---|---|
| X0 | Monorepo (npm workspaces), five CI jobs, hooks, agent definitions | — | A failing test fails a PR | done |
| X1 | `packages/contracts` — domain types, Zod schemas, money/code/status | X0 | Both apps import it; changing a shape breaks the other side's typecheck | done — verified after B2/F6: renaming `PaymentLink.paymentCount` fails `apps/web` typecheck, renaming `LoginRequest.password` fails `apps/api` typecheck |
| X2 | Integration: wire web to the real API, mobile to the real API | Wave 2, I0-I5 | MSW handlers deleted from the e2e path; the real journey passes | todo |
| X3 | Hosting, `pay.folusayo.com`, association smoke test | X2 | `scripts/smoke-associations.sh` green against the real domain, including Apple's CDN copy; also run M1's `adb shell pm get-app-links` check once hosted | blocked on the owner — repo prep merged (#69: Dockerfiles for web and api, fly.toml for both, a manual-dispatch deploy workflow with the token as an environment secret behind a required reviewer, docs/DEPLOY.md, image tests proven by running); nothing deployed. Needs the owner-only steps listed once at the top of docs/DEPLOY.md: create the Fly.io account and add payment; the `production` environment with a required reviewer, a main/v* restriction and the FLY_API_TOKEN environment secret; repository variables; app secrets (DATABASE_URL on a direct or session-mode connection, APPLE_APP_ID, ANDROID_SHA256_FINGERPRINTS); the one DNS record for `pay`. Also depends on X2 |
| X4 | Release: tag, changelog from the PR trail | X3 | — | blocked — behind X3 |

---

## 7. Working agreement

One feature, one branch, one PR, one green gate, one merge. Branch names are the
feature ID: `feat/B3-links-api`, `feat/F5-link-detail`.

Every PR description carries: what changed and why · decisions taken and what was
rejected · how it was verified · what is deliberately not done yet.

**Nothing merges without two independent passes.** First the gate — lint,
typecheck, unit, integration-api, integration-web. Then `/code-review` plus the
`reviewer` agent, which sees the diff and the "Done when" condition and nothing
else. A BLOCK goes back to the author; three failed rounds marks the row
`blocked` and the build moves on.

Every merge appends a row to **`PR-LOG.md`** — the audit trail, one line per
feature with the PR link.

**An agent updates its own rows in this file and nothing else.** The orchestrator
owns sections 1, 2, 6 and 7, and is the only writer of `packages/contracts` and
`PR-LOG.md`.
