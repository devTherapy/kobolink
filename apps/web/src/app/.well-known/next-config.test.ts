import { describe, expect, it } from 'vitest'
import nextConfig from '../../../next.config'

/**
 * "Served unredirected" is a Next.js config guarantee, not just a route
 * handler one: a 308 from `trailingSlash`, or a rewrite that happens to
 * match `/.well-known/*`, would break Apple's CDN validation exactly the
 * same way a route handler that 302s would. There is no server to boot in a
 * unit test, so this asserts the two ways `next.config.ts` could introduce
 * a redirect on this path without anyone touching the route handler at all.
 */
describe('next.config.ts and /.well-known', () => {
  it('does not enable trailingSlash — that would 308 the extensionless AASA path', () => {
    expect(nextConfig.trailingSlash).toBeFalsy()
  })

  it('defines no redirects', () => {
    expect(nextConfig.redirects).toBeUndefined()
  })

  it('has no rewrite rule whose source touches /.well-known', async () => {
    if (typeof nextConfig.rewrites !== 'function') {
      expect(nextConfig.rewrites).toBeUndefined()
      return
    }

    const result = await nextConfig.rewrites()
    const rules = Array.isArray(result)
      ? result
      : [...(result.beforeFiles ?? []), ...(result.afterFiles ?? []), ...(result.fallback ?? [])]

    for (const rule of rules) {
      expect(rule.source.startsWith('/.well-known')).toBe(false)
    }
  })
})
