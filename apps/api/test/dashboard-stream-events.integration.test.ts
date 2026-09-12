import { randomUUID } from 'node:crypto'
import {
  API,
  InitializeCheckoutResponseSchema,
  PaymentLinkSchema,
  type DashboardEvent,
  DashboardEventSchema,
} from '@kobolink/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'
import { openDashboardStream, type SseClient } from './support/sse-client.js'

/**
 * PLAN.md's B6 row's central "done when": two subscribers both receive an
 * event, fed by the `postings` NOTIFY trigger (`drizzle/0005_postings_
 * notify_dashboard.sql`) all the way through `DashboardListenerService` and
 * `DashboardStreamService` to two independent SSE connections — and a
 * merchant never receives another merchant's events, proven directly
 * (never inferred from "nothing arrived", which a slow test could get
 * right by accident) by checking a payment that *did* arrive for the
 * targeted merchant, then inspecting everything the other merchant's
 * stream received in the same window.
 */
describe('GET /api/stream/dashboard — events (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  const openClients: SseClient[] = []

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterEach(() => {
    for (const client of openClients.splice(0)) client.close()
  })

  afterAll(async () => {
    await ctx?.teardown()
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  function idempotencyKey(): string {
    return `test-idem-${randomUUID()}`
  }

  async function createLink(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', cookie)
      .send({ title: 'A link', isReusable: true, ...overrides })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  async function pay(code: string, amountKobo: number, payerEmail = 'chidinma@example.test'): Promise<string> {
    const initResponse = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({ code, amountKobo, payerName: 'Chidinma Okafor', payerEmail })
    if (initResponse.status !== 201) {
      throw new Error(`fixture initialize failed: ${initResponse.status} ${JSON.stringify(initResponse.body)}`)
    }
    const reference = InitializeCheckoutResponseSchema.parse(initResponse.body).reference

    const verifyResponse = await getCtx()
      .request.post(API.checkout.verify)
      .set('Idempotency-Key', idempotencyKey())
      .send({ reference })
    if (verifyResponse.status !== 200) {
      throw new Error(`fixture verify failed: ${verifyResponse.status} ${JSON.stringify(verifyResponse.body)}`)
    }
    return reference
  }

  async function connect(cookie: string): Promise<SseClient> {
    const client = await openDashboardStream(getCtx(), cookie)
    openClients.push(client)
    return client
  }

  function isPaymentCompletedFor(reference: string) {
    return (frame: { event: string; data: unknown }): boolean => {
      if (frame.event !== 'payment.completed') return false
      const event = DashboardEventSchema.parse(frame.data) as Extract<DashboardEvent, { type: 'payment.completed' }>
      return event.payment.reference === reference
    }
  }

  it('publishes a payment.completed event, with the stats snapshot embedded, to every subscriber for that merchant', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-events-happy@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })

    // At least one prior ctx.request call has already happened above
    // (registerMerchant, createLink), so the server is bound to a real
    // port by the time these connect.
    const first = await connect(merchant.cookie)
    const second = await connect(merchant.cookie)

    const reference = await pay(code, 500_000)

    const [firstFrame, secondFrame] = await Promise.all([
      first.waitForFrame(isPaymentCompletedFor(reference)),
      second.waitForFrame(isPaymentCompletedFor(reference)),
    ])

    // Same published occurrence — DashboardStreamService assigns one id
    // before fanning out to every subscriber's channel listener, so two
    // tabs seeing the same event agree on its id, not just its content.
    expect(firstFrame.id).toBe(secondFrame.id)
    expect(firstFrame.data).toEqual(secondFrame.data)

    const event = DashboardEventSchema.parse(firstFrame.data) as Extract<DashboardEvent, { type: 'payment.completed' }>
    expect(event.type).toBe('payment.completed')
    expect(event.payment.reference).toBe(reference)
    expect(event.payment.status).toBe('success')
    expect(event.payment.moneyMoved).toBe(true)
    expect(event.payment.amountKobo).toBe(500_000)
    // The stats snapshot reflects this payment having landed, not a stale
    // pre-payment read — DashboardListenerService computes it after the
    // posting (and its ledger entries) already committed.
    expect(event.stats.totalCollectedKobo).toBeGreaterThanOrEqual(500_000)
    expect(event.stats.paymentCount).toBeGreaterThanOrEqual(1)
  })

  it('publishes a payment.failed event (simulated decline) with no stats field', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-events-decline@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 200_000 })
    const client = await connect(merchant.cookie)

    const reference = await pay(code, 200_000, 'fail@example.test')

    const frame = await client.waitForFrame((f) => f.event === 'payment.failed')
    const event = DashboardEventSchema.parse(frame.data) as Extract<DashboardEvent, { type: 'payment.failed' }>
    expect(event.payment.reference).toBe(reference)
    expect(event.payment.status).toBe('failed')
    expect(event.payment.moneyMoved).toBe(false)
    expect('stats' in event).toBe(false)
  })

  it('never delivers one merchant\'s events to another merchant\'s stream', async () => {
    const merchantA = await registerMerchant(getCtx(), 'sse-events-scope-a@example.test')
    const merchantB = await registerMerchant(getCtx(), 'sse-events-scope-b@example.test')
    const codeA = await createLink(merchantA.cookie, { amountKobo: 300_000 })
    const codeB = await createLink(merchantB.cookie, { amountKobo: 400_000 })

    const streamA = await connect(merchantA.cookie)

    // B is paid first — if scoping ever regressed to one shared/global
    // channel, A's stream would see this arrive before its own payment.
    const referenceB = await pay(codeB, 400_000)
    const referenceA = await pay(codeA, 300_000)

    // Bounds the wait on a real, positive signal (A's own payment landing)
    // instead of "sleep a while and hope B's leaked event would have shown
    // up by now".
    const frame = await streamA.waitForFrame(isPaymentCompletedFor(referenceA))
    const event = DashboardEventSchema.parse(frame.data) as Extract<DashboardEvent, { type: 'payment.completed' }>
    expect(event.payment.reference).toBe(referenceA)

    const leaked = streamA
      .frames()
      .filter((f) => f.event === 'payment.completed' || f.event === 'payment.failed')
      .map((f) => (DashboardEventSchema.parse(f.data) as { payment?: { reference: string } }).payment?.reference)
    expect(leaked).not.toContain(referenceB)
    expect(leaked).toEqual([referenceA])
  })
})
