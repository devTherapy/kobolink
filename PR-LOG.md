# Merged pull requests

The audit trail. The orchestrator appends one row per merge; nothing else writes
here. Read top to bottom to follow how the implementation was built.

| # | Feature | Title | PR | Merged |
|---|---|---|---|---|
| 1 | X0 | Monorepo, five CI jobs, shared tooling | https://github.com/devTherapy/kobolink/pull/1 | 2026-09-11 |
| 2 | X1 | packages/contracts — domain types, Zod schemas, money, codes, status | https://github.com/devTherapy/kobolink/pull/3 | 2026-09-11 |
| 3 | B0 | NestJS skeleton, Drizzle wiring, Testcontainers harness, /api/health | https://github.com/devTherapy/kobolink/pull/6 | 2026-09-11 |
| 4 | F0 | Next.js app, design tokens, MSW harness, RTL setup | https://github.com/devTherapy/kobolink/pull/5 | 2026-09-11 |
| 5 | B1 | Schema + migrations, down-migration mechanism, seed | https://github.com/devTherapy/kobolink/pull/7 | 2026-09-11 |
| 6 | F8 | /.well-known AASA + assetlinks.json route handlers | https://github.com/devTherapy/kobolink/pull/10 | 2026-09-11 |
| 7 | X0 | CI: npm run build in the lint-typecheck job | https://github.com/devTherapy/kobolink/pull/16 | 2026-09-11 |
| 8 | F1 | UI kit from the tokens | https://github.com/devTherapy/kobolink/pull/13 | 2026-09-11 |
| 9 | F6 | Public checkout /l/[code], server component | https://github.com/devTherapy/kobolink/pull/11 | 2026-09-11 |
| 10 | B2 | Auth: register, login, logout, session guard, argon2id, rate limit | https://github.com/devTherapy/kobolink/pull/15 | 2026-09-11 |
| 11 | B3 | Links API: create with collision retry, list, get, update status | https://github.com/devTherapy/kobolink/pull/18 | 2026-09-11 |
| 12 | B4 | Public link resolution, unauthenticated | https://github.com/devTherapy/kobolink/pull/22 | 2026-09-11 |
| 13 | F2 | Auth screens, session handling, route protection | https://github.com/devTherapy/kobolink/pull/20 | 2026-09-11 |
| 14 | B5 | Payments as ledger postings — initialize, verify, idempotency | https://github.com/devTherapy/kobolink/pull/25 | 2026-09-12 |
| 15 | B7 | OpenAPI document generated from packages/contracts Zod schemas | https://github.com/devTherapy/kobolink/pull/27 | 2026-09-12 |
| 16 | B6 | SSE dashboard stream fed by Postgres LISTEN/NOTIFY | https://github.com/devTherapy/kobolink/pull/28 | 2026-09-12 |
| 17 | M0 | Android scaffold, Kotlin models from OpenAPI, API client | https://github.com/devTherapy/kobolink/pull/32 | 2026-09-12 |
| 18 | B8 | Phase 2 — wallet accounts, balance derivation, P2P transfer, QR payload | https://github.com/devTherapy/kobolink/pull/31 | 2026-09-12 |
| 19 | fix (B7) | Document GET /api/stream/dashboard; derive the manifest check from AppModule | https://github.com/devTherapy/kobolink/pull/38 | 2026-10-07 |
| 20 | fix (a11y) | Restore visible focus-visible ring on PayForm amount input and Table row button | https://github.com/devTherapy/kobolink/pull/39 | 2026-10-07 |
| 21 | fix (F2) | Login/register no longer 500 on a repeated ?next= key | https://github.com/devTherapy/kobolink/pull/41 | 2026-10-07 |
| 22 | M1 | Android App Links intent filter, URL parsing, routing (Android half) | https://github.com/devTherapy/kobolink/pull/36 | 2026-10-07 |
| 23 | F3 | Dashboard stat strip and links table | https://github.com/devTherapy/kobolink/pull/35 | 2026-10-07 |
| 24 | F4 | Create-link drawer | https://github.com/devTherapy/kobolink/pull/43 | 2026-10-07 |
| 25 | M2 | Android login with EncryptedSharedPreferences session storage | https://github.com/devTherapy/kobolink/pull/37 | 2026-10-07 |
| 26 | B9 | Dashboard stats endpoint | https://github.com/devTherapy/kobolink/pull/44 | 2026-10-07 |
| 27 | F5 | Link detail: QR, copy, status switch with rollback, payments table | https://github.com/devTherapy/kobolink/pull/46 | 2026-10-07 |

---

## Follow-ups

Out-of-scope findings a domain agent or reviewer surfaces while working a row.
Standing rule: nobody (orchestrator or domain agent) spawns a background task
chip for these. A domain agent records the finding in its PR description under
"Deliberately not done" and reports it back here; the orchestrator then either
dispatches it as its own small `fix/<slug>` PR (same gate + review process,
logged as a row above with no PLAN.md feature ID) or lists it below if it isn't
worth a PR yet. Nothing is silently dropped.

| Found in | What | Status |
|---|---|---|
| #38 review | `mountedControllers` (apps/api/src/openapi/mounted-routes.ts) dedupes modules by class, so the same module class registered both plainly and via `forRoot`/`register` can hide a controller from the manifest check. Not an issue with today's AppModule | Open, low |
| #38 review | The generated Kotlin client now has `DashboardApi.streamDashboard(): Response<DashboardEvent>`, which cannot work against an endless SSE stream; only the OpenAPI description warns. Also the description says heartbeat "every 15000ms" but `DASHBOARD_HEARTBEAT_MS` can override it | Open, low; revisit when mobile consumes the stream (M5) |
| #41 PR body | `/l/[code]` has not been audited for `string[]` query values (same class of crash as the F2 `?next=` bug) | Open; small `fix/` row for the frontend agent |
| #41 review | No test covers a signed-in visitor hitting `/login?next=/a&next=/b` (expected: redirect to /dashboard); `next-path.ts` comment misstates Next's `searchParams` type | Open, test/doc only |
| F3 review (#35) | `GET /api/dashboard/stats` has no backend controller, so against the real API every merchant sees the dashboard error screen | Done: B9 merged (#44) |
| F3 review (#35) | `lib/dashboard.ts` turns every `ApiRequestError` (incl. 401 and a customer-role 403) into `DashboardUnavailableError`, so the visitor sees "couldn't reach Kobolink's servers" with a retry that cannot succeed; schema drift is reported the same way | Open; `fix/F3-dashboard-error-classes`, frontend agent, reproduce-first |
| F3 review (#35) | At 375px only the Link column is visible (fixed `max-w-[22rem]`); at 768px 30px of horizontal scroll and the date wraps. Canvas not in repo to compare. Also: `EmptyState as="h3"` skips h2, 7 `role="status"` regions in loading.tsx, `role="alert"` plus focus move in error.tsx, weak assertions in page.test.tsx and LinksTable.test.tsx | Open, low; fold into a future dashboard polish PR |
| M1 review (#36) | Android deep-link defects confirmed on the reviewer's repro: tapping an already-handled link (or one that failed offline) does nothing; a manual lookup can race a deep-link lookup; the Kotlin parser disagrees with contracts' `parseLinkCode` on `%48`-style encoded characters and on a query string containing a space; `parseLinkCode` accepts any host for URIs delivered by explicit intent; the manifest test is string-matching and `MainActivity.onCreate` rotation regression has no test | Must be fixed in M3 (brief the agent with this list; the M3 screen replaces LinkLookupScreen) |
| M1 review (#36) | M1's Done-when (`adb shell pm get-app-links com.folusayo.kobolink` reports verified) needs an emulator and hosted assetlinks.json | Deferred to X3: run it once `pay` is hosted and `ANDROID_SHA256_FINGERPRINTS` is set |
| F4 review (#43) | When creating a link fails on a transport error the form says "if the link appears in your list, it was created", but the list only refreshes on success, so a merchant whose request went through sees nothing until a manual reload and may create a duplicate (reproduced: 502, then Cancel, zero refresh calls). Also: no test pins that a 409 with a code other than `conflict` is not retried; the Checkbox loading state looks like disabled; date field has no `min` | Open; small `fix/F4-transport-failure-refresh` (refresh the list when the drawer closes after a transport failure) |
| B9 review (#44) | `computeLinkStatsBatch` reads one row per payment and binds every link code as a parameter (65,535 limit); no test pins the REPEATABLE READ snapshot; payments are attributed via `metadata->>'linkCode'` | Open, low, scale only; revisit before X3 |
| F5 review (#46) | `error.tsx` (links/[code] and dashboard) reads a `retry` prop; Next 16.3 passes `unstable_retry` (docs: file-conventions/error.md, added 16.2), so "Try again" falls back to `reset()` and cannot re-run the failed fetch. Also: `formatDateTime` lacks `hourCycle: 'h23'` (possible "24:05"; F7 agent fixes it if it touches the file); "Link turned on." announced for a still-expired link and help text "Turn this off" when already off; detail-page figures do not refresh after a toggle; copy fallback moves focus on success; pressed-row contrast 4.12:1; stretched-row link unverified in Safari | Open; `fix/web-error-boundary-retry` (reproduce-first, frontend agent), rest low |
| M3 review (#47) | Not done by design: instrumented deep-link test cannot tell checkout from login and `MainActivity` rotation wiring has no `scenario.recreate()` test (need an emulator); a payer reopening from Recents with no merchant session lands on the merchant login (needs an owner decision) | Open; emulator pass |
| M2 review (#37) | Not done by design: `commit()` writes on the main thread; instrumented test cannot tell apply from commit and has never run; interceptor token-check/clear race; dismissed-link marker lost on process death (SavedStateHandle); LoginScreen `rememberSaveable` and spinner TalkBack label; EncryptedTokenStore construction crash loop on Keystore invalidation and Keystore work in `Application.onCreate`; dead `onLoginSuccess` callback; a non-IO decode error (e.g. date parse) from `/me` could escape `resolve()` (UNCONFIRMED); Back on a deep-linked checkout opens merchant login (given to M3) | Open; revisit with M5 or a hardening row |
