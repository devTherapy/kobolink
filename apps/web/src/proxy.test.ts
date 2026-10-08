import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { config, proxy } from './proxy'

/**
 * PLAN.md F2 "Done when": signed-out access to `/dashboard` redirects.
 * `proxy` is a plain function of a `NextRequest` — called directly, with no
 * dev server involved, matching the brief's "test the guard function
 * directly with a request lacking the cookie."
 */
describe('proxy — route protection', () => {
  it('redirects a request with no session cookie to /login?next=<path>', () => {
    const request = new NextRequest('https://kobolink.test/dashboard')

    const response = proxy(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://kobolink.test/login?next=%2Fdashboard')
  })

  it('preserves a nested path and query string in `next`', () => {
    const request = new NextRequest('https://kobolink.test/dashboard/links/aBcDeFgH?tab=payments')

    const response = proxy(request)

    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe('/dashboard/links/aBcDeFgH?tab=payments')
  })

  it('lets a request carrying the session cookie through unredirected', () => {
    const request = new NextRequest('https://kobolink.test/dashboard', {
      headers: { cookie: 'kobolink_session=some-token-value' },
    })

    const response = proxy(request)

    // `NextResponse.next()` is not a redirect — no Location header, and not
    // a 3xx status the way the signed-out case is.
    expect(response.headers.get('location')).toBeNull()
    expect(response.status).toBe(200)
  })

  it('treats an unrelated cookie (no session cookie present) the same as no cookie at all', () => {
    const request = new NextRequest('https://kobolink.test/dashboard', {
      headers: { cookie: 'some_other_cookie=1' },
    })

    const response = proxy(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://kobolink.test/login?next=%2Fdashboard')
  })
})

/**
 * Next 16 deprecated the `middleware` file convention in favour of `proxy`
 * (`⚠ The "middleware" file convention is deprecated`, printed on every
 * build). Running `next build` in a unit test is too heavy, so this pins the
 * two facts the warning depends on: the file is `src/proxy.ts` exporting
 * `proxy`, and no `src/middleware.*` file exists to trigger it. If both
 * conventions existed Next would also fail the build outright.
 */
describe('proxy — file convention', () => {
  const src = (name: string) => fileURLToPath(new URL(name, import.meta.url))

  it.each(['middleware.ts', 'middleware.js', 'middleware.tsx', 'middleware.mjs'])(
    'has no deprecated src/%s',
    (name) => {
      expect(existsSync(src(name))).toBe(false)
    },
  )

  it('keeps the guard on /dashboard only', () => {
    // Matcher is unchanged by the rename: nothing outside /dashboard — the
    // server-rendered /l/*, the /.well-known/* association handlers, /api —
    // ever enters the proxy.
    expect(config.matcher).toEqual(['/dashboard', '/dashboard/:path*'])
  })

  it('declares no `runtime` — the proxy runs on Node.js and `runtime` throws there', () => {
    const source = readFileSync(src('proxy.ts'), 'utf8')
    expect(source).not.toMatch(/runtime\s*[:=]/)
  })
})
