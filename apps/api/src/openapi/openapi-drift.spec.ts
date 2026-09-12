import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildOpenApiDocument } from './build-openapi-document.js'

/**
 * The test that matters most for B7's "done when": `packages/contracts` and
 * the spec cannot disagree. `apps/api/openapi.json` is checked in for M0's
 * Swift/Kotlin generators to read without booting the API
 * (`generate-openapi.ts` writes it); this file is what keeps that copy
 * honest. It is regenerated fresh from the *live* Zod schemas on every test
 * run and compared, so a schema edited in `packages/contracts` without
 * re-running `npm run generate:openapi -w apps/api` fails the gate here —
 * never silently ships a stale spec.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const checkedInPath = path.resolve(here, '../../openapi.json')

describe('apps/api/openapi.json vs. a fresh build from the live contracts', () => {
  it('is exactly what building fresh produces right now — this is the drift check', () => {
    const checkedIn = JSON.parse(readFileSync(checkedInPath, 'utf8')) as unknown
    const fresh = buildOpenApiDocument()

    expect(
      checkedIn,
      'apps/api/openapi.json is stale. Run `npm run generate:openapi -w apps/api` and commit the result.',
    ).toEqual(fresh)
  })

  it('the check above is genuinely discriminating, not green by construction', () => {
    const fresh = buildOpenApiDocument()

    // Walks through a concrete, real-shaped disagreement: `ErrorCodeSchema`
    // (packages/contracts/src/errors.ts) is a z.enum(...). If someone added
    // an `ErrorCode` there — a new failure mode for B8's wallet transfer,
    // say — without regenerating, the checked-in spec's `ErrorCode.enum`
    // would list one fewer value than `ApiErrorSchema.code` actually
    // accepts. Reproduce exactly that shape of drift against the live
    // document and prove the equality check above would have caught it.
    const driftedAsIfANewErrorCodeShipped = structuredClone(fresh)
    const errorCode = driftedAsIfANewErrorCodeShipped.components.schemas.ErrorCode as { enum: string[] }
    errorCode.enum = errorCode.enum.filter((code) => code !== 'insufficient_funds')

    expect(driftedAsIfANewErrorCodeShipped).not.toEqual(fresh)

    // Same idea on a request/response field rather than an enum: PaymentLink
    // exposes `title`'s bound (LinkTitleSchema, max 120). A change there
    // ships a differently-bounded `maxLength` in the generated schema.
    const driftedAsIfATitleBoundChanged = structuredClone(fresh)
    const paymentLink = driftedAsIfATitleBoundChanged.components.schemas.PaymentLink as {
      properties: { title: { maxLength: number } }
    }
    paymentLink.properties.title.maxLength = paymentLink.properties.title.maxLength + 1

    expect(driftedAsIfATitleBoundChanged).not.toEqual(fresh)
  })
})
