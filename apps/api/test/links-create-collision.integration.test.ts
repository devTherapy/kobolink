import { API, newLinkCode, PaymentLinkSchema } from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LINK_CODE_GENERATOR, type LinkCodeGenerator } from '../src/links/link-code.generator.js'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'

/**
 * The B3 done-when's other half, alongside `links-get.integration.test.ts`'s
 * cross-merchant 404: "server generates the code and retries on collision"
 * (`packages/contracts/README.md`, `links.collection`). A true `links_pkey`
 * unique-violation is astronomically unlikely to happen on its own (8
 * characters from a 54-symbol alphabet), so this test controls it directly
 * through the `LINK_CODE_GENERATOR` DI seam (`LinksModule`'s own doc
 * comment) rather than trying to provoke a real collision statistically.
 */
describe('POST /api/links — code collision retry (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  // Codes queued to be handed out next, in order; once empty, falls back to
  // a real freshly generated code. Mutated per-test, read by the overridden
  // provider installed once at container start.
  const queuedCodes: string[] = []

  const stubGenerator: LinkCodeGenerator = () => queuedCodes.shift() ?? newLinkCode()

  beforeAll(async () => {
    ctx = await startApiTestContext({
      configureModule: (builder) => builder.overrideProvider(LINK_CODE_GENERATOR).useValue(stubGenerator),
    })
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  it('retries with a fresh code and still answers 201 when the generator first returns an already-taken code', async () => {
    const merchant = await registerMerchant(getCtx(), 'collision-retry@example.test')

    const firstResponse = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', merchant.cookie)
      .send({ title: 'First link — occupies its code' })
    expect(firstResponse.status).toBe(201)
    const takenCode = PaymentLinkSchema.parse(firstResponse.body).code

    // Force the very next call to newLinkCode() (inside LinksService.create)
    // to collide with the row that already exists; the call after that
    // falls through to a real, fresh code.
    queuedCodes.push(takenCode)

    const secondResponse = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', merchant.cookie)
      .send({ title: 'Second link — collides once, then retries' })

    expect(secondResponse.status).toBe(201)
    const secondLink = PaymentLinkSchema.parse(secondResponse.body)
    expect(secondLink.code).not.toBe(takenCode)
    expect(secondLink.title).toBe('Second link — collides once, then retries')

    // Both rows genuinely exist, independently, under their own codes.
    const getFirst = await getCtx().request.get(API.links.item(takenCode)).set('Cookie', merchant.cookie)
    expect(getFirst.status).toBe(200)
    const getSecond = await getCtx().request.get(API.links.item(secondLink.code)).set('Cookie', merchant.cookie)
    expect(getSecond.status).toBe(200)
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
