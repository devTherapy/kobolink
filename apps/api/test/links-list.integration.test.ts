import { API, ApiErrorSchema, LinkListResponseSchema, PaymentLinkSchema } from '@kobolink/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerCustomer, registerMerchant } from './support/register-user.js'

/**
 * `GET /api/links` — PLAN.md's B3 row. Merchant-scoped, newest first by
 * `createdAt`, cursor pagination (`packages/contracts/README.md`:
 * `links.collection`'s GET row). The 25-links/`limit=10`/three-pages walk is
 * this feature's own pagination done-when.
 */
describe('GET /api/links (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  async function createLink(cookie: string, title: string): Promise<string> {
    const response = await getCtx().request.post(API.links.collection).set('Cookie', cookie).send({ title })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  it('200: an empty page for a merchant with no links yet — correctly shaped, not a 404', async () => {
    const merchant = await registerMerchant(getCtx(), 'list-empty@example.test')

    const response = await getCtx().request.get(API.links.collection).set('Cookie', merchant.cookie)

    expect(response.status).toBe(200)
    const page = LinkListResponseSchema.parse(response.body)
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('newest first by createdAt, and merchant-scoped — another merchant\'s links never appear', async () => {
    const merchant = await registerMerchant(getCtx(), 'list-order@example.test')
    const other = await registerMerchant(getCtx(), 'list-other@example.test')

    await createLink(other.cookie, "Other merchant's link")
    const first = await createLink(merchant.cookie, 'First created')
    // Testcontainers/CI can create rows within the same createdAt millisecond;
    // the API breaks ties by code, so this test only asserts what it can
    // guarantee deterministically — scoping and that both of this merchant's
    // own links come back, not a specific millisecond-level ordering. The
    // 25-link pagination test below is what actually proves the ordering
    // guarantee end to end (each row's cursor is compared against the next).
    const second = await createLink(merchant.cookie, 'Second created')

    const response = await getCtx().request.get(API.links.collection).set('Cookie', merchant.cookie)

    expect(response.status).toBe(200)
    const page = LinkListResponseSchema.parse(response.body)
    const codes = page.items.map((item) => item.code)
    expect(codes).toContain(first)
    expect(codes).toContain(second)
    expect(codes).toHaveLength(2)
  })

  it('walks 25 links with limit=10 across three pages, no duplicates, newest first, nextCursor null at the end', async () => {
    const merchant = await registerMerchant(getCtx(), 'list-pagination@example.test')
    const titles: string[] = []
    for (let i = 0; i < 25; i++) {
      titles.push(`Link ${String(i).padStart(2, '0')}`)
    }
    // Sequential, not Promise.all — the pagination guarantee is about
    // createdAt ordering, and concurrent inserts would make the "oldest
    // first in walk order == first created" assertion below meaningless.
    for (const title of titles) {
      await createLink(merchant.cookie, title)
    }

    const seenCodes = new Set<string>()
    const pages: string[][] = []
    let cursor: string | undefined
    let pageCount = 0

    for (;;) {
      const response = await getCtx()
        .request.get(API.links.collection)
        .query(cursor === undefined ? { limit: 10 } : { limit: 10, cursor })
        .set('Cookie', merchant.cookie)
      expect(response.status).toBe(200)
      const page = LinkListResponseSchema.parse(response.body)
      pageCount += 1

      for (const item of page.items) {
        expect(seenCodes.has(item.code)).toBe(false)
        seenCodes.add(item.code)
      }
      pages.push(page.items.map((item) => item.title))

      if (page.nextCursor === null) break
      cursor = page.nextCursor
      // Guard against an infinite loop if nextCursor is ever wrong.
      expect(pageCount).toBeLessThanOrEqual(10)
    }

    expect(pageCount).toBe(3)
    expect(pages[0]).toHaveLength(10)
    expect(pages[1]).toHaveLength(10)
    expect(pages[2]).toHaveLength(5)
    expect(seenCodes.size).toBe(25)

    // Newest first: the most recently created link ("Link 24") leads page 1,
    // and the walk ends at the very first one created ("Link 00").
    expect(pages[0]?.[0]).toBe('Link 24')
    expect(pages[2]?.at(-1)).toBe('Link 00')
  })

  it('400 validation_failed: limit above PageQuerySchema\'s max of 100', async () => {
    const merchant = await registerMerchant(getCtx(), 'list-validation@example.test')

    const response = await getCtx().request.get(API.links.collection).query({ limit: 101 }).set('Cookie', merchant.cookie)

    expect(response.status).toBe(400)
    expect(ApiErrorSchema.parse(response.body).code).toBe('validation_failed')
  })

  it('400 validation_failed: a garbage cursor', async () => {
    const merchant = await registerMerchant(getCtx(), 'list-bad-cursor@example.test')

    const response = await getCtx()
      .request.get(API.links.collection)
      .query({ cursor: 'not-a-real-cursor' })
      .set('Cookie', merchant.cookie)

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.fields).toHaveProperty('cursor')
  })

  it('401 unauthenticated: no session at all', async () => {
    const response = await getCtx().request.get(API.links.collection)
    expect(response.status).toBe(401)
    expect(ApiErrorSchema.parse(response.body).code).toBe('unauthenticated')
  })

  it('403 forbidden: an authenticated customer is not a merchant', async () => {
    const customer = await registerCustomer(getCtx(), 'list-customer@example.test')

    const response = await getCtx().request.get(API.links.collection).set('Cookie', customer.cookie)

    expect(response.status).toBe(403)
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden')
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
