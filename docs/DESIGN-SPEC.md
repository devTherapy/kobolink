# Kobolink — Design Specification

*A payment-links product built to learn React/Next.js, CI/CD, and universal links.*

Version 0.4 · 11 September 2026

> **Architecture changed on 10–11 September.** Firebase is gone: Postgres for
> state, a separate NestJS API, our own auth, SSE for live updates. Sections 2,
> 3, 5, 7, 8, 9 and 10 below were rewritten. Sections **6 (deep links)** and
> **11 (visual design)** were unaffected and remain authoritative.
>
> **`PLAN.md` at the repo root is the operational source of truth** for what
> gets built, in what order, by whom. This document is the *why*.

## 1. What we are building

A merchant creates a payment link. They share the URL over WhatsApp. A customer opens it:

- **App installed** → the OS hands the URL to the mobile app, which opens the checkout screen natively.
- **App not installed** → the browser renders a server-side-rendered checkout page with a proper link-preview card.

Either way the payment is recorded as a ledger posting and the merchant's dashboard updates in real time over SSE.

This is a deliberately small slice of a product you already understand end to end. The learning value is in the mechanics around it, not in figuring out the domain.

### Why this shape

| Constraint | Consequence |
|---|---|
| Deep link must resolve to a page | Target page must be **public and unauthenticated** — otherwise you need deferred deep linking (stash destination → auth → resume), which is a bad first fight |
| Link shared into WhatsApp/Slack | Needs Open Graph meta tags in the initial HTML → **server rendering** → Next.js, not a Vite SPA |
| Firebase Dynamic Links is shut down | We hand-roll association files. Better outcome: you learn what FDL was hiding |

### Non-goals

- Real money. Payments are simulated with an initialize/verify flow that mirrors the shape of the real Paystack API.
- A full mobile app. iOS and Android are **stubs** that prove the handoff and route to one screen.
- Multi-currency. NGN only.

---

## 2. Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | Next.js (App Router), TypeScript strict | SSR for the deep-link target; TS because the goal is reviewing generated code |
| Backend | **NestJS 12**, separate service | DI, modules and guards map onto ASP.NET Core; a real boundary to reason across |
| Database | **Postgres** | Runs anywhere in Docker, so every test is executable locally and in CI |
| Data access | **Drizzle** | Essentially typed SQL — Prisma's abstraction would fight a SQL-strong author |
| Auth | **Our own.** argon2id, opaque session in an httpOnly cookie for web; bearer tokens for mobile | Transferable knowledge; no vendor lock |
| Live updates | **SSE**, driven by Postgres `LISTEN/NOTIFY` | One-way server→client. WebSockets solve a bidirectional problem we don't have |
| Shared types | `packages/contracts` — Zod schemas → OpenAPI → Swift/Kotlin models | One definition across four languages; drift becomes a compile error |
| Hosting | API and web behind **one hostname** (`pay.folusayo.com`, API at `/api/*`) | First-party cookies. Cross-site cookies are blocked by default in modern Safari |
| Tests | Vitest · Testcontainers · RTL + MSW · Playwright | See §8 |
| Mobile | SwiftUI + Kotlin, native idiom per platform | Not stubs: login, checkout, and Phase 2 wallet |

**What Firebase's departure bought us.** The Firestore emulator downloads from a
host that was blocked in the authoring environment, so its rules tests could
never be run. Postgres in Docker runs everywhere. Security rules were also a
Firebase-specific DSL that transfers nowhere; auth guards and SQL transfer
everywhere.

**Name:** *Kobolink* — kobo being the subunit, and money is stored in kobo throughout.

## 3. Data model

### Money rule

**All amounts are integers in kobo. No floats anywhere.** `formatNaira` and
`parseNaira` in `packages/contracts` are the only code allowed to divide or
multiply by 100.

### The decision the whole schema turns on

**Every money movement is a ledger posting — including a Phase 1 link payment.**
Not a `payments` row with a status column.

```
users            id · role · phone · email · password_hash · created_at
sessions         id · user_id · expires_at · revoked_at · user_agent
ledger_accounts  id · owner_user_id · kind (wallet | merchant_receivable |
                 external_funding) · currency
ledger_entries   id · posting_id · account_id · amount_kobo (signed) ·
                 created_at        -- entries within a posting sum to zero
postings         id · kind (link_payment | transfer | topup) · reference ·
                 idempotency_key · metadata · created_at
links            code (PK) · merchant_user_id · title · description ·
                 amount_kobo NULL · status · is_reusable · expires_at · created_at
idempotency_keys key · request_hash · response · created_at
```

**Why.** A wallet is then just another `ledger_accounts.kind`, and a
peer-to-peer transfer is just another posting pair. Phase 2 is additive. Ship
the alternative and Phase 2 becomes a migration that reconstructs history.

**One `users` table with a role**, never a `merchants` table: a customer paying
by QR and a merchant collecting are the same entity with different capabilities.

**`links.code` is the primary key**, so resolving `/l/{code}` is one indexed
lookup and the database enforces uniqueness. Collisions are handled by the
insert failing and the caller retrying, not by hoping.

**Balances are derived** from `ledger_entries`, with a materialised balance and
an invariant check rather than a number anyone can write directly.

## 4. Pages

Three substantive pages, plus a login route. I am counting honestly: `/login` is a fourth route, but it is a form and a redirect, not a page with a design.

### 4.1 `/dashboard` — Merchant home (authenticated)

- Stat row: total collected, payment count, active links — read from link docs, not computed client-side
- Table of the merchant's links: title, amount, status, payment count, created date
- "New link" opens a drawer with the create form
- Real-time: an SSE subscription to `/api/stream/dashboard`, so a link created in another tab appears here

**React lesson:** client component, an `EventSource` opened inside a `useEffect` with correct cleanup, wrapped in a `useLinks()` hook. The cleanup function is where most generated code is wrong — it leaks the connection on unmount, and you will be able to see it.

### 4.2 `/dashboard/links/[code]` — Link detail (authenticated)

- The link URL with a copy button and a QR code
- Toggle active/disabled
- Payments table for this link, paginated, real-time
- A "test on device" panel showing the exact deep-link URL

**React lesson:** dynamic route params, optimistic UI on the status toggle (flip immediately, reconcile or roll back), and cursor pagination against a live listener — which is genuinely awkward and worth doing once by hand.

### 4.3 `/l/[code]` — Public checkout (unauthenticated) ← **the deep-link target**

- Server component. Fetches the link with the Admin SDK at request time.
- Renders merchant name, title, amount, and a payer form.
- `generateMetadata` produces the Open Graph card: `"Pay ₦5,000 to Adebayo Stores"`.
- Handles: link not found (404), disabled, expired, already paid (non-reusable).
- Includes the iOS Smart App Banner meta tag as the honest, zero-cost "get the app" nudge.

**React lesson:** the server/client boundary. The page shell is a server component; the payment form is a `"use client"` island. This split is the single most misunderstood thing in App Router code, and generated code gets it wrong constantly.

### Payment flow (mirrors Paystack's shape deliberately)

```
POST /api/checkout/initialize   { code, amountKobo, payerName, payerEmail }
  → validates link is active, not expired, amount matches if fixed
  → creates payments/{id} with status "pending", returns { reference }

POST /api/checkout/verify       { reference }
  → simulated gateway result (success unless the payer email starts with "fail@")
  → updates payment to success/failed, sets completedAt
  → Cloud Function onUpdate increments the link counters
```

The client never writes to `payments` directly. If it could, anyone could forge a successful payment by opening the console — which is exactly the class of bug security rules exist to prevent, and which a rules test will assert.

---

## 5. Auth and authorisation

Firestore security rules are gone. The boundary is now ordinary server-side code,
which is both more transferable and easier to test.

| Concern | Mechanism | Risk it addresses |
|---|---|---|
| Password storage | **argon2id** | A stolen database yields nothing |
| Web session | Opaque id in an httpOnly, Secure, SameSite=Lax cookie; row in `sessions` | XSS cannot read it; logout genuinely revokes |
| Mobile session | Short-lived bearer token + refresh, stored in Keychain / EncryptedSharedPreferences | Native apps have no cookie jar worth relying on |
| Login abuse | Rate limit per phone and per IP | Credential stuffing |
| Ledger integrity | Every posting written server-side inside a transaction | A client cannot forge a payment |
| Replay | `idempotency_keys` on every money-moving write | A retried request is a no-op, not a double charge |

**Deliberately no JWT for the web app.** The merchant dashboard is the only
authenticated browser surface, and cookie sessions are simpler *and* safer for
it — JWTs cannot be revoked. Tokens exist for mobile because mobile needs them.

**Rolling our own auth is defensible here** — no real users, no real money, and
the author has built JWT/RBAC/field-encryption systems professionally. It would
not be defensible in production without a security review.

**Public by design:** `GET /api/links/:code` is unauthenticated, because the
deep-link target must resolve for a stranger. It returns only the fields the
checkout page renders. Nothing private may be added to that response.

## 6. Deep-link architecture

This is the part with the most ways to fail silently, so it gets the most CI attention.

### 6.1 URL contract

| Pattern | Opens in app | Web fallback |
|---|---|---|
| `https://pay.folusayo.com/l/*` | Yes → checkout screen | Public checkout page |
| `https://pay.folusayo.com/dashboard*` | No | Merchant dashboard |
| `https://pay.folusayo.com/.well-known/*` | No — must never be claimed | The association files themselves |

### 6.2 `/.well-known/apple-app-site-association`

Served by a **Route Handler**, not a static file, so it can read the Team ID from an environment variable and be unit-tested:

```
app/.well-known/apple-app-site-association/route.ts
```

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TEAM_ID>.com.folusayo.kobolink"],
        "components": [
          { "/": "/l/*", "comment": "Payment link" },
          { "/": "/.well-known/*", "exclude": true }
        ]
      }
    ]
  }
}
```

The `appIDs` + `components` format requires **iOS 13+**. The legacy `appID` + `paths` array still works, but Apple's TN3155 warns explicitly against **mixing the two formats in one file** — it produces undefined behaviour. We use components only.

Hard requirements, each of which has broken someone's launch:

- Served over **HTTPS with a valid cert and no redirects** — a 301/302 fails validation outright
- **No file extension** on the path
- Reachable from **every IP and region**, and must not vary by User-Agent (Apple added this to TN3155 in May 2025 — CDN geo-filtering or bot protection in front of your domain will break it)
- `Content-Type: application/json` is good practice but is **not** actually a documented Apple requirement any more. Set it anyway; do not treat it as the diagnosis when something breaks.
- Do not sign the file. Signing was an iOS 8 thing and plain JSON has been correct since iOS 9.
- Since iOS 14, the device fetches from **Apple's CDN**, not from your server. The CDN pulls within ~24h, devices re-check roughly weekly, and **there is no way to invalidate it**. During development, turn on Developer Mode plus *Settings → Developer → Universal Links → Associated Domains Development* and append `?mode=developer` to the entitlement (`applinks:pay.folusayo.com?mode=developer`) with a development-signed build. That same Settings screen has a Diagnostics tool that will tell you why a specific URL is not matching.
- Verify locally before deploying: `sudo swcutil verify -d pay.folusayo.com -j <file> -u <url>`

### 6.3 `/.well-known/assetlinks.json`

Also a route handler, reading the signing fingerprint from an env var:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.folusayo.kobolink",
    "sha256_cert_fingerprints": ["<UPPERCASE_COLON_SEPARATED_SHA256>"]
  }
}]
```

`sha256_cert_fingerprints` is an array precisely so you can list **both** the local debug fingerprint and the Play App Signing fingerprint. With Play App Signing, the fingerprint from your local `keytool` is **not** the one that ships — take the real one from *Play Console → Release → Setup → App signing*, which also hands you a ready-made JSON snippet. Getting this wrong means verification passes on your machine and fails in production.

### 6.4 iOS app (SwiftUI)

1. Associated Domains capability: `applinks:pay.folusayo.com`
2. `.onOpenURL { url in ... }` at the app root
3. Parse `/l/{code}`, `GET /api/links/{code}`, render the native checkout screen
4. Anything unrecognised → open in `SFSafariViewController` rather than dropping it

### 6.5 Android app (Kotlin)

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="pay.folusayo.com" android:pathPrefix="/l/" />
</intent-filter>
```

Verify with `adb shell pm get-app-links com.folusayo.kobolink` — it prints per-host verification state and is the fastest way to discover a wrong fingerprint. On Android 12+, `pm set-app-links --package com.folusayo.kobolink 0 all` resets the state and `pm verify-app-links --re-verify com.folusayo.kobolink` forces another attempt.

### 6.6 Testing without an Apple Developer Program membership

Universal links cannot be tested end to end on a physical iPhone without the paid membership — TestFlight, Ad Hoc and Enterprise are all membership-gated, and there is no legitimate way around that. But the work splits in two, and only the second half is gated:

| Half | Needs paid account? | How we test it |
|---|---|---|
| **The web contract** — AASA correctness, CDN ingestion, path-pattern matching | **No** | `swcutil` + the public CDN endpoint |
| **The entitlement handshake** — *this signed app* claims *that domain* | **Yes** | Physical device, paid team |

Essentially every real bug lives in the first half.

**Free tools that cover it completely:**

```bash
# Validate the file and test a specific URL against the components patterns
sudo swcutil verify -d pay.folusayo.com -j ./aasa.json -u https://pay.folusayo.com/l/ABC123

# Force this Mac to fetch the domain through Apple's real CDN path
sudo swcutil dl -d pay.folusayo.com

# Inspect what Apple's CDN actually holds — public, no auth, no account
curl -i https://app-site-association.cdn-apple.com/a/v1/pay.folusayo.com
```

`swcutil` ships with macOS; it is not gated behind the Developer Program.

**What the free personal team cannot do:** Adding the Associated Domains capability in Xcode fails outright — *"Personal development teams do not support the Associated Domains capability."* Any capability requiring Apple to register a service on the App ID is blocked. Other free-team limits: 7-day profile expiry, 10 App IDs per rolling 7 days, ~3 registered devices.

**The Simulator is a trap, not a workaround.** Simulator builds are ad-hoc signed with no provisioning profile, so hand-editing `.entitlements` to add `com.apple.developer.associated-domains` does produce a build carrying it. But it is undocumented, and Apple's own forums carry open threads on universal links failing in recent Xcode simulators with `simctl openurl` falling through to Safari. Do not spend days there.

**Development strategy, then:**

1. **Custom URL scheme as the dev-time stand-in.** `kobolink://l/ABC123` needs no entitlement, no associated domain, no server file — just `CFBundleURLTypes` in `Info.plist`. Works on a free team and in the Simulator. It exercises the entire *routing* half of the app (parse URL → fetch link → render screen), which is the code we are actually writing. Switching to universal links later changes one delegate method, not the architecture.
2. **Android carries the end-to-end proof** (§6.5.1).
3. **Enroll when milestone 8 arrives**, or get added as a Developer-role member of an existing paid team — that costs nothing and grants development profiles with Associated Domains.

### 6.6.1 Android without a physical device

The Android Emulator verifies App Links properly — domain verification is done by a platform system component (`com.android.statementservice`), not by anything Google-account-gated. No physical device and no $25 Play account are needed.

```bash
# Use a Google APIs system image; bare AOSP images have reported flakiness
sdkmanager "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n kobolink -k "system-images;android-35;google_apis;arm64-v8a"
emulator -avd kobolink

# Install the debug build, wait ~20s for async verification, then check
adb install app-debug.apk
adb shell pm get-app-links com.folusayo.kobolink

# Simulate the real tap
adb shell am start -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d "https://pay.folusayo.com/l/ABC123"
```

Requirements: the emulator needs network reachability to your domain, and your debug keystore's SHA-256 (`~/.android/debug.keystore`) must be in the `assetlinks.json` array.

**The local-development escape hatch:** for a domain you cannot yet serve — before DNS is pointed, or against a local dev server —

```bash
adb shell pm set-app-links --package com.folusayo.kobolink 1 pay.folusayo.com
```

force-approves the domain and bypasses verification entirely. This is how you build the routing logic before the hosting story is finished. Never ship anything that depends on it.

Android 12+ debugging: `pm set-app-links --package <pkg> 0 all` resets state, `pm verify-app-links --re-verify <pkg>` forces another attempt.

### 6.7 What we are honestly not doing

**Deferred deep linking** — app not installed → user installs → app opens to the intended link — requires install attribution, which no longer has a free managed option now that Dynamic Links is gone. We do the honest zero-cost version: the Smart App Banner on the web page. If you want the full behaviour later, that is a paid SDK (Branch, AppsFlyer, Adjust) and a separate conversation.

---

## 7. Hosting and CI/CD

### One hostname, two services

`pay.folusayo.com` serves the Next.js app; `/api/*` routes to the NestJS
service. Two separate programs and two deploys, one public address.

**Why not `api.folusayo.com`.** Login cookies would then be third-party cookies,
which Safari and others block by default. One hostname keeps them first-party
and removes CORS entirely. Locally, Next.js proxies `/api/*` to `localhost:3001`
so the shape matches production.

DNS: one record for `pay`, value depending on the host chosen at X3. The apex and
`www` of `folusayo.com` are already pointed elsewhere and are not touched.

### The `.well-known` trap

Some hosts' default config ignores dot-directories, which silently strips
`/.well-known/` from a deploy — a documented cause of association files 404ing
in production while working in dev. Serving them from **route handlers** dodges
it, and the post-deploy smoke test catches it if anything else does.

### Five CI jobs, all blocking

```
lint + typecheck     eslint --max-warnings 0 · tsc --noEmit, all workspaces
unit                 vitest, pure logic, no I/O, seconds
integration-api      NestJS + Supertest + real Postgres via Testcontainers
integration-web      React Testing Library + MSW, no browser
e2e                  Playwright, full stack up, desktop + mobile projects
```

Unit runs alone and fast; the rest run in parallel beside it.

### Post-deploy smoke test

`scripts/smoke-associations.sh` runs on every production deploy and checks four
things — the fourth is the one that earns its keep:

1. Our own server returns a valid AASA, unredirected
2. **Apple's CDN has successfully ingested it** —
   `https://app-site-association.cdn-apple.com/a/v1/<domain>`. Step 1 passing
   while this 404s is the real production failure: our file is fine but Apple's
   crawler is being timed out or geo-blocked. The response headers
   (`Apple-Failure-Reason`, `Apple-From`) say exactly why.
3. `assetlinks.json` names the package with uppercase fingerprints
4. `/l/{code}` renders with an Open Graph title

## 8. Test plan

| Level | Tool | What it proves |
|---|---|---|
| Unit | Vitest, no I/O | Money arithmetic, link-code rules, `resolveLink` state machine, association JSON |
| Integration — API | NestJS + Supertest + **real Postgres in Testcontainers** | Real HTTP, real SQL, real auth. Every endpoint: happy path, authz failure, validation failure, idempotent replay |
| Integration — web | RTL + MSW | Component behaviour against mocked contract responses, no browser, no backend |
| E2E | Playwright, full stack | Create link → pay in a fresh context → dashboard updates live. Desktop and mobile projects |
| Smoke | curl + jq, post-deploy | The deep-link contract against the real domain |

**Testcontainers, not an in-memory fake.** `pg-mem` doesn't implement enough of
Postgres to be trusted with SQL that matters, and a passing test against a fake
is worse than no test.

**Ledger invariants deserve their own tests**: entries within a posting sum to
zero; a replayed idempotency key produces no second posting; a transfer with
insufficient funds is rejected atomically.

## 9. Build order

Moved to **`PLAN.md`** at the repo root, which is the operational source of
truth: four backlogs (backend, frontend, mobile, cross-cutting), the dependency
graph, and a status table the agents maintain.

The shape: Wave 0 is the monorepo, CI and `packages/contracts` — the blocker.
Then three domains build in parallel against the contract, meeting in Wave 3.

Phase 1 is merchant links, the deep link, pay-in-app and login. Phase 2 is the
wallet, balances, peer-to-peer transfers and QR payment — additive, because of
the ledger decision in §3.

## 10. Open decisions

1. ~~Domain~~ — **settled: `pay.folusayo.com`**, with bundle identifier
   `com.folusayo.kobolink`. §6 and `PLAN.md` carry the DNS work.
2. **Where the two services deploy** — still open, and deliberately so. Both are
   built and tested against localhost; the choice binds at X3. Whatever is
   chosen must put the API behind the same hostname (§7).
3. **Apple Developer Program** — no paid account. iOS ships the custom URL
   scheme first; universal links land at enrolment, or when Sayo is added to an
   existing paid team as a Developer-role member. §6.6.
4. **Simulated gateway** — a payer email beginning `fail@` declines. Keeps CI
   hermetic. Real Paystack test keys would add a webhook and are a later choice.
5. **Top-up is fake.** A wallet holding real customer money in Nigeria is
   licensed activity; this is a simulation and the funding source is simulated.

## 11. Visual design

Two design canvases. **Kobolink Screens** covers the web: dashboard, link detail,
public checkout desktop and mobile, foundations, states. **Kobolink Mobile**
covers the product flow map plus native iOS and Android screens — sign in,
deep-link checkout, paid, and the Phase 2 wallet home.

The mobile designs are **not** the web design recoloured. iOS is SF Pro at
Dynamic Type sizes with semantic system colours, SF Symbols and inset grouped
forms; Android is Material 3 with Roboto at the M3 scale, outlined fields, pill
buttons and Material Symbols. The brand carries through tint, copy and money
formatting only; structure belongs to each platform.

The web canvas covers (dashboard, link detail, public checkout desktop + mobile, foundations, states). Register: familiar Nigerian fintech, light-first, deliberately unsurprising — the merchant surfaces are **Operate** (density, scanability, consistency), the public checkout is **Persuade** (one decision, one action, trust made visible). They share tokens but are not the same design.

### Tokens

```css
/* colour */
--brand:      #1F44D8;  --brand-hover: #1637B5;  --brand-tint: #ECEFFC;
--panel:      #0E1A2B;  --panel-2:     #1B2A3F;   /* sidebar, avatars */
--ink:        #0C1626;  /* primary text        17.0:1 on white */
--ink-2:      #4A5666;  /* secondary text       7.5:1 on white */
--ink-3:      #616C7C;  /* captions, th         5.3:1 on white */
--ground:     #F6F5F2;  /* app background — warm, not cool grey */
--surface:    #FFFFFF;  --border: #E5E2DB;  --border-soft: #EFEDE8;
--success:    #0B7A44;  --success-tint: #E3F2E9;
--warning:    #8A5A00;  --warning-tint: #FAF0DB;
--danger:     #B62F1C;  --danger-tint:  #FBE9E6;

/* type — IBM Plex Sans throughout; IBM Plex Mono for references and codes only */
12 · 13 · 14 (base) · 16 · 19 · 23 · 26 · 34    /* fixed rem, ~1.2 ratio */

/* form */
--radius-input: 8px;  --radius-card: 12px;
--shadow: 0 1px 2px rgba(12,22,38,.05), 0 4px 12px rgba(12,22,38,.05);
```

### Rules the tokens encode

**The brand hue cannot be green.** Green, amber and red are spoken for by payment states. The accent is therefore blue, and it is spent only on primary actions, current selection and focus — never decoration.

**Amounts are tabular.** `font-variant-numeric: tabular-nums` on every money and count value, so columns align. This is also the only legitimate use of the mono face plus reference codes; monospace as a "technical" costume is banned.

**Every text pairing clears 4.5:1** against its own surface, including the checkout's warmer `#F1EEE8` ground, which is the tightest case in the set.

**Every interactive component ships all seven states** — default, hover, focus, active, disabled, loading, error. Half a set is not a component.

**Loading is a skeleton in the shape of the content**, never a centred spinner. Empty states teach the interface rather than reporting absence. Failure states name what went wrong, say whether money moved, and offer the next step.

**Browser surfaces are themed** — selection, caret, focus ring, scrollbar. They ship with defaults belonging to no design system.


## Sources

- [Dynamic Links Deprecation FAQ — Firebase](https://firebase.google.com/support/dynamic-links-faq)
- [Supporting associated domains — Apple Developer](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
- [TN3155: Debugging universal links — Apple Developer](https://developer.apple.com/documentation/technotes/tn3155-debugging-universal-links)
- [Verify Android App Links — Android Developers](https://developer.android.com/training/app-links/verify-android-applinks)
- [Firebase App Hosting](https://firebase.google.com/docs/app-hosting)
- [Choosing a Membership — Apple Developer](https://developer.apple.com/support/compare-memberships/)
- [Troubleshoot App Links — Android Developers](https://developer.android.com/training/app-links/troubleshoot)
- [Support Universal Links — Apple Developer](https://developer.apple.com/library/archive/documentation/General/Conceptual/AppSearch/UniversalLinks.html)
- [iOS Universal Links — Expo Documentation](https://docs.expo.dev/linking/ios-universal-links/)
