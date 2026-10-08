import { fileURLToPath } from 'node:url'
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
/**
 * `rewrites()` below runs at BUILD time: Next freezes its result into
 * `.next/routes-manifest.json`, so `API_ORIGIN` must be present when
 * `next build` runs (a Docker build arg — apps/web/Dockerfile, fly.toml's
 * `[build.args]`), not only when the server starts. `src/lib/api.ts` reads
 * the same variable at runtime for server-side fetches, so both are set.
 *
 * Only the Docker image (apps/web/Dockerfile) sets `NEXT_OUTPUT=standalone`:
 * it emits a self-contained server with just the traced dependencies, which
 * keeps the production image small. `outputFileTracingRoot` points at the
 * monorepo root so the traced tree includes `packages/contracts`. Every other
 * build (dev, CI, the e2e harness) is unchanged.
 */
const standalone =
  process.env.NEXT_OUTPUT === 'standalone'
    ? {
        output: 'standalone' as const,
        outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
      }
    : {}

const nextConfig: NextConfig = {
  ...standalone,
  // Only the e2e harness sets this (`e2e/support/stack.ts`), so its production
  // build never overwrites a developer's `.next`. Unset, Next's default.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  rewrites() {
    const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001'
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }]
  },
}

export default nextConfig
