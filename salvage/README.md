# Salvage

Code from the Firebase-era build that survived the move to Postgres + NestJS
**unchanged**. It has been typechecked, linted and tested; the association
handlers were served live and curled.

Delete this folder once the frontend agent has placed the `web/` files (F0,
F8). `contracts/`, `scripts/` and `env.example` were placed by X0 and X1 and
removed from here.

| File | Goes to | Why it survived |
|---|---|---|
| `contracts/src/money.ts` | `packages/contracts/src/` | Pure kobo arithmetic. The only place `/100` may appear. |
| `contracts/src/code.ts` | `packages/contracts/src/` | Short-code alphabet with the mistranscribed characters removed (no 0/O/1/l/I) |
| `contracts/src/status.ts` | `packages/contracts/src/` | `resolveLink()` — the single answer to "is this payable". Web, API and both mobile apps must agree, so it lives in contracts |
| `contracts/tests/*.test.ts` | `packages/contracts/tests/` | 44 passing tests across money, code, status, associations |
| `web/associations.ts` | `apps/web/src/lib/` | AASA + assetlinks builders, pure and testable |
| `web/well-known/aasa.route.ts` | `apps/web/src/app/.well-known/apple-app-site-association/route.ts` | Must stay in the web app: served by the host the universal link names |
| `web/well-known/assetlinks.route.ts` | `apps/web/src/app/.well-known/assetlinks.json/route.ts` | Same |
| `web/globals.css` | `apps/web/src/app/` | The design tokens. Extend, don't replace |
| `web/layout.tsx` | `apps/web/src/app/` | `next/font` self-hosting IBM Plex; needs network at **build** time |
| `web/associations.spec.ts` | `apps/web/e2e/` | Deep-link contract, 2 passing Playwright tests |
| `scripts/smoke-associations.sh` | `scripts/` | Post-deploy check including Apple's CDN endpoint |
| `env.example` | `.env.example`, after removing the Firebase block | Domain and bundle identifiers are already correct |

## Deliberately not salvaged

`firestore.rules`, `firestore.indexes.json`, `firebase.json`, the Firestore rules
test suite, `src/lib/firebase/*`, `src/lib/links.ts`, `src/lib/checkout.ts`, and
the two `/api/checkout/*` route handlers. All Firestore-specific or superseded by
the NestJS API.

## One thing to check first

`layout.tsx` uses `next/font/google`, which fetches at **build** time. That
worked nowhere in the authoring container, so this one file was verified by
building with the font call stubbed. It will work on your machine and in CI — but
if your first `next build` fails, check the network before suspecting the code.
