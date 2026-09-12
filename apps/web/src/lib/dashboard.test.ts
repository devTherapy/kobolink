import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API } from '@kobolink/contracts'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN, REVOKED_SESSION_TOKEN } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { linkStore, paymentsByCode } from '@/mocks/state'
import { DashboardUnavailableError, loadDashboardData } from './dashboard'

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

  // ---- auth-cookie forwarding ----------------------------------------------
  // The whole point of `client.links.list`/`client.dashboard.stats` accepting
  // `init?.headers` is that a Server Component has no browser cookie jar
  // behind it — `loadDashboardData` must forward the httpOnly session cookie
  // by hand, exactly like `getSession` does for `auth.me`. The MSW handlers
  // for both endpoints now guard on that cookie the same way `auth.me` does
  // (see `src/mocks/handlers.ts`), so these tests fail for real if the
  // forwarding code is ever removed — unlike before, when the mock accepted
  // any request regardless of `init.headers`.
  it('fails the way a real guarded endpoint would when no cookie is forwarded at all', async () => {
    await expect(loadDashboardData('')).rejects.toThrow(DashboardUnavailableError)
  })

  it('fails the same way for a stale/revoked session cookie', async () => {
    await expect(loadDashboardData(`${MOCK_SESSION_COOKIE_NAME}=${REVOKED_SESSION_TOKEN}`)).rejects.toThrow(
      DashboardUnavailableError,
    )
  })

  it('succeeds when a valid session cookie is forwarded', async () => {
    const data = await loadDashboardData(VALID_COOKIE)
    expect(typeof data.stats.activeLinks).toBe('number')
    expect(Array.isArray(data.links.items)).toBe(true)
  })
})
