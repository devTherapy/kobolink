import { API, IDEMPOTENCY_HEADER, type SchemaName } from '@kobolink/contracts'

/**
 * Every HTTP route this API actually mounts, as of this feature (B7). Two
 * things keep this from drifting on its own:
 *
 * 1. Every `path` below is built from `API.*` (`@kobolink/contracts`), never
 *    hand-typed — a path the orchestrator changes in `routes.ts` changes
 *    here too, automatically.
 * 2. `route-manifest.spec.ts` reflects the real Nest route metadata off
 *    every controller `AppModule` mounts and asserts it matches this list
 *    exactly, in both directions — a route added to, removed from, or
 *    reshaped in a controller without a matching edit here fails that test.
 *
 * `packages/contracts`' own `API` object also names `wallet.*` and
 * `dashboard.*` paths — B8 and B6, both still `todo` in `PLAN.md`. No
 * controller mounts them yet, so they are deliberately absent here: this
 * manifest (and so the generated OpenAPI document) describes routes the API
 * actually exposes today, not ones a future feature will add. Wiring those
 * two up is that feature's own PR, alongside its own edit to this file.
 */

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete'

/** `'none'` needs no credential; `'session'` accepts the web cookie or a mobile bearer token — see `SessionGuard`. */
export type AuthMode = 'none' | 'session'

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
}

export interface RouteDef {
  readonly method: HttpMethod
  /** Full path including the `/api` prefix, e.g. `/api/links/{code}/status`. */
  readonly path: string
  readonly operationId: string
  readonly summary: string
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
    auth: 'session',
    requestBody: { schema: 'CreateLinkRequest', description: 'The new link.' },
    responses: [{ status: 201, schema: 'PaymentLink', description: 'The created link.' }],
  },
  {
    method: 'get',
    path: API.links.collection,
    operationId: 'listLinks',
    summary: "The signed-in merchant's links.",
    tags: ['Links'],
    auth: 'session',
    query: 'PageQuery',
    responses: [{ status: 200, schema: 'LinkListResponse', description: 'One page of links.' }],
  },
  {
    method: 'get',
    path: templated(API.links.item),
    operationId: 'getLink',
    summary: "The signed-in merchant's own link, by code.",
    tags: ['Links'],
    auth: 'session',
    pathParams: [CODE_PARAM],
    responses: [{ status: 200, schema: 'PaymentLink', description: 'The link.' }],
  },
  {
    method: 'patch',
    path: templated(API.links.status),
    operationId: 'updateLinkStatus',
    summary: 'Enable or disable a link.',
    tags: ['Links'],
    auth: 'session',
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
    auth: 'session',
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
]

export const IDEMPOTENCY_HEADER_NAME = IDEMPOTENCY_HEADER
