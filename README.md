# Kobolink

Payment links that open the app when it is installed and a server-rendered
checkout page when it is not.

| | |
|---|---|
| `PLAN.md` | What gets built, in what order, by whom — the operational source of truth |
| `CLAUDE.md` | The working agreement and the non-negotiables |
| `docs/DESIGN-SPEC.md` | The why: architecture, data model, deep links, design |
| `PR-LOG.md` | One row per merged feature, with the PR link |

## Layout

```
packages/contracts   Zod schemas, money, link codes, link status — the single definition
apps/api             NestJS + Drizzle + Postgres: auth, links, the ledger, SSE
apps/web             Next.js: dashboard, the server-rendered /l/[code] checkout, /.well-known/*
mobile/ios           SwiftUI
mobile/android       Kotlin + Material 3
scripts/             Post-deploy smoke test for the deep-link contract
```

## Commands

Requires Node 22 (`.nvmrc`) and Docker for the API integration tests.

```
npm ci
npm run dev          # web on 3000, api on 3001
npm run lint         # eslint --max-warnings 0, every workspace
npm run typecheck    # tsc --noEmit, every workspace
npm run test         # unit — pure logic, no I/O
npm run test:api     # API integration — real Postgres via Testcontainers
npm run test:web     # component tests — RTL + MSW
npm run test:e2e     # Playwright, full stack, desktop + mobile
npm run smoke        # post-deploy deep-link check (DOMAIN, EXPECTED_APP_ID)
```

The same five checks run as blocking jobs in `.github/workflows/ci.yml`.
