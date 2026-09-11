import type { NextConfig } from 'next'

/**
 * Locally, and in any environment without its own reverse proxy, the browser
 * must see one origin: `/api/*` is rewritten to the NestJS service so cookies
 * stay first-party and there is no CORS story. In production the two services
 * sit behind one hostname already (see docs/DESIGN-SPEC.md §7); this rewrite
 * is what makes `npm run dev` match that shape.
 *
 * When `NEXT_PUBLIC_API_MOCKING=enabled`, MSW's service worker intercepts
 * `/api/*` requests the *browser* makes before they reach this rewrite — a
 * client component's `fetch`, not a server component's. A server component
 * (SSR, route handlers) never goes through the browser's service worker, so
 * it still hits this rewrite and therefore the real `apps/api`, mocking flag
 * or not. Mocking a server-side fetch is `msw/node` wired into
 * `instrumentation.ts`, deliberately not done in this PR — see the PR
 * description.
 */
const nextConfig: NextConfig = {
  rewrites() {
    const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001'
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }]
  },
}

export default nextConfig
