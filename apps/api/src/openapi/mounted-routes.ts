import { type DynamicModule, RequestMethod, type Type } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { MerchantGuard } from '../auth/merchant.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import type { AuthMode } from './route-manifest.js'

/**
 * Reads the *real* route metadata Nest's `@Controller`/`@Get`/`@Post`/...
 * decorators attach to a controller class — the same technique
 * `health.controller.spec.ts` uses for one route, generalised to every
 * method on a set of controllers. Used by `route-manifest.spec.ts` to prove
 * `ROUTES` (`route-manifest.ts`) names exactly the routes `AppModule`
 * actually mounts: a route added to, removed from, or reshaped in a
 * controller without a matching edit to `ROUTES` fails that test, in
 * either direction.
 *
 * `auth` is read the same way, off `@UseGuards` metadata at class and
 * method level, so the manifest's `AuthMode` for a route is checked against
 * the guards that actually run, not against what its author remembered.
 */
export interface MountedRoute {
  readonly method: 'get' | 'post' | 'put' | 'delete' | 'patch' | 'options' | 'head'
  /** Full path with the global `/api` prefix, OpenAPI-templated (`:code` → `{code}`). */
  readonly path: string
  readonly auth: AuthMode
}

export type ControllerClass = new (...args: never[]) => unknown

type ModuleClass = Type<unknown>
/** Nest's own `ForwardReference` types `forwardRef` as `any`; this is the shape `forwardRef(() => M)` actually produces. */
interface ForwardModuleReference {
  readonly forwardRef: () => ModuleImport
}
type ModuleImport = ModuleClass | DynamicModule | Promise<DynamicModule> | ForwardModuleReference

function segment(value: unknown): string {
  if (typeof value !== 'string' || value === '/' || value === '') return ''
  return value.replace(/^\/+|\/+$/g, '')
}

function toOpenApiTemplate(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function guardsOn(target: object): readonly unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as readonly unknown[] | undefined) ?? []
}

/**
 * Class-level `@UseGuards` run first, then method-level, each in decorator
 * order — so the concatenation below is the real execution order. Only the
 * two compositions this API uses are named: a route guarded by anything
 * else throws so the manifest's `AuthMode` grows a value for it rather
 * than mis-reporting, and so does `MerchantGuard` without `SessionGuard`
 * *ahead of it* — `merchant.guard.ts` calls that a bug (it 401s every
 * caller), and a bug should not be documented as a working merchant route.
 */
function authModeOf(controller: ControllerClass, handler: object, label: string): AuthMode {
  const ordered = [...guardsOn(controller), ...guardsOn(handler)]
  const unknown = ordered.filter((guard) => guard !== SessionGuard && guard !== MerchantGuard)
  if (unknown.length > 0) {
    const names = unknown.map((guard) => (guard as { name?: string }).name ?? String(guard))
    throw new Error(`mounted-routes: ${label} uses guards this manifest cannot classify: ${names.join(', ')}`)
  }
  const session = ordered.indexOf(SessionGuard)
  const merchant = ordered.indexOf(MerchantGuard)
  if (merchant !== -1 && (session === -1 || session > merchant)) {
    throw new Error(`mounted-routes: ${label} runs MerchantGuard without SessionGuard ahead of it`)
  }
  if (merchant !== -1) return 'merchant'
  if (session !== -1) return 'session'
  return 'none'
}

/** Every controller class Nest would actually route to (i.e. its prototype methods carry `@Get`/`@Post`/... metadata). */
export function mountedRoutes(controllers: readonly ControllerClass[]): MountedRoute[] {
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
      const method = prototype[propertyName] as object
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod | undefined
      if (requestMethod === undefined) continue

      const methodPath = segment(Reflect.getMetadata(PATH_METADATA, method) as unknown)
      const joined = [controllerPath, methodPath].filter((p) => p.length > 0).join('/')
      const fullPath = toOpenApiTemplate(joined === '' ? '/api' : `/api/${joined}`)

      routes.push({
        method: RequestMethod[requestMethod].toLowerCase() as MountedRoute['method'],
        path: fullPath,
        auth: authModeOf(controller, method, `${controller.name}.${propertyName}`),
      })
    }
  }

  return routes
}

function isForwardReference(value: object): value is ForwardModuleReference {
  return typeof (value as Partial<ForwardModuleReference>).forwardRef === 'function'
}

/**
 * Every controller class reachable from `root`'s `@Module({ imports })`
 * graph — the same set Nest's own scanner would mount, read off the very
 * metadata it reads, but without creating a Nest application: no injector,
 * no `DbService` opening a pool, no HTTP listener. (Importing `AppModule`
 * does still evaluate `ConfigModule.forRoot(...)`, which reads the `.env`
 * files it is pointed at synchronously — that is the one side effect of
 * this walk, and it is contained to the test worker.) That is what lets a
 * *unit* test (`route-manifest.spec.ts`, under `npm run test`) ask "what
 * does `AppModule` actually mount?" instead of trusting a hand-typed list
 * that a new feature module can silently fall outside of.
 *
 * Handles the three forms `imports` can take: a plain module class, a
 * `DynamicModule` (`{ module, imports?, controllers? }`) and a
 * `Promise<DynamicModule>` — `ConfigModule.forRoot()` is the last of these
 * — plus `forwardRef(() => M)`. A dynamic module's own `controllers` and
 * its static class's `@Module` metadata are merged, as Nest merges them.
 * A module class reached twice is walked once, but a controller listed by
 * two different modules is returned twice — Nest mounts it twice, and
 * `route-manifest.spec.ts`'s exact-count check should see that, not have
 * it tidied away here.
 */
export async function mountedControllers(root: ModuleClass): Promise<ControllerClass[]> {
  const seen = new Set<ModuleClass>()
  const controllers: ControllerClass[] = []

  const visitModule = async (module: ModuleClass, dynamic?: DynamicModule): Promise<void> => {
    if (seen.has(module)) return
    seen.add(module)
    const own = new Set<ControllerClass>([
      ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) as ControllerClass[] | undefined) ?? []),
      ...((dynamic?.controllers as ControllerClass[] | undefined) ?? []),
    ])
    controllers.push(...own)
    const imports = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as ModuleImport[] | undefined) ?? []),
      ...((dynamic?.imports as ModuleImport[] | undefined) ?? []),
    ]
    for (const child of imports) await visit(child)
  }

  const visit = async (entry: ModuleImport): Promise<void> => {
    const resolved = await entry
    if (typeof resolved === 'function') return visitModule(resolved)
    if (isForwardReference(resolved)) return visit(resolved.forwardRef())
    return visitModule(resolved.module, resolved)
  }

  await visit(root)
  return controllers
}
