import { describe, expect, it } from 'vitest'
import { AuthController } from '../auth/auth.controller.js'
import { HealthController } from '../health/health.controller.js'
import { LinksController } from '../links/links.controller.js'
import { PublicLinksController } from '../links/public-links.controller.js'
import { PaymentsController } from '../payments/payments.controller.js'
import { type MountedRoute, mountedRoutes } from './mounted-routes.js'
import { ROUTES } from './route-manifest.js'

/**
 * `NotFoundController` (`@All()`/`@All('*path')`) is a catch-all, not a
 * route the contract describes, and `OpenApiController` serves this very
 * document rather than being described by it — both are deliberately
 * excluded here, not forgotten.
 */
const REAL_CONTROLLERS = [
  HealthController,
  AuthController,
  LinksController,
  PublicLinksController,
  PaymentsController,
]

function key(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`
}

describe('ROUTES vs. the controllers AppModule actually mounts', () => {
  const mounted = mountedRoutes(REAL_CONTROLLERS)
  const mountedKeys = new Set(mounted.map(key))
  const manifestKeys = new Set(ROUTES.map((route) => key(route)))

  it('names at least one real route (the reflection technique itself works)', () => {
    expect(mounted.length).toBeGreaterThan(0)
  })

  it('has no manifest entry for a route no controller actually mounts', () => {
    const phantom = [...manifestKeys].filter((k) => !mountedKeys.has(k))
    expect(phantom).toEqual([])
  })

  it('is missing no route a controller actually mounts', () => {
    const missing = [...mountedKeys].filter((k) => !manifestKeys.has(k))
    expect(missing).toEqual([])
  })

  it('mounts exactly the 13 routes this feature documents, no more, no fewer', () => {
    // A change to this number is either a new route (add it to ROUTES too)
    // or a route removed (delete its ROUTES entry) — never silent.
    expect(mounted).toHaveLength(13)
    expect(ROUTES).toHaveLength(13)
  })

  it('agrees with the manifest on method and path for every route, one by one', () => {
    const sortedMounted = [...mounted].sort((a, b) => key(a).localeCompare(key(b)))
    const sortedManifest = [...ROUTES]
      .map((route): MountedRoute => ({ method: route.method, path: route.path }))
      .sort((a, b) => key(a).localeCompare(key(b)))
    expect(sortedManifest).toEqual(sortedMounted)
  })
})
