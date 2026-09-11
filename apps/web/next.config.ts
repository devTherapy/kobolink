import type { NextConfig } from 'next'

/**
 * Locally, and in any environment without its own reverse proxy, the browser
 * must see one origin: `/api/*` is rewritten to the NestJS service so cookies
 * stay first-party and there is no CORS story. In production the two services
 * sit behind one hostname already (see docs/DESIGN-SPEC.md §7); this rewrite
 * is what makes `npm run dev` match that shape.
 *
 * When `NEXT_PUBLIC_API_MOCKING=enabled`, MSW's service worker intercepts
 * `/api/*` in the browser before it ever reaches this rewrite.
 */
const nextConfig: NextConfig = {
  rewrites() {
    const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001'
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }]
  },
}

export default nextConfig
