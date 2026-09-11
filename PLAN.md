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
| B1 | Schema + migrations: `users`, `sessions`, `ledger_accounts`, `ledger_entries`, `links`, `idempotency_keys` | B0 | `drizzle-kit` migration runs clean up and down; a seed script populates a merchant | todo |
| B2 | Auth: register, login, logout, session guard, argon2id, login rate limit | B1 | Integration tests cover wrong password, unknown user, expired session, revoked session, rate limit trip | todo |
| B3 | Links API: create (with collision retry), list, get, update status | B2 | A link created via the API is readable by code; a second merchant gets 404, not 403 | todo |
| B4 | Public link resolution `GET /api/links/:code`, unauthenticated | B3 | Returns only fields the checkout page renders; disabled/expired/paid resolve to the right state | todo |
| B5 | Payments as **ledger postings**: initialize, verify, idempotency | B4 | Entries balance to zero; replaying the same idempotency key is a no-op, not a double charge | todo |
| B6 | SSE `/api/stream/dashboard` fed by Postgres `LISTEN/NOTIFY` | B5 | Two subscribers both receive an event; a dropped connection reconnects; heartbeat keeps proxies from killing it | todo |
| B7 | OpenAPI document generated from the Zod schemas | B5 | Spec validates; `packages/contracts` and the spec cannot disagree | todo |
| B8 | **Phase 2** — wallet accounts, balance derivation, P2P transfer, QR payload | B5 | Transfer is atomic; insufficient funds rejected; balance = sum of entries | todo |

**Non-negotiables.** Money is integer kobo. Every movement is a ledger posting —
no `payments` table with a status column. One `users` table with roles, never a
`merchants` table. Clients never write ledger rows.

---

## 4. Frontend — `apps/web`

| ID | Feature | Depends | Done when | Status |
|---|---|---|---|---|
| F0 | Next.js app, design tokens, MSW harness, RTL setup | X1 | A component test renders against a mocked endpoint with no backend running | in-progress |
| F1 | UI kit from the tokens: Button, Field, Pill, Card, Table, EmptyState, Skeleton | F0 | Every component renders all seven states; `web-design-guidelines` pass is clean | todo |
| F2 | Auth screens, session handling, route protection | F1 | Signed-out access to `/dashboard` redirects; a bad password shows the error beside the field | todo |
| F3 | Dashboard: stat strip, links table | F2 | Matches the canvas at 375 / 768 / 1024 / 1440; empty and loading states present | todo |
| F4 | Create-link drawer | F3 | Validation errors are inline; a duplicate code retries invisibly | todo |
| F5 | Link detail: QR, copy, status toggle with optimistic UI, payments table | F3 | Toggle rolls back visibly when the request fails | todo |
| F6 | Public checkout `/l/[code]` — **server component**, `generateMetadata`, all non-payable states | F0 | The rendered HTML contains the OG title before any JS runs | todo |
| F7 | SSE client → live dashboard | F3 | A payment in another tab moves the numbers without a reload; the stream survives a network blip | todo |
| F8 | `/.well-known/apple-app-site-association` + `assetlinks.json` route handlers | F0 | Unit tests assert the exact JSON; served unredirected as `application/json` | todo |
| F9 | E2E: create link → pay in a fresh context → dashboard updates | F5 F6 F7 | Green on desktop and mobile Playwright projects | todo |

**Non-negotiables.** `/l/[code]` is server-rendered — a client-rendered checkout
has no WhatsApp preview card. The association files are route handlers, never
static files. No component ships with half its states.

---

## 5. Mobile — `mobile/ios`, `mobile/android`

| ID | Feature | Depends | Done when | Status |
|---|---|---|---|---|
| M0 | Scaffold both apps; generate Swift + Kotlin models from the OpenAPI document; API client | B7 | A model change in contracts regenerates and breaks the build if incompatible | todo |
| M1 | Deep-link wiring: Associated Domains + `autoVerify` intent filter, URL parsing, routing | M0 F8 | Android: `adb shell pm get-app-links com.folusayo.kobolink` reports verified on the emulator | todo |
| M2 | Login | M0 B2 | Token stored in Keychain / EncryptedSharedPreferences, never in plain storage | todo |
| M3 | Checkout screen — the deep-link landing | M1 B4 | Tapping a link opens the app on the right link; Dark Mode and large Dynamic Type both hold | todo |
| M4 | Result states: paid, failed, expired, disabled, already paid | M3 B5 | Every failure names what went wrong and whether money moved | todo |
| M5 | **Phase 2** — wallet home, send money, scan QR | B8 | — | todo |

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
| X1 | `packages/contracts` — domain types, Zod schemas, money/code/status | X0 | Both apps import it; changing a shape breaks the other side's typecheck | done |
| X2 | Integration: wire web to the real API, mobile to the real API | Wave 2 | MSW handlers deleted from the e2e path; the real journey passes | todo |
| X3 | Hosting, `pay.folusayo.com`, association smoke test | X2 | `scripts/smoke-associations.sh` green against the real domain, including Apple's CDN copy | todo |
| X4 | Release: tag, changelog from the PR trail | X3 | — | todo |

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
