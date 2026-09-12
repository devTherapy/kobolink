import { DashboardEventSchema, type DashboardEvent } from '@kobolink/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'
import { openDashboardStream, type SseClient } from './support/sse-client.js'

/** A small interval, not the contract's real 15s recommendation — a real-time test asserting on the 15s default would make this suite minutes slower for no extra coverage. */
const HEARTBEAT_MS = 40

/**
 * PLAN.md's B6 row: "heartbeat keeps proxies from killing it". Proves the
 * heartbeat is a real, scheduled, repeating thing — not a one-off sent
 * once at connect — by reading the server-stamped `at` on three
 * consecutive heartbeats and checking the gaps between them land in the
 * right neighbourhood of the configured interval, rather than asserting
 * on wall-clock arrival time at the test process (which would also be
 * sensitive to Node scheduling jitter the assertion does not care about).
 *
 * `DASHBOARD_HEARTBEAT_MS` is set before `startApiTestContext()` compiles
 * the testing module — the same seam `api-test-context.ts` itself uses for
 * `DATABASE_URL` (`ConfigService` reads `process.env` once, at module
 * init).
 */
describe('GET /api/stream/dashboard — heartbeat (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  const openClients: SseClient[] = []

  beforeAll(async () => {
    process.env.DASHBOARD_HEARTBEAT_MS = String(HEARTBEAT_MS)
    ctx = await startApiTestContext()
  }, 120_000)

  afterEach(() => {
    for (const client of openClients.splice(0)) client.close()
  })

  afterAll(async () => {
    await ctx?.teardown()
    delete process.env.DASHBOARD_HEARTBEAT_MS
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  it('sends a heartbeat event repeatedly, at roughly the configured interval', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-heartbeat@example.test')
    const client = await openDashboardStream(getCtx(), merchant.cookie)
    openClients.push(client)

    const heartbeatAt = (frame: { data: unknown }): number => {
      const event = DashboardEventSchema.parse(frame.data) as Extract<DashboardEvent, { type: 'heartbeat' }>
      return new Date(event.at).getTime()
    }

    // Wait for three, not just two — a single gap could coincidentally
    // land close to right; three heartbeats give two independent gaps that
    // both have to be in the right neighbourhood.
    const timeoutMs = HEARTBEAT_MS * 20
    const first = await client.waitForFrame((f) => f.event === 'heartbeat', timeoutMs)
    const second = await client.waitForFrame((f) => f.event === 'heartbeat' && f.id !== first.id, timeoutMs)
    const third = await client.waitForFrame(
      (f) => f.event === 'heartbeat' && f.id !== first.id && f.id !== second.id,
      timeoutMs,
    )

    const firstGap = heartbeatAt(second) - heartbeatAt(first)
    const secondGap = heartbeatAt(third) - heartbeatAt(second)

    // Generous band (0.5x-6x the configured interval) — this asserts
    // "scheduled repeatedly, in this ballpark", not "precisely on the
    // millisecond", which no timer (Node's or a CI runner's) promises.
    // What it rules out with confidence: sent once and never again (no
    // second/third frame would ever arrive, and the waitForFrame calls
    // above would time out), or scheduled at the contract's real 15s
    // default instead of the test's configured override (15000 is nowhere
    // near this band).
    for (const gap of [firstGap, secondGap]) {
      expect(gap).toBeGreaterThan(HEARTBEAT_MS * 0.5)
      expect(gap).toBeLessThan(HEARTBEAT_MS * 6)
    }
  })

  it("every heartbeat carries a monotonically increasing id, and validates against the contract's own schema", async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-heartbeat-shape@example.test')
    const client = await openDashboardStream(getCtx(), merchant.cookie)
    openClients.push(client)

    const first = await client.waitForFrame((f) => f.event === 'heartbeat', HEARTBEAT_MS * 20)
    const second = await client.waitForFrame((f) => f.event === 'heartbeat' && f.id !== first.id, HEARTBEAT_MS * 20)

    expect(second.id).toBeGreaterThan(first.id)
    expect(() => DashboardEventSchema.parse(first.data)).not.toThrow()
    const event = DashboardEventSchema.parse(first.data)
    expect(event.type).toBe('heartbeat')
  })
})
