import {
  API,
  DashboardStatsSchema,
  IDEMPOTENCY_HEADER,
  InitializeCheckoutResponseSchema,
  LinkCodeSchema,
  LinkListResponseSchema,
  MeResponseSchema,
  PaymentLinkSchema,
  PaymentListResponseSchema,
  PublicLinkResponseSchema,
  VerifyCheckoutResponseSchema,
  isApiError,
  type ApiError,
  type DashboardStats,
  type InitializeCheckoutRequest,
  type InitializeCheckoutResponse,
  type LinkListResponse,
  type MeResponse,
  type PageQuery,
  type PaymentLink,
  type PaymentListResponse,
  type PublicLinkResponse,
  type VerifyCheckoutRequest,
  type VerifyCheckoutResponse,
} from '@kobolink/contracts'
import type { ZodType } from 'zod'

/**
 * Thrown for every non-2xx response. Carries the parsed `ApiError` body so a
 * caller can switch on `error.code` instead of an HTTP status, and the
 * status itself for anything that only cares about the transport outcome.
 *
 * `transport` means the API could not be reached or did not answer at all —
 * true only for `transportError()` below, standing in for a response the
 * API never actually produced (a proxy's HTML page, a server not running
 * yet). It is false both when the API itself answered with this body *and*
 * when this file fabricates one client-side without a request
 * (`requireValidLinkCode`'s `not_found`) — that fabrication is a considered
 * stand-in for what the server would have said, not a failure to reach it.
 * F6's result screen needs the true/false split: "the gateway declined this
 * payment" reads very differently from "we could not reach the gateway at
 * all".
 */
export class ApiRequestError extends Error {
  readonly status: number
  readonly error: ApiError
  readonly transport: boolean

  constructor(status: number, error: ApiError, transport = false) {
    super(error.message)
    this.name = 'ApiRequestError'
    this.status = status
    this.error = error
    this.transport = transport
  }
}

/**
 * A fallback body for a non-2xx response that is not itself a well-formed
 * `ApiError` — a proxy timeout, an HTML error page, a server that is not
 * running yet. The `code: 'internal'` here is indistinguishable from a real
 * `internal` error the API returned by looking at the body alone;
 * `ApiRequestError.transport` (always `true` at this function's one call
 * site) is what actually lets a caller tell the two apart.
 */
function transportError(status: number, statusText: string): ApiError {
  return { code: 'internal', message: `Request failed with status ${status} ${statusText}`.trim() }
}

/**
 * `code` reaches the URL path unencoded (`API.links.item(code)` is a plain
 * template string) — validating it against the same `LinkCodeSchema` the
 * server enforces means a garbage value (whitespace, a slash, anything that
 * would reshape the path) is rejected here, as the `not_found` the server
 * would answer anyway, without spending a request finding that out.
 */
function requireValidLinkCode(code: string): void {
  if (!LinkCodeSchema.safeParse(code).success) {
    throw new ApiRequestError(404, { code: 'not_found', message: `"${code}" is not a valid link code.` })
  }
}

/**
 * The origin `fetch` resolves every path against, so a caller (including
 * this file's own SSR/server-component callers, where `window` does not
 * exist) always issues an absolute URL.
 *
 * In the browser this is simply the page's own origin: `/api/*` there goes
 * through `next.config.ts`'s rewrite to `apps/api`, which is what keeps
 * cookies first-party and avoids a CORS story.
 *
 * On the server it is `API_ORIGIN` directly — the same variable
 * `next.config.ts`'s rewrite already reads, not a second `INTERNAL_ORIGIN`
 * self-origin. F6's `/l/[code]` calls this client from a server component at
 * request time; resolving to this Next.js process's own origin there would
 * mean a self-fetch back into the rewrite just to reach `apps/api` a hop
 * later — extra latency, and a self-connection that is not guaranteed to
 * even be reachable in every deployment shape (a serverless function cannot
 * always fetch itself). Going straight to `API_ORIGIN` is both fewer hops
 * and one less thing that can be wrong.
 */
function origin(): string {
  if (typeof window !== 'undefined') return window.location.origin
  return process.env.API_ORIGIN ?? 'http://localhost:3001'
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  query?: Record<string, string | number | undefined>
}

async function request<T>(schema: ZodType<T>, path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, headers, ...init } = options
  const url = new URL(path, origin())
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  // `new Headers(headers)` — not `{ ...headers }` — so a caller passing a
  // `Headers` instance or a `[key, value][]` tuple array (both valid
  // `HeadersInit`, both invisible to object-spread) still comes through.
  // F6's idempotent checkout calls send `Idempotency-Key` this way.
  const requestHeaders = new Headers(headers)
  if (body !== undefined && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json')
  }

  const response = await fetch(url, {
    ...init,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const text = await response.text()
  // A non-2xx response is not guaranteed to be JSON at all — a proxy's HTML
  // 502, a server that isn't running yet. Parsing must not throw before the
  // `!response.ok` branch gets a chance to fall through to `transportError`.
  let json: unknown
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }

  if (!response.ok) {
    if (isApiError(json)) throw new ApiRequestError(response.status, json, false)
    throw new ApiRequestError(response.status, transportError(response.status, response.statusText), true)
  }

  return schema.parse(json)
}

function pageQuery(query?: PageQuery): Record<string, string | number | undefined> {
  return { cursor: query?.cursor, limit: query?.limit }
}

/**
 * The typed client. Every method parses its response with the matching
 * contract schema and throws `ApiRequestError` for anything that is not 2xx
 * — a screen never has to guess a shape or check `response.ok` by hand.
 */
export const client = {
  auth: {
    me: () => request<MeResponse>(MeResponseSchema, API.auth.me),
  },
  links: {
    list: (query?: PageQuery) =>
      request<LinkListResponse>(LinkListResponseSchema, API.links.collection, { query: pageQuery(query) }),
    // `async` here is deliberate, not stylistic: it turns
    // `requireValidLinkCode`'s synchronous throw into a rejected Promise, so
    // `client.links.resolve(bad).catch(...)` catches it exactly like it
    // catches a non-2xx response, instead of throwing synchronously out of
    // whatever effect or handler called it.
    get: async (code: string) => {
      requireValidLinkCode(code)
      return await request<PaymentLink>(PaymentLinkSchema, API.links.item(code))
    },
    // `cache: 'no-store'` — this is the call F6's server component makes at
    // request time. README: "the API is the clock"; a link a merchant just
    // disabled must never be masked by Next's fetch cache reusing a stale
    // `payable` response for the next visitor of the same code.
    resolve: async (code: string) => {
      requireValidLinkCode(code)
      return await request<PublicLinkResponse>(PublicLinkResponseSchema, API.links.resolve(code), {
        cache: 'no-store',
      })
    },
    payments: async (code: string, query?: PageQuery) => {
      requireValidLinkCode(code)
      return await request<PaymentListResponse>(PaymentListResponseSchema, API.links.payments(code), {
        query: pageQuery(query),
      })
    },
  },
  dashboard: {
    stats: () => request<DashboardStats>(DashboardStatsSchema, API.dashboard.stats),
  },
  // Both endpoints are money-moving writes: every call carries its own
  // caller-chosen `Idempotency-Key` (README: "a replayed key returns the
  // original result, never posts twice"). F6's PayForm mints one key per
  // logical attempt at each of these two calls — never one key reused across
  // both — and reuses `verify`'s key argument (a fresh key, same `reference`)
  // to re-check a reference after a transport error, which the mock's
  // per-reference memo (not the idempotency-key memo) answers idempotently.
  checkout: {
    initialize: (body: InitializeCheckoutRequest, idempotencyKey: string) =>
      request<InitializeCheckoutResponse>(InitializeCheckoutResponseSchema, API.checkout.initialize, {
        method: 'POST',
        body,
        headers: { [IDEMPOTENCY_HEADER]: idempotencyKey },
      }),
    verify: (body: VerifyCheckoutRequest, idempotencyKey: string) =>
      request<VerifyCheckoutResponse>(VerifyCheckoutResponseSchema, API.checkout.verify, {
        method: 'POST',
        body,
        headers: { [IDEMPOTENCY_HEADER]: idempotencyKey },
      }),
  },
}
