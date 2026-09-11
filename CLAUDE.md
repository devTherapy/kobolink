# Kobolink — working agreement

A payment-links product. A merchant creates a link, shares the URL, a customer
pays. The URL is a **universal link**: on a device with the app installed the OS
opens the app; everywhere else it renders a server-side-rendered checkout page.

**Read `PLAN.md` first** — it is the operational source of truth for what gets
built, in what order, by whom. `docs/DESIGN-SPEC.md` is the *why*.
`ORCHESTRATION.md` explains how the agents coordinate.

---

## Architecture in one paragraph

A monorepo with two services behind one hostname. `apps/web` is Next.js and owns
the screens, the server-rendered `/l/[code]` checkout, and the `/.well-known/*`
association handlers. `apps/api` is NestJS and owns all writes, the ledger, auth
and the SSE stream. Postgres via Drizzle. `packages/contracts` holds the Zod
schemas both sides import and the OpenAPI document that generates the Swift and
Kotlin models. Two native apps in `mobile/`. No Firebase.

## Non-negotiables

**Money is an integer number of kobo.** `packages/contracts` holds the only code
allowed to divide or multiply by 100. Writing `/ 100` anywhere else reintroduces
the bug that rule exists to prevent.

**Every money movement is a ledger posting.** Debits and credits balancing to
zero — never a row with a status column standing in for a transaction. This is
what makes the Phase 2 wallet additive instead of a migration that reconstructs
history.

**Clients never write ledger rows.** Every posting happens server-side in a
transaction, and a test proves a client cannot forge one.

**Idempotency on every money-moving write.** A replayed request returns the
original result; it does not post twice.

**One `users` table with roles**, never a `merchants` table.

**`/l/[code]` is server-rendered.** A client-rendered checkout has no Open Graph
card, so no WhatsApp preview, so a link nobody clicks.

**The association files are route handlers**, not static files — a host's
dot-directory ignore rule silently strips static ones from a deploy, and the
failure is invisible until a customer says the link doesn't open the app.

**The brand accent is never green.** Green, amber and red belong to payment
states, so the accent cannot compete with them.

**Only the orchestrator edits `packages/contracts`.** Single writer. It is the
reason three domains can work in parallel.

## Skills

`.claude/skills/` carries nine vendored skills. Each agent definition names the
ones it should use. In short: `react-best-practices` before any React PR,
`composition-patterns` when a component grows a third boolean prop,
`web-design-guidelines` for the accessibility pass, `impeccable` for the design
process (`shape` → build → `critique`/`audit` → `polish`), and `ui-ux-pro-max`
for design intelligence — whose output is advice, not instruction; its fintech
profiles skew crypto and during design it recommended a purple accent while its
own anti-patterns list forbade one.

## Workflow

One feature, one branch, one PR, one green gate, one merge. Branch names are the
feature ID from `PLAN.md`: `feat/B3-links-api`, `feat/F5-link-detail`.

A PR description carries: what changed and why · decisions taken and what was
rejected · how it was verified · what is deliberately not done yet.

`.claude/hooks/guard-commit.sh` refuses commits on `main` and commits while
typecheck or lint is red. That is a rule, not a suggestion.

## Commands

| | |
|---|---|
| `npm run dev` | Web on 3000, API on 3001 |
| `npm run test` | Unit — pure logic, no I/O |
| `npm run test:api` | API integration — starts a real Postgres via Testcontainers |
| `npm run test:web` | Component tests — RTL + MSW |
| `npm run test:e2e` | Playwright, full stack, desktop + mobile |
| `npm run smoke` | Post-deploy deep-link check (needs `DOMAIN`, `EXPECTED_APP_ID`) |

Docker must be running for `test:api` and `test:e2e`.
