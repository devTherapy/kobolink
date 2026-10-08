import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { API } from '@kobolink/contracts'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN, REVOKED_SESSION_TOKEN } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { linkStore, paymentsByCode } from '@/mocks/state'
import { DashboardUnavailableError, loadDashboardData } from './dashboard'
import { MerchantAccessError, UnexpectedResponseError } from './read-failure'

/** `redirect()` throws a tagged error; this stands in for it so a test can see where it pointed. */
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`)
  },
}))

/** A valid, signed-in session cookie header — see `session.test.ts` for the same convention. */
const VALID_COOKIE = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`

describe('loadDashboardData', () => {
  it('loads stats and the links list from the same seeded snapshot', async () => {
    const data = await loadDashboardData(VALID_COOKIE)

    expect(data.stats).toMatchObject({ totalCollectedKobo: 5_550_000, paymentCount: 3, activeLinks: 1 })
    expect(data.links.items).toHaveLength(1)
    expect(data.links.items[0]).toMatchObject({ code: 'aBcDeFgH', title: 'Ankara Two-Piece Set' })
  })

  it('never disagrees with the store — a link created and paid changes both stats and the list together', async () => {
    linkStore.set('zZzZ2345', {
      code: 'zZzZ2345',
      merchantId: 'usr_2Hh9kq3mV1',
      merchantName: 'Adebayo Stores',
      title: 'Extra link',
      description: null,
      amountKobo: 200_000,
      currency: 'NGN',
      status: 'active',
      isReusable: true,
      expiresAt: null,
      createdAt: '2026-06-10T09:00:00.000Z',
      paymentCount: 0,
      totalPaidKobo: 0,
    })
    paymentsByCode.set('zZzZ2345', [])

    const data = await loadDashboardData(VALID_COOKIE)

    expect(data.stats.activeLinks).toBe(2)
    expect(data.links.items).toHaveLength(2)
  })

  it('returns an empty links list and zeroed stats for a merchant with nothing yet', async () => {
    linkStore.clear()
    paymentsByCode.clear()

    const data = await loadDashboardData(VALID_COOKIE)

    expect(data.links.items).toEqual([])
    expect(data.stats).toMatchObject({ totalCollectedKobo: 0, paymentCount: 0, activeLinks: 0 })
  })

  it('maps a non-2xx response from either endpoint to DashboardUnavailableError', async () => {
    server.use(
      http.get(API.dashboard.stats, () => HttpResponse.json({ code: 'internal', message: 'boom' }, { status: 500 })),
    )
    await expect(loadDashboardData(VALID_COOKIE)).rejects.toThrow(DashboardUnavailableError)
  })

  it('maps a raw transport failure (no ApiError body at all) to DashboardUnavailableError too', async () => {
    server.use(http.get(API.links.collection, () => HttpResponse.error()))
    await expect(loadDashboardData(VALID_COOKIE)).rejects.toThrow(DashboardUnavailableError)
  })

  // ---- error classes ---------------------------------------------------------
  // Each failure keeps its class: sign-in is the fix for a 401, a customer
  // account for a 403 can never succeed on retry, a body that does not match
  // the contract is a bug on our side rather than a connectivity problem, and
  // only a real transport/5xx/rate-limit failure is worth a retry.
  const unauthenticated = () =>
    HttpResponse.json({ code: 'unauthenticated', message: 'Sign in.' }, { status: 401 })

  it('sends a 401 from the stats endpoint to sign-in, and back to the dashboard afterwards', async () => {
    server.use(http.get(API.dashboard.stats, unauthenticated))
    await expect(loadDashboardData(VALID_COOKIE)).rejects.toThrow('NEXT_REDIRECT:/login?next=%2Fdashboard')
  })

  it('sends a 401 from the links endpoint to sign-in too', async () => {
    server.use(http.get(API.links.collection, unauthenticated))
    await expect(loadDashboardData(VALID_COOKIE)).rejects.toThrow('NEXT_REDIRECT:/login?next=%2Fdashboard')
  })

  it('reports a customer-role 403 as MerchantAccessError, not as unreachable servers', async () => {
    server.use(
      http.get(API.dashboard.stats, () =>
        HttpResponse.json({ code: 'forbidden', message: 'Merchant role required.' }, { status: 403 }),
      ),
    )
    const error = await loadDashboardData(VALID_COOKIE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MerchantAccessError)
  })

  it('reports a 403 from the links endpoint the same way', async () => {
    server.use(
      http.get(API.links.collection, () =>
        HttpResponse.json({ code: 'forbidden', message: 'Merchant role required.' }, { status: 403 }),
      ),
    )
    const error = await loadDashboardData(VALID_COOKIE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MerchantAccessError)
  })

  it('reports a 200 whose body breaks the contract as UnexpectedResponseError, keeping the cause', async () => {
    server.use(http.get(API.dashboard.stats, () => HttpResponse.json({ totalCollectedKobo: 'a lot' })))
    const error = await loadDashboardData(VALID_COOKIE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnexpectedResponseError)
    expect((error as Error).cause).toBeDefined()
  })

  it('keeps a rate-limited response retryable', async () => {
    server.use(
      http.get(API.dashboard.stats, () =>
        HttpResponse.json({ code: 'rate_limited', message: 'Slow down.' }, { status: 429 }),
      ),
    )
    await expect(loadDashboardData(VALID_COOKIE)).rejects.toThrow(DashboardUnavailableError)
  })

  it('keeps a proxy error page (non-JSON 5xx) retryable', async () => {
    server.use(http.get(API.dashboard.stats, () => new HttpResponse('<html>Bad gateway</html>', { status: 502 })))
    await expect(loadDashboardData(VALID_COOKIE)).rejects.toThrow(DashboardUnavailableError)
  })

  it('does not treat a non-JSON 401 (a proxy, not the API) as a signed-out session', async () => {
    server.use(http.get(API.dashboard.stats, () => new HttpResponse('Unauthorized', { status: 401 })))
    await expect(loadDashboardData(VALID_COOKIE)).rejects.toThrow(DashboardUnavailableError)
  })

  // ---- auth-cookie forwarding ----------------------------------------------
  // The whole point of `client.links.list`/`client.dashboard.stats` accepting
  // `init?.headers` is that a Server Component has no browser cookie jar
  // behind it — `loadDashboardData` must forward the httpOnly session cookie
  // by hand, exactly like `getSession` does for `auth.me`. The MSW handlers
  // for both endpoints now guard on that cookie the same way `auth.me` does
  // (see `src/mocks/handlers.ts`), so these tests fail for real if the
  // forwarding code is ever removed — unlike before, when the mock accepted
  // any request regardless of `init.headers`.
  it('sends the visitor to sign-in when no cookie is forwarded at all', async () => {
    await expect(loadDashboardData('')).rejects.toThrow('NEXT_REDIRECT:/login?next=%2Fdashboard')
  })

  it('sends the visitor to sign-in for a stale/revoked session cookie', async () => {
    await expect(loadDashboardData(`${MOCK_SESSION_COOKIE_NAME}=${REVOKED_SESSION_TOKEN}`)).rejects.toThrow(
      'NEXT_REDIRECT:/login?next=%2Fdashboard',
    )
  })

  it('succeeds when a valid session cookie is forwarded', async () => {
    const data = await loadDashboardData(VALID_COOKIE)
    expect(typeof data.stats.activeLinks).toBe('number')
    expect(Array.isArray(data.links.items)).toBe(true)
  })
})
