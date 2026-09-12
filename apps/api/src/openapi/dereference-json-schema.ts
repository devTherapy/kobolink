/**
 * `packages/contracts`' `jsonSchemas()` hands back, per named schema, a
 * self-contained JSON Schema (draft 2020-12) bundle: a `$ref` into a private
 * `$defs` map that inlines every nested named schema it touches (B7's
 * `registry.ts` doc comment). Two different top-level schemas can describe
 * the *same* nested id differently — `Email` is a plain string on the
 * `input` side of a request schema (pre-`.pipe(z.email())` normalisation)
 * and a `format: "email"` string on the `output` side of a response schema
 * (`REQUEST_SCHEMAS`/`isRequestSchema` in `registry.ts` is exactly this
 * `io: 'input' | 'output'` switch) — so `$defs` cannot be merged wholesale
 * across schemas into one shared `components.schemas` map without one
 * overwriting the other.
 *
 * The fix is to never share `$defs` across top-level schemas at all: this
 * function resolves every `$ref` in one schema's own bundle against its own
 * `$defs` and returns a fully self-contained schema with no `$ref`, no
 * `$defs`, no `$schema`. Each name in `components.schemas` is then built
 * from its own closure — duplicated where two top-level schemas share a
 * nested shape, but never wrong, and never dependent on generation order.
 */
export function dereferenceOwnDefs(entry: unknown): unknown {
  const record = entry as { readonly $defs?: Readonly<Record<string, unknown>> }
  const defs = record.$defs ?? {}

  function resolve(node: unknown, seen: readonly string[]): unknown {
    if (Array.isArray(node)) return node.map((item) => resolve(item, seen))
    if (node === null || typeof node !== 'object') return node

    const obj = node as Record<string, unknown>
    const ref = obj.$ref
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      const key = ref.slice('#/$defs/'.length)
      if (seen.includes(key)) {
        // None of today's contracts are recursive; a future one that is
        // would need a real `$ref`-preserving strategy, not this one.
        throw new Error(`openapi generation: cyclic $ref through '${key}' is not supported`)
      }
      const target = defs[key]
      if (target === undefined) {
        throw new Error(`openapi generation: dangling $ref '${ref}'`)
      }
      return resolve(target, [...seen, key])
    }

    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$schema' || key === '$defs') continue
      out[key] = resolve(value, seen)
    }
    return out
  }

  return resolve(entry, [])
}
