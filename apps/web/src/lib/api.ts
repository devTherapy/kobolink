import {
  API,
  DashboardStatsSchema,
  LinkCodeSchema,
  LinkListResponseSchema,
  MeResponseSchema,
  PaymentLinkSchema,
  PaymentListResponseSchema,
  PublicLinkResponseSchema,
  isApiError,
  type ApiError,
  type DashboardStats,
  type LinkListResponse,
  type MeResponse,
  type PageQuery,
  type PaymentLink,
  type PaymentListResponse,
  type PublicLinkResponse,
} from '@kobolink/contracts'
import type { ZodType } from 'zod'

/**
 * Thrown for every non-2xx response. Carries the parsed `ApiError` body so a
 * caller can switch on `error.code` instead of an HTTP status, and the
 * status itself for anything that only cares about the transport outcome.
 *
 * `transport` is true exactly when `error` is a *fabricated* `ApiError` —
 * `transportError()` below, standing in for a response the API never
 * actually produced (a proxy's HTML page, a server not running yet) — and
 * false when the API itself answered with this body. F6's result screen
 * needs to tell those apart: "the gateway declined this payment" reads very
 * differently from "we could not reach the gateway at all".
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
 * running yet. `ApiRequestError.transport` is what actually lets a caller
 * tell this apart from a real `internal` error the API returned; this
 * function only supplies its body.
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
 * The app's own origin, so `fetch` always receives an absolute URL —
 * required outside the browser (SSR, this file's callers under Vitest/Node).
 * `INTERNAL_ORIGIN` is a server-only escape hatch: F6's `/l/[code]` fetches
 * this client from a server component, where `window` does not exist and a
 * hardcoded `localhost:3000` would be wrong in every deployed environment.
 * Deployment must set it to wherever this Next.js process can reach itself.
 */
function origin(): string {
  if (typeof window !== 'undefined') return window.location.origin
  return process.env.INTERNAL_ORIGIN ?? 'http://localhost:3000'
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
    resolve: async (code: string) => {
      requireValidLinkCode(code)
      return await request<PublicLinkResponse>(PublicLinkResponseSchema, API.links.resolve(code))
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
}
