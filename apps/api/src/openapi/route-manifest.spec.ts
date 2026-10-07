import { beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../app.module.js'
import { NotFoundController } from '../common/not-found.controller.js'
import { DashboardStreamController } from '../dashboard/dashboard-stream.controller.js'
import { type ControllerClass, type MountedRoute, mountedControllers, mountedRoutes } from './mounted-routes.js'
import { OpenApiController } from './openapi.controller.js'
import { ROUTES } from './route-manifest.js'

/**
 * The set of controllers under test is *derived* from `AppModule`'s real
 * import graph (`mountedControllers`), never typed out here. The first
 * version of this file kept a hand-maintained list, and B6's
 * `DashboardStreamController` merged without being added to it — so its
 * route was missing from the manifest and this test stayed green anyway.
 * A list you have to remember to extend is exactly the kind of check that
 * fails silently; walking the module graph cannot forget a module.
 *
 * Two controllers are excluded on purpose, and each exclusion is itself
 * asserted below to still be mounted — an exclusion for a controller that
 * no longer exists is stale and fails:
 *
 * - `NotFoundController` (`@All()`/`@All('*path')`) is a catch-all, not a
 *   route the contract describes.
 * - `OpenApiController` serves this very document rather than being
 *   described by it.
 */
const EXCLUDED_CONTROLLERS: readonly ControllerClass[] = [NotFoundController, OpenApiController]

function key(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`
}

describe('ROUTES vs. the controllers AppModule actually mounts', () => {
  let allMounted: ControllerClass[]
  let mounted: MountedRoute[]
  let mountedKeys: Set<string>
  const manifestKeys = new Set(ROUTES.map((route) => key(route)))

  beforeAll(async () => {
    allMounted = await mountedControllers(AppModule)
    mounted = mountedRoutes(allMounted.filter((controller) => !EXCLUDED_CONTROLLERS.includes(controller)))
    mountedKeys = new Set(mounted.map(key))
  })

  it('names at least one real route (the reflection technique itself works)', () => {
    expect(mounted.length).toBeGreaterThan(0)
  })

  it('finds every controller from AppModule, including the one the old hand-typed list missed', () => {
    // B6's controller is the regression this file exists to prevent — it is
    // named here so the walk is proven to reach a module other than the
    // ones B7 originally listed, not just the same set by another route.
    expect(allMounted).toContain(DashboardStreamController)
    expect(allMounted.length).toBeGreaterThan(EXCLUDED_CONTROLLERS.length)
  })

  it('excludes only controllers AppModule really mounts — a stale exclusion fails', () => {
    for (const excluded of EXCLUDED_CONTROLLERS) {
      expect(allMounted, `${excluded.name} is excluded but AppModule no longer mounts it`).toContain(excluded)
    }
  })

  it('has no manifest entry for a route no controller actually mounts', () => {
    const phantom = [...manifestKeys].filter((k) => !mountedKeys.has(k))
    expect(phantom).toEqual([])
  })

  it('is missing no route a controller actually mounts', () => {
    const missing = [...mountedKeys].filter((k) => !manifestKeys.has(k))
    expect(missing).toEqual([])
  })

  it('mounts exactly the 18 routes this document describes, no more, no fewer', () => {
    // A change to this number is either a new route (add it to ROUTES too)
    // or a route removed (delete its ROUTES entry) — never silent. B7
    // documented 13, B8 added 4 wallet routes, and B6's SSE stream is the
    // 18th.
    expect(mounted).toHaveLength(18)
    expect(ROUTES).toHaveLength(18)
  })

  it('agrees with the manifest on method, path and auth for every route, one by one', () => {
    const sortedMounted = [...mounted].sort((a, b) => key(a).localeCompare(key(b)))
    const sortedManifest = [...ROUTES]
      .map((route): MountedRoute => ({ method: route.method, path: route.path, auth: route.auth }))
      .sort((a, b) => key(a).localeCompare(key(b)))
    expect(sortedManifest).toEqual(sortedMounted)
  })

  it('reads auth off the real guards, so it can tell merchant-only from any-session from public', () => {
    // One of each, by name, so a bug that flattened every route to the same
    // mode could not pass the one-by-one comparison above by coincidence.
    const byKey = new Map(mounted.map((route) => [key(route), route.auth]))
    expect(byKey.get('GET /api/stream/dashboard')).toBe('merchant')
    expect(byKey.get('GET /api/wallet')).toBe('session')
    expect(byKey.get('GET /api/links/{code}/public')).toBe('none')
  })
})
