# @kobolink/contracts

Every shape that crosses a process boundary, once. `apps/api` implements these,
`apps/web` mocks them with MSW, and the OpenAPI document generated from
`SCHEMAS` produces the Swift and Kotlin models. Only the orchestrator edits this
package; a domain agent that needs a change reports the exact change and stops.

```ts
import { CreateLinkRequestSchema, type PaymentLink, formatNaira, API } from '@kobolink/contracts'
```

## Modules

| Module | What it holds |
|---|---|
| `money` | `formatNaira`, `parseNaira`, `isValidAmountKobo`, the limits. **The only code allowed to divide or multiply by 100.** |
| `code` | `newLinkCode`, `isValidLinkCode`, `newPaymentReference` — the mistranscription-safe alphabet |
| `primitives` | Field schemas: `KoboSchema`, `AmountKoboSchema`, `LinkCodeSchema`, `PhoneSchema`, `IdempotencyKeySchema`, `PageQuerySchema`, `pageOf()` |
| `users` | `User`, `RegisterRequest`, `LoginRequest`, `AuthResponse`, `MeResponse` |
| `links` | `PaymentLink` (merchant view), `PublicLink` + `PublicLinkResponse` (stranger view), create/update requests |
| `payments` | `InitializeCheckout*`, `VerifyCheckout*`, `Payment`, `isSimulatedDecline`, `maskEmail` |
| `dashboard` | `DashboardStats`, `DashboardEvent` (SSE), `SSE_HEARTBEAT_MS` |
| `wallet` | Phase 2: `Wallet`, `TransferRequest`, `TopUpRequest`, `WalletTransaction`, `QrPayload` |
| `errors` | `ApiError`, `ErrorCode`, `HTTP_STATUS_FOR_ERROR` |
| `routes` | `API` path constants, `linkUrl`, `linkSchemeUrl`, `parseLinkCode`, domain and bundle identifiers |
| `status` | `resolveLink()` — the single answer to "is this payable", `displayStatus()`, `toPublicLinkState()` |
| `fixtures` | `exampleUser()`, `exampleLink()`, `examplePayment()`, `exampleStats()`, `exampleWallet()`, `toPublicLink()` |
| `registry` | `SCHEMAS` (name → schema) and `jsonSchemas()` for the OpenAPI generator |

## The API surface

All paths are under `/api` on the same origin as the web app. Bodies are JSON.
Every non-2xx response body is an `ApiError`; `HTTP_STATUS_FOR_ERROR` gives the
status for each code. Auth is a session cookie for web (`?client=web`, the
default) or a bearer token for mobile (`?client=mobile`, then
`Authorization: Bearer <token>`).

| Method | Path (`API.*`) | Auth | Request | Response | Notes |
|---|---|---|---|---|---|
| GET | `health` | none | — | `{ status: 'ok' }` | |
| POST | `auth.register` | none | `RegisterRequest` + `?client=` | `AuthResponse` 201 | `conflict` on a taken email |
| POST | `auth.login` | none | `LoginRequest` + `?client=` | `AuthResponse` | `unauthenticated` for wrong password *and* unknown user (same message); `rate_limited` after repeated failures per email and per IP |
| POST | `auth.logout` | session | — | 204 | Revokes the session row; the cookie/token is dead afterwards |
| GET | `auth.me` | session | — | `MeResponse` | `unauthenticated` when expired or revoked |
| POST | `links.collection` | merchant | `CreateLinkRequest` | `PaymentLink` 201 | Server generates the code and retries on collision; the client never supplies one |
| GET | `links.collection` | merchant | `PageQuery` | `LinkListResponse` | Only the caller's links, newest first |
| GET | `links.item(code)` | merchant | — | `PaymentLink` | **Another merchant's link is `not_found`, never `forbidden`** — existence is not disclosed |
| PATCH | `links.status(code)` | merchant | `UpdateLinkStatusRequest` | `PaymentLink` | |
| GET | `links.payments(code)` | merchant | `PageQuery` | `PaymentListResponse` | `payerEmail` is masked |
| GET | `links.resolve(code)` | **none** | — | `PublicLinkResponse` | 200 with `state` resolved server-side via `resolveLink()`; `not_found` 404 for a missing or malformed code. Carries only what the checkout renders |
| POST | `checkout.initialize` | none | `InitializeCheckoutRequest` + `Idempotency-Key` | `InitializeCheckoutResponse` 201 | `link_not_payable` if `resolveLink` ≠ payable; `amount_mismatch` if the link has a fixed amount and it differs; `validation_failed` without a key |
| POST | `checkout.verify` | none | `VerifyCheckoutRequest` + `Idempotency-Key` | `VerifyCheckoutResponse` | On success posts the ledger entries in one transaction. Simulated gateway: `payerEmail` starting `fail@` → `status: 'failed'`, `failureReason` set, `moneyMoved: false`. Replaying the key returns the original result |
| GET | `dashboard.stats` | merchant | — | `DashboardStats` | Derived from ledger postings, never counted client-side |
| GET | `dashboard.stream` | merchant | `Last-Event-ID` optional | SSE of `DashboardEvent` | `event:` is the `type`; `heartbeat` every `SSE_HEARTBEAT_MS` |
| GET | `wallet.me` | any user | — | `Wallet` | Phase 2 |
| GET | `wallet.transactions` | any user | `PageQuery` | `WalletTransactionListResponse` | Phase 2 |
| POST | `wallet.transfer` | any user | `TransferRequest` + `Idempotency-Key` | `TransferResponse` | Phase 2. `insufficient_funds` rejects atomically |
| POST | `wallet.topup` | any user | `TopUpRequest` + `Idempotency-Key` | `TransferResponse` | Phase 2. Simulated funding |

### Idempotency

Every money-moving write (`checkout.initialize`, `checkout.verify`,
`wallet.transfer`, `wallet.topup`) requires the `Idempotency-Key` header
(`IdempotencyKeySchema`). The server stores `(key, request hash, response)`.
A replay with the same key and same body returns the stored response with the
original status; the same key with a different body is `idempotency_mismatch`.
Nothing posts twice.

### Money

`amountKobo`, `totalPaidKobo`, `balanceKobo` are integers. The JSON Schema for
every `*Kobo` field is `"type": "integer"`; a test in this package fails if one
becomes `number`. Display formatting happens in the client with `formatNaira`.

### Link resolution

`links.resolve` returns `state` computed by `resolveLink()` at request time.
Clients render from `state` and never re-derive it from `expiresAt` or
`isReusable` — the API is the clock. The four states and the 404 map to the
checkout page's non-payable screens one to one.
