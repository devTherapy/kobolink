import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { middleware } from './middleware'

/**
 * PLAN.md F2 "Done when": signed-out access to `/dashboard` redirects.
 * `middleware` is a plain function of a `NextRequest` — called directly,
 * with no dev server involved, matching the brief's "test the middleware
 * function directly with a request lacking the cookie."
 */
describe('middleware — route protection', () => {
  it('redirects a request with no session cookie to /login?next=<path>', () => {
    const request = new NextRequest('https://kobolink.test/dashboard')

    const response = middleware(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://kobolink.test/login?next=%2Fdashboard')
  })

  it('preserves a nested path and query string in `next`', () => {
    const request = new NextRequest('https://kobolink.test/dashboard/links/aBcDeFgH?tab=payments')

    const response = middleware(request)

    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe('/dashboard/links/aBcDeFgH?tab=payments')
  })

  it('lets a request carrying the session cookie through unredirected', () => {
    const request = new NextRequest('https://kobolink.test/dashboard', {
      headers: { cookie: 'kobolink_session=some-token-value' },
    })

    const response = middleware(request)

    // `NextResponse.next()` is not a redirect — no Location header, and not
    // a 3xx status the way the signed-out case is.
    expect(response.headers.get('location')).toBeNull()
    expect(response.status).toBe(200)
  })

  it('treats an unrelated cookie (no session cookie present) the same as no cookie at all', () => {
    const request = new NextRequest('https://kobolink.test/dashboard', {
      headers: { cookie: 'some_other_cookie=1' },
    })

    const response = middleware(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://kobolink.test/login?next=%2Fdashboard')
  })
})
