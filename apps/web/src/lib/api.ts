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

/** The app's own origin, so `fetch` always receives an absolute URL — required outside the browser (SSR, this file's callers under Vitest/Node). */
function origin(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
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

  const response = await fetch(url, {
    ...init,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const text = await response.text()
  const json: unknown = text.length > 0 ? JSON.parse(text) : undefined

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
