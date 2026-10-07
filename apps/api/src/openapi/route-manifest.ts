import { API, IDEMPOTENCY_HEADER, SSE_HEARTBEAT_MS, type SchemaName } from '@kobolink/contracts'

/**
 * Every HTTP route this API actually mounts. Two things keep this from
 * drifting on its own:
 *
 * 1. Every `path` below is built from `API.*` (`@kobolink/contracts`), never
 *    hand-typed — a path the orchestrator changes in `routes.ts` changes
 *    here too, automatically.
 * 2. `route-manifest.spec.ts` walks `AppModule`'s real `@Module({ imports })`
 *    graph for every controller it mounts (`mountedControllers`), reflects
 *    the real Nest route and guard metadata off each one (`mountedRoutes`)
 *    and asserts it matches this list exactly, in both directions — method,
 *    path *and* `auth`. A route added to, removed from, reshaped or
 *    re-guarded in a controller without a matching edit here fails that
 *    test, and so does a new feature module whose controller nobody put
 *    here, because nothing in that test is a hand-maintained list of
 *    controllers.
 *
 * `packages/contracts`' `API` object also names `dashboard.stats`, which no
 * controller mounts yet — it is deliberately absent here and the test above
 * is what will demand it the day it gains one.
 */

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete'

/**
 * `'none'` needs no credential. `'session'` accepts the web cookie or a
 * mobile bearer token (`SessionGuard`). `'merchant'` is `'session'` plus the
 * merchant role (`SessionGuard` then `MerchantGuard`): an authenticated
 * customer is `forbidden`, not `unauthenticated`. The OpenAPI security
 * requirement is the same for the last two — role is not a credential —
 * so the document says which in the operation's `description` instead.
 * `mounted-routes.ts` derives this same value from the real `@UseGuards`
 * metadata, which is how the spec checks it.
 */
export type AuthMode = 'none' | 'session' | 'merchant'

export interface PathParamDef {
  readonly name: string
  readonly description: string
  /**
   * `LinkCode` (`primitives.ts`) is not itself a top-level entry in
   * `registry.ts`'s `SCHEMAS` map — it only ever appears *nested* inside
   * composite schemas like `PaymentLink`, so there is no `SchemaName` to
   * `$ref` directly. Rather than hand-typing the length/alphabet rule a
   * second time (which could disagree with `primitives.ts` the moment
   * either copy changed), this parameter's schema is copied from a property
   * that already carries it, post-dereferencing — see `extractProperty` in
   * `build-openapi-document.ts`. `PaymentLink.code` is exactly `LinkCodeSchema`,
   * so this can never say something different than the contract does.
   */
  readonly source: { readonly schema: SchemaName; readonly property: string }
}

/** A response body that is not one of the named contract schemas — today, only `GET /api/health`'s tiny ad hoc shape. */
export interface InlineSchema {
  readonly inline: Record<string, unknown>
}

export interface ResponseDef {
  readonly status: number
  readonly schema: SchemaName | InlineSchema | null
  readonly description: string
  /**
   * Defaults to `application/json`. `text/event-stream` is Server-Sent
   * Events: the response never ends, and `schema` then describes the JSON
   * in each frame's `data:` line rather than one body — see
   * `streamDashboard` below and `packages/contracts/src/dashboard.ts`.
   */
  readonly mediaType?: 'application/json' | 'text/event-stream'
}

export interface RouteDef {
  readonly method: HttpMethod
  /** Full path including the `/api` prefix, e.g. `/api/links/{code}/status`. */
  readonly path: string
  readonly operationId: string
  readonly summary: string
  /** Longer, Markdown-capable prose for what `summary`'s one line cannot carry. */
  readonly description?: string
  readonly tags: readonly string[]
  readonly auth: AuthMode
  readonly pathParams?: readonly PathParamDef[]
  /** `PageQuery` for every cursor-paginated list route. */
  readonly query?: SchemaName
  /** Adds the `Idempotency-Key` header as a required parameter. */
  readonly idempotencyKey?: boolean
  readonly requestBody?: { readonly schema: SchemaName; readonly description: string }
  readonly responses: readonly ResponseDef[]
}

/** `code` is always the path token: `API.links.item(':code')` → `/api/links/:code` → `/api/links/{code}`. */
function templated(fn: (code: string) => string): string {
  return fn(':code').replace(':code', '{code}')
}

const CODE_PARAM: PathParamDef = {
  name: 'code',
  description: "The link's short code.",
  source: { schema: 'PaymentLink', property: 'code' },
}

const HEALTH_RESPONSE_SCHEMA: InlineSchema = {
  inline: {
    type: 'object',
    properties: { status: { type: 'string', const: 'ok' } },
    required: ['status'],
    additionalProperties: false,
  },
}

export const ROUTES: readonly RouteDef[] = [
  {
    method: 'get',
    path: API.health,
    operationId: 'getHealth',
    summary: 'Liveness/readiness probe. 200 only if Postgres round-trips.',
    tags: ['Health'],
    auth: 'none',
    responses: [{ status: 200, schema: HEALTH_RESPONSE_SCHEMA, description: 'The API and its database are both reachable.' }],
  },
  {
    method: 'post',
    path: API.auth.register,
    operationId: 'registerUser',
    summary: 'Create an account and sign in.',
    tags: ['Auth'],
    auth: 'none',
    requestBody: { schema: 'RegisterRequest', description: 'New account details.' },
    responses: [{ status: 201, schema: 'AuthResponse', description: 'Account created and signed in.' }],
  },
  {
    method: 'post',
    path: API.auth.login,
    operationId: 'login',
    summary: 'Sign in with email and password.',
    tags: ['Auth'],
    auth: 'none',
    requestBody: { schema: 'LoginRequest', description: 'Credentials.' },
    responses: [{ status: 200, schema: 'AuthResponse', description: 'Signed in.' }],
  },
  {
    method: 'post',
    path: API.auth.logout,
    operationId: 'logout',
    summary: 'Revoke the current session.',
    tags: ['Auth'],
    auth: 'session',
    responses: [{ status: 204, schema: null, description: 'Session revoked. No body.' }],
  },
  {
    method: 'get',
    path: API.auth.me,
    operationId: 'getMe',
    summary: 'The signed-in user.',
    tags: ['Auth'],
    auth: 'session',
    responses: [{ status: 200, schema: 'MeResponse', description: 'The signed-in user.' }],
  },
  {
    method: 'post',
    path: API.links.collection,
    operationId: 'createLink',
    summary: 'Create a payment link.',
    tags: ['Links'],
    auth: 'merchant',
    requestBody: { schema: 'CreateLinkRequest', description: 'The new link.' },
    responses: [{ status: 201, schema: 'PaymentLink', description: 'The created link.' }],
  },
  {
    method: 'get',
    path: API.links.collection,
    operationId: 'listLinks',
    summary: "The signed-in merchant's links.",
    tags: ['Links'],
    auth: 'merchant',
    query: 'PageQuery',
    responses: [{ status: 200, schema: 'LinkListResponse', description: 'One page of links.' }],
  },
  {
    method: 'get',
    path: templated(API.links.item),
    operationId: 'getLink',
    summary: "The signed-in merchant's own link, by code.",
    tags: ['Links'],
    auth: 'merchant',
    pathParams: [CODE_PARAM],
    responses: [{ status: 200, schema: 'PaymentLink', description: 'The link.' }],
  },
  {
    method: 'patch',
    path: templated(API.links.status),
    operationId: 'updateLinkStatus',
    summary: 'Enable or disable a link.',
    tags: ['Links'],
    auth: 'merchant',
    pathParams: [CODE_PARAM],
    requestBody: { schema: 'UpdateLinkStatusRequest', description: 'The new status.' },
    responses: [{ status: 200, schema: 'PaymentLink', description: 'The updated link.' }],
  },
  {
    method: 'get',
    path: templated(API.links.payments),
    operationId: 'listLinkPayments',
    summary: 'Payments made against one link.',
    tags: ['Links'],
    auth: 'merchant',
    pathParams: [CODE_PARAM],
    query: 'PageQuery',
    responses: [{ status: 200, schema: 'PaymentListResponse', description: 'One page of payments.' }],
  },
  {
    method: 'get',
    path: templated(API.links.resolve),
    operationId: 'resolvePublicLink',
    summary: 'Unauthenticated resolution for the checkout page and both mobile apps.',
    tags: ['Links'],
    auth: 'none',
    pathParams: [CODE_PARAM],
    responses: [{ status: 200, schema: 'PublicLinkResponse', description: 'The state the link resolves to, and the public fields.' }],
  },
  {
    method: 'post',
    path: API.checkout.initialize,
    operationId: 'initializeCheckout',
    summary: 'Start a payment against a link. Money-moving; idempotent.',
    tags: ['Checkout'],
    auth: 'none',
    idempotencyKey: true,
    requestBody: { schema: 'InitializeCheckoutRequest', description: 'The link, amount and payer.' },
    responses: [{ status: 201, schema: 'InitializeCheckoutResponse', description: 'A pending payment.' }],
  },
  {
    method: 'post',
    path: API.checkout.verify,
    operationId: 'verifyCheckout',
    summary: 'Complete a payment: posts the ledger entries. Money-moving; idempotent.',
    tags: ['Checkout'],
    auth: 'none',
    idempotencyKey: true,
    requestBody: { schema: 'VerifyCheckoutRequest', description: 'The payment reference to verify.' },
    responses: [{ status: 200, schema: 'VerifyCheckoutResponse', description: 'The completed (or declined) payment.' }],
  },
  {
    method: 'get',
    path: API.dashboard.stream,
    operationId: 'streamDashboard',
    summary: "Live events for the signed-in merchant's dashboard, as Server-Sent Events.",
    description:
      'The response is `text/event-stream` and stays open. Each frame is `id: <n>`, `event: <type>`, ' +
      '`data: <DashboardEvent as JSON>`, then a blank line; `event:` repeats `data.type`, so a client can ' +
      'validate every frame — heartbeats included — against `DashboardEvent` alone. A `heartbeat` frame is ' +
      `sent every ${SSE_HEARTBEAT_MS}ms so an idle stream survives proxies; clients ignore it. \`id:\` is a ` +
      'monotonic cursor; the server does not yet replay past events for a `Last-Event-ID` header, so a ' +
      'reconnecting client starts fresh. Authentication and role are checked before the first byte, so a ' +
      'refused request is an ordinary `ApiError` response, not a stream. Not callable through a generated ' +
      'JSON client (the Kotlin/Swift `streamDashboard` method would try to parse the whole stream as one ' +
      'object) — use an SSE client such as `EventSource`.',
    tags: ['Dashboard'],
    auth: 'merchant',
    responses: [
      {
        status: 200,
        schema: 'DashboardEvent',
        mediaType: 'text/event-stream',
        description: 'An open event stream. The schema is the JSON in each frame’s `data:` line.',
      },
    ],
  },
  {
    method: 'get',
    path: API.wallet.me,
    operationId: 'getWallet',
    summary: "The signed-in user's own wallet: account id, currency and balance derived from the ledger.",
    tags: ['Wallet'],
    auth: 'session',
    responses: [{ status: 200, schema: 'Wallet', description: 'The wallet.' }],
  },
  {
    method: 'get',
    path: API.wallet.transactions,
    operationId: 'listWalletTransactions',
    summary: "The signed-in user's wallet transfers and top-ups, newest first.",
    tags: ['Wallet'],
    auth: 'session',
    query: 'PageQuery',
    responses: [{ status: 200, schema: 'WalletTransactionListResponse', description: 'One page of wallet transactions.' }],
  },
  {
    method: 'post',
    path: API.wallet.transfer,
    operationId: 'transferMoney',
    summary: "P2P transfer to another user's wallet by phone number. Money-moving; idempotent.",
    tags: ['Wallet'],
    auth: 'session',
    idempotencyKey: true,
    requestBody: { schema: 'TransferRequest', description: 'The recipient, amount and optional note.' },
    responses: [{ status: 201, schema: 'TransferResponse', description: 'The posted transfer and the sender’s updated wallet.' }],
  },
  {
    method: 'post',
    path: API.wallet.topup,
    operationId: 'topUpWallet',
    summary: 'Simulated funding into the signed-in user’s own wallet. No real money enters the system. Money-moving; idempotent.',
    tags: ['Wallet'],
    auth: 'session',
    idempotencyKey: true,
    requestBody: { schema: 'TopUpRequest', description: 'The amount to credit.' },
    responses: [{ status: 201, schema: 'TransferResponse', description: 'The posted top-up and the updated wallet.' }],
  },
]

export const IDEMPOTENCY_HEADER_NAME = IDEMPOTENCY_HEADER
