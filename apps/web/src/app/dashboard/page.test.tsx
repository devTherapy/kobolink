import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN } from '@/mocks/handlers'
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

describe('DashboardPage — Done when: matches the canvas, empty and loading states present', () => {
  it('renders the stat strip and the links table from the seeded snapshot', async () => {
    const element = await DashboardPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('Welcome back, Adebayo Stores.')

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
