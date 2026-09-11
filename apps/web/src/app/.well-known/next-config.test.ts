import { describe, expect, it } from 'vitest'
import nextConfig from '../../../next.config'

/**
 * "Served unredirected" is a Next.js config guarantee, not just a route
 * handler one: a 308 from `trailingSlash`, or a rewrite/redirect that happens
 * to match `/.well-known/*`, would break Apple's CDN validation exactly the
 * same way a route handler that 302s would. There is no server to boot in a
 * unit test, so this asserts the ways `next.config.ts` could introduce a
 * redirect on this path without anyone touching the route handler at all.
 */

const WELL_KNOWN_PATHS = ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']

/**
 * A conservative matcher for the `source` pattern syntax Next.js's
 * redirects/rewrites config uses — the same param syntax as file-system
 * routes: literal segments, `:name` (one segment), `:name*` (zero or more
 * segments), `:name+` (one or more segments). It only has to answer one
 * narrow question — could this pattern match one of the two literal
 * `.well-known` paths? — not fully reimplement path-to-regexp, so anything
 * this doesn't recognise is treated as a literal segment.
 */
function sourceMightMatch(source: string, target: string): boolean {
  const pattern = source
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        if (segment.endsWith('*')) return '.*'
        if (segment.endsWith('+')) return '[^/]+(?:/[^/]+)*'
        return '[^/]+'
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')

  return new RegExp(`^${pattern}$`).test(target)
}

describe('sourceMightMatch (self-test)', () => {
  it('flags a root catch-all as a match', () => {
    expect(sourceMightMatch('/:path*', '/.well-known/apple-app-site-association')).toBe(true)
  })

  it('does not flag an unrelated catch-all', () => {
    expect(sourceMightMatch('/api/:path*', '/.well-known/apple-app-site-association')).toBe(false)
  })

  it('does not flag an unrelated literal redirect', () => {
    expect(sourceMightMatch('/old-page', '/.well-known/apple-app-site-association')).toBe(false)
  })
})

describe('next.config.ts and /.well-known', () => {
  it('does not enable trailingSlash — that would 308 the extensionless AASA path', () => {
    expect(nextConfig.trailingSlash).toBeFalsy()
  })

  it('has no redirect rule whose source could match either association path', async () => {
    if (typeof nextConfig.redirects !== 'function') {
      expect(nextConfig.redirects).toBeUndefined()
      return
    }

    const rules = await nextConfig.redirects()
    for (const rule of rules) {
      for (const path of WELL_KNOWN_PATHS) {
        expect(sourceMightMatch(rule.source, path), `redirect source "${rule.source}" could match ${path}`).toBe(
          false,
        )
      }
    }
  })

  it('has no beforeFiles rewrite whose source could match either association path', async () => {
    if (typeof nextConfig.rewrites !== 'function') {
      expect(nextConfig.rewrites).toBeUndefined()
      return
    }

    // Only `beforeFiles` rewrites run ahead of Next's filesystem-route check
    // (which includes this app's own Route Handlers). A plain array return,
    // or the object form's `afterFiles`/`fallback`, are checked *after* the
    // filesystem — so they can never hijack a path that already resolves to
    // an existing route handler, and only `beforeFiles` is a real threat.
    const result = await nextConfig.rewrites()
    const beforeFiles = Array.isArray(result) ? [] : (result.beforeFiles ?? [])

    for (const rule of beforeFiles) {
      for (const path of WELL_KNOWN_PATHS) {
        expect(
          sourceMightMatch(rule.source, path),
          `beforeFiles rewrite source "${rule.source}" could match ${path}`,
        ).toBe(false)
      }
    }
  })
})
