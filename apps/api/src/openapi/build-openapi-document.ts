import { CONTRACTS_VERSION, SCHEMAS, type SchemaName, jsonSchemas } from '@kobolink/contracts'
import { SESSION_COOKIE_NAME } from '../auth/session-cookie.js'
import { dereferenceOwnDefs } from './dereference-json-schema.js'
import { type InlineSchema, ROUTES, type ResponseDef, type RouteDef } from './route-manifest.js'

/**
 * `GET /api/openapi.json` (`OpenApiController`) and `npm run generate:openapi`
 * (`generate-openapi.ts`, writing the checked-in `apps/api/openapi.json`)
 * both call this one function — there is exactly one way this document gets
 * built, so the served copy and the checked-in copy can never themselves
 * disagree with each other, only (if someone forgets to regenerate) with the
 * live one, which is exactly what `openapi-drift.spec.ts` checks for.
 *
 * Every schema in `components.schemas` comes from `@kobolink/contracts`'
 * `jsonSchemas()` — nothing here redeclares a shape by hand. Every path
 * comes from `ROUTES` (`route-manifest.ts`), whose own `path`s are built
 * from `API.*`, not typed out again. That is what makes "packages/contracts
 * and the spec cannot disagree" true by construction rather than by
 * discipline.
 */

type JsonSchema = Record<string, unknown>

function ref(name: SchemaName): { readonly $ref: string } {
  return { $ref: `#/components/schemas/${name}` }
}

function schemaOf(name: SchemaName | InlineSchema): JsonSchema {
  return typeof name === 'string' ? ref(name) : name.inline
}

/** Copies an already-dereferenced property's schema out of a real component — see `PathParamDef.source`'s doc comment. */
function extractProperty(
  componentSchemas: Record<string, JsonSchema>,
  source: { readonly schema: SchemaName; readonly property: string },
): JsonSchema {
  const parent = componentSchemas[source.schema] as { properties?: Record<string, JsonSchema> }
  const property = parent.properties?.[source.property]
  if (property === undefined) {
    throw new Error(`openapi generation: '${source.schema}' has no property '${source.property}'`)
  }
  return property
}

/** `components.schemas`: every named contract schema, fully self-contained (see `dereferenceOwnDefs`). */
function buildComponentSchemas(): Record<string, JsonSchema> {
  const schemas = jsonSchemas()
  const out: Record<string, JsonSchema> = {}
  for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
    out[name] = dereferenceOwnDefs(schemas[name]) as JsonSchema
  }
  return out
}

function buildParameters(route: RouteDef, componentSchemas: Record<string, JsonSchema>): unknown[] {
  const parameters: unknown[] = []

  for (const param of route.pathParams ?? []) {
    parameters.push({
      name: param.name,
      in: 'path',
      required: true,
      description: param.description,
      schema: extractProperty(componentSchemas, param.source),
    })
  }

  if (route.query) {
    const pageQuery = componentSchemas[route.query] as { properties?: Record<string, JsonSchema> }
    for (const [name, schema] of Object.entries(pageQuery.properties ?? {})) {
      parameters.push({ name, in: 'query', required: false, schema })
    }
  }

  if (route.idempotencyKey) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: 'Client-chosen key for one logical money-moving attempt. A replayed key returns the original result.',
      schema: ref('IdempotencyKey'),
    })
  }

  return parameters
}

function buildResponses(responses: readonly ResponseDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const response of responses) {
    out[String(response.status)] = {
      description: response.description,
      ...(response.schema === null
        ? {}
        : { content: { [response.mediaType ?? 'application/json']: { schema: schemaOf(response.schema) } } }),
    }
  }
  // Every route can fail; every failure is `ApiError`-shaped
  // (`HttpExceptionFilter`/`toApiErrorResponse`) with the status
  // `HTTP_STATUS_FOR_ERROR` names for its `code`. One shared `default`
  // response says so without hand-maintaining, per route, exactly which of
  // the eleven `ErrorCode` values that route's own code paths can throw —
  // `ApiErrorSchema`'s `code` enum already lists all eleven for a reader who
  // needs the detail.
  out.default = {
    description: 'An error. Body is `ApiError`; see its `code` for the machine-readable reason.',
    content: { 'application/json': { schema: ref('ApiError') } },
  }
  return out
}

/**
 * OpenAPI's `security` names credentials, not roles — a merchant-only route
 * accepts exactly the same cookie or bearer token as any session route, so
 * the role requirement has nowhere structural to go and is stated in prose
 * instead, appended to whatever the manifest already says about the route.
 */
const MERCHANT_ONLY =
  'Requires the merchant role: a signed-in customer gets `403` with `code: "forbidden"`, ' +
  'a missing or invalid credential `401` with `code: "unauthenticated"`.'

function buildDescription(route: RouteDef): string | undefined {
  const parts = [route.description, route.auth === 'merchant' ? MERCHANT_ONLY : undefined]
  const description = parts.filter((part): part is string => part !== undefined).join('\n\n')
  return description === '' ? undefined : description
}

function buildOperation(route: RouteDef, componentSchemas: Record<string, JsonSchema>): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    tags: [...route.tags],
    parameters: buildParameters(route, componentSchemas),
    responses: buildResponses(route.responses),
  }
  const description = buildDescription(route)
  if (description !== undefined) operation.description = description
  if (route.requestBody) {
    operation.requestBody = {
      required: true,
      description: route.requestBody.description,
      content: { 'application/json': { schema: ref(route.requestBody.schema) } },
    }
  }
  if (route.auth !== 'none') {
    // OR, not AND: a request needs the web cookie *or* a mobile bearer
    // token, never both — matches `extractToken`'s own precedence. The
    // same for `'merchant'`: the role is a check on the resolved user,
    // not a third credential (see `MERCHANT_ONLY`).
    operation.security = [{ sessionCookie: [] }, { bearerAuth: [] }]
  }
  return operation
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0'
  readonly info: { readonly title: string; readonly version: string; readonly description: string }
  readonly paths: Record<string, Record<string, unknown>>
  readonly components: {
    readonly schemas: Record<string, JsonSchema>
    readonly securitySchemes: Record<string, unknown>
  }
}

export function buildOpenApiDocument(): OpenApiDocument {
  const componentSchemas = buildComponentSchemas()
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of ROUTES) {
    const pathItem = (paths[route.path] ??= {})
    pathItem[route.method] = buildOperation(route, componentSchemas)
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Kobolink API',
      version: CONTRACTS_VERSION,
      description:
        'Generated from the Zod schemas in packages/contracts (registry.ts) and the route manifest in ' +
        'apps/api/src/openapi/route-manifest.ts. Do not hand-edit — run `npm run generate:openapi -w apps/api`.',
    },
    paths,
    components: {
      schemas: componentSchemas,
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE_NAME,
          description: 'Web session cookie, httpOnly. Set by `POST /api/auth/login` and `/register` for `client: "web"`.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Mobile session token, returned in `AuthResponse.token` for `client: "mobile"`.',
        },
      },
    },
  }
}
