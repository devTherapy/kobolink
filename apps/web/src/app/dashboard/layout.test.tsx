import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type * as NextNavigation from 'next/navigation'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN, REVOKED_SESSION_TOKEN } from '@/mocks/handlers'
import DashboardLayout from './layout'

/**
 * `next/headers`' `cookies()` throws outside an active Next.js request scope
 * (see its own source) — this stands in for that scope, the same role a
 * real request's cookie jar plays, letting `DashboardLayout` be called
 * directly the same way `/l/[code]`'s page tests call the page function
 * directly (see `src/app/l/[code]/page.test.tsx`). `vi.mock` is hoisted
 * above this file's imports by Vitest's transform, so the mock is in place
 * before `./layout` (and, transitively, `@/lib/session`) ever imports
 * `next/headers` for real.
 */
let cookieHeader = ''
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => cookieHeader }),
}))

// `DashboardHeader` renders `LogoutButton`, a client component that calls
// `useRouter()` — which throws outside a mounted `AppRouterContext`
// (`renderToStaticMarkup` provides none). `importOriginal` keeps the real
// `redirect` (which `layout.tsx` itself calls, and this file's own
// `catchThrown`/`redirectTarget` depend on) — replacing the whole module
// wholesale would silently turn `redirect` into `undefined` too.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

/** `redirect()` throws a special error carrying the destination in its digest — see `next/dist/client/components/redirect.js`. */
function redirectTarget(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const digest = (error as Error & { digest?: unknown }).digest
  if (typeof digest !== 'string') return null
  // "NEXT_REDIRECT;<type>;<url>;<statusCode>;"
  return digest.split(';')[2] ?? null
}

async function catchThrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('DashboardLayout — Done when: signed-out access to /dashboard redirects', () => {
  it('redirects to /login when there is no session cookie at all', async () => {
    cookieHeader = ''
    const error = await catchThrown(DashboardLayout({ children: null }))
    expect(redirectTarget(error)).toBe('/login?next=%2Fdashboard')
  })

  it('redirects to /login when the cookie is present but stale/revoked (auth.me 401s)', async () => {
    cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${REVOKED_SESSION_TOKEN}`
    const error = await catchThrown(DashboardLayout({ children: null }))
    expect(redirectTarget(error)).toBe('/login?next=%2Fdashboard')
  })

  it('renders the header with the merchant name for a valid session', async () => {
    cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`
    const element = await DashboardLayout({ children: <p>dashboard content</p> })
    const html = renderToStaticMarkup(element)

    expect(html).toContain('dashboard content')
    expect(html).toContain('Log out')
  })
})
