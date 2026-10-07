import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { API } from '@kobolink/contracts'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { linkStore, paymentsByCode } from '@/mocks/state'
import DashboardPage from './page'

/**
 * Same seam `dashboard/layout.test.tsx` uses: `next/headers`'s `cookies()`
 * throws outside an active Next.js request scope, so this stands in for
 * that scope and lets `DashboardPage` (and, transitively, `getSession()` and
 * `loadDashboardData()`) be called directly.
 */
const cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => cookieHeader }),
}))

/**
 * `NewLinkButton` (F4's client island) calls `useRouter()`, which needs the
 * App Router mounted — it is not, under `renderToStaticMarkup`. Rendering the
 * closed CTA only needs the hook not to throw.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  // `redirect()` throws a tagged error; this stands in for it so a test can see where it pointed.
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`)
  },
}))

describe('DashboardPage — Done when: matches the canvas, empty and loading states present', () => {
  it('renders the stat strip and the links table from the seeded snapshot', async () => {
    const element = await DashboardPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('Welcome back, Adebayo Stores.')

    // F4: the CTA is wired in, and the drawer it opens is not in the markup until used.
    expect(html).toContain('New link')
    expect(html).not.toContain('role="dialog"')

    // Stat strip — read from DashboardStats, matching the seeded fixture.
    expect(html).toContain('Total collected')
    expect(html).toContain('₦55,500')
    expect(html).toContain('Payments')
    expect(html).toContain('Active links')

    // Links table.
    expect(html).toContain('Ankara Two-Piece Set')
    expect(html).toContain('₦18,500')
    expect(html).toContain('Active')
  })

  it('renders EmptyState, not a blank table, for a merchant with zero links', async () => {
    linkStore.clear()
    paymentsByCode.clear()

    const element = await DashboardPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('No links yet')
    expect(html).toContain('Total collected')
    expect(html).toContain('₦0')
    expect(html).not.toContain('Ankara Two-Piece Set')
  })
})

/**
 * What the visitor actually sees for each way the two reads can fail. Only the
 * retryable failures may reach `error.tsx` (a thrown error): in production
 * Next replaces a Server Component error's name and message with a digest, so
 * that boundary cannot tell one class from another and anything thrown would
 * read as "couldn't reach the servers". The others render here, in the page.
 */
describe('DashboardPage — failures keep their class', () => {
  it('sends a visitor whose session expired between layout and page to sign-in', async () => {
    server.use(
      http.get(API.dashboard.stats, () =>
        HttpResponse.json({ code: 'unauthenticated', message: 'Sign in.' }, { status: 401 }),
      ),
    )
    await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT:/login?next=%2Fdashboard')
  })

  it('tells a customer account it cannot use the merchant dashboard, with no retry and no claim about servers', async () => {
    server.use(
      http.get(API.dashboard.stats, () =>
        HttpResponse.json({ code: 'forbidden', message: 'Merchant role required.' }, { status: 403 }),
      ),
    )
    const html = renderToStaticMarkup(await DashboardPage())

    expect(html).toContain('This account can&#x27;t use the merchant dashboard')
    expect(html).toMatch(/Nothing was changed/)
    expect(html).toMatch(/Log out/)
    expect(html).not.toMatch(/Try again/i)
    expect(html).not.toMatch(/reach(ing)? Kobolink/i)
    expect(html).not.toContain('Total collected')
  })

  it('reports a body that breaks the contract as an unexpected response, not as unreachable servers', async () => {
    server.use(http.get(API.dashboard.stats, () => HttpResponse.json({ totalCollectedKobo: 'a lot' })))
    const html = renderToStaticMarkup(await DashboardPage())

    expect(html).toContain('Kobolink sent back something unexpected')
    expect(html).toMatch(/Nothing was changed/)
    expect(html).not.toMatch(/reach(ing)? Kobolink/i)
    expect(html).toContain('href="/dashboard"')
  })

  it('still throws a real 5xx to the error boundary, which keeps the retryable message', async () => {
    server.use(
      http.get(API.dashboard.stats, () => HttpResponse.json({ code: 'internal', message: 'boom' }, { status: 500 })),
    )
    await expect(DashboardPage()).rejects.toMatchObject({ name: 'DashboardUnavailableError' })
  })
})
