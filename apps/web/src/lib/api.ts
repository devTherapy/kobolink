import {
  API,
  DashboardStatsSchema,
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
 */
export class ApiRequestError extends Error {
  readonly status: number
  readonly error: ApiError

  constructor(status: number, error: ApiError) {
    super(error.message)
    this.name = 'ApiRequestError'
    this.status = status
    this.error = error
  }
}

/**
 * A fallback body for a non-2xx response that is not itself a well-formed
 * `ApiError` — a proxy timeout, an HTML error page, a server that is not
 * running yet. Kept distinct from `internal` so a caller can tell "the API
 * told us it failed" from "we could not reach the API at all".
 */
function transportError(status: number, statusText: string): ApiError {
  return { code: 'internal', message: `Request failed with status ${status} ${statusText}`.trim() }
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
    const apiError = isApiError(json) ? json : transportError(response.status, response.statusText)
    throw new ApiRequestError(response.status, apiError)
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
    get: (code: string) => request<PaymentLink>(PaymentLinkSchema, API.links.item(code)),
    resolve: (code: string) =>
      request<PublicLinkResponse>(PublicLinkResponseSchema, API.links.resolve(code)),
    payments: (code: string, query?: PageQuery) =>
      request<PaymentListResponse>(PaymentListResponseSchema, API.links.payments(code), {
        query: pageQuery(query),
      }),
  },
  dashboard: {
    stats: () => request<DashboardStats>(DashboardStatsSchema, API.dashboard.stats),
  },
}
