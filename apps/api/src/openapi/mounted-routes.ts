import { RequestMethod } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'

/**
 * Reads the *real* route metadata Nest's `@Controller`/`@Get`/`@Post`/...
 * decorators attach to a controller class — the same technique
 * `health.controller.spec.ts` uses for one route, generalised to every
 * method on a set of controllers. Used by `route-manifest.spec.ts` to prove
 * `ROUTES` (`route-manifest.ts`) names exactly the routes `AppModule`
 * actually mounts: a route added to, removed from, or reshaped in a
 * controller without a matching edit to `ROUTES` fails that test, in
 * either direction.
 */
export interface MountedRoute {
  readonly method: 'get' | 'post' | 'put' | 'delete' | 'patch' | 'options' | 'head'
  /** Full path with the global `/api` prefix, OpenAPI-templated (`:code` → `{code}`). */
  readonly path: string
}

function segment(value: unknown): string {
  if (typeof value !== 'string' || value === '/' || value === '') return ''
  return value.replace(/^\/+|\/+$/g, '')
}

function toOpenApiTemplate(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

/** Every controller class Nest would actually route to (i.e. its prototype methods carry `@Get`/`@Post`/... metadata). */
export function mountedRoutes(controllers: readonly (new (...args: never[]) => unknown)[]): MountedRoute[] {
  const routes: MountedRoute[] = []

  for (const controller of controllers) {
    const controllerPath = segment(Reflect.getMetadata(PATH_METADATA, controller) as unknown)
    const prototype = controller.prototype as Record<string, unknown>

    for (const propertyName of Object.getOwnPropertyNames(prototype)) {
      if (propertyName === 'constructor') continue
      // Nest's `@Get`/`@Post`/... decorators (`RequestMapping` internally)
      // define this metadata on the method *function itself*
      // (`descriptor.value`) — not on `(prototype, propertyName)`, which is
      // only how the class-level `@Controller` path is stored. Looking it
      // up the same way `@Controller`'s is (as `health.controller.spec.ts`
      // does for that one) silently finds nothing here.
      const method = prototype[propertyName]
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, method as object) as RequestMethod | undefined
      if (requestMethod === undefined) continue

      const methodPath = segment(Reflect.getMetadata(PATH_METADATA, method as object) as unknown)
      const joined = [controllerPath, methodPath].filter((p) => p.length > 0).join('/')
      const fullPath = toOpenApiTemplate(joined === '' ? '/api' : `/api/${joined}`)

      routes.push({
        method: RequestMethod[requestMethod].toLowerCase() as MountedRoute['method'],
        path: fullPath,
      })
    }
  }

  return routes
}
