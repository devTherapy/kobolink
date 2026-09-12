import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DashboardStreamService } from '../src/dashboard/dashboard-stream.service.js'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'
import { openDashboardStream, type SseClient } from './support/sse-client.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * PLAN.md's B6 row: "a dropped connection reconnects" — this file is the
 * server-side half of that (see `DashboardStreamController`'s own doc
 * comment for what this PR does and does not implement for the client
 * side): a disconnected SSE connection's listener on
 * `DashboardStreamService`'s shared emitter is removed, not left behind,
 * across as many connect/disconnect cycles as a reconnecting client might
 * produce. `DashboardStreamService.listenerCount` is test-only
 * introspection (its own doc comment) that lets this assert the actual
 * invariant — no leaked listener — directly, instead of inferring it from
 * some indirect symptom.
 *
 * `waitUntil` below is the same idiom `checkout-verify.integration.test
 * .ts`'s `waitForBlockedBackend` uses: poll a real condition with a
 * bounded timeout, never a fixed `sleep` guessed to be "long enough" —
 * cleanup runs asynchronously off the `close` event, so there is a real
 * (small) window between calling `.close()` and the server having
 * processed it.
 */
describe('GET /api/stream/dashboard — connection lifecycle (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  function stream(): DashboardStreamService {
    return getCtx().app.get(DashboardStreamService)
  }

  async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (condition()) return
      await sleep(15)
    }
    if (!condition()) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
  }

  it('removes a merchant\'s channel listener once its connection closes', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-lifecycle-single@example.test')
    expect(stream().listenerCount(merchant.userId)).toBe(0)

    const client = await openDashboardStream(getCtx(), merchant.cookie)
    await waitUntil(() => stream().listenerCount(merchant.userId) === 1)

    client.close()
    await waitUntil(() => stream().listenerCount(merchant.userId) === 0)
  })

  it('two connections for the same merchant each remove only their own listener, never the other\'s', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-lifecycle-two@example.test')

    const first = await openDashboardStream(getCtx(), merchant.cookie)
    const second = await openDashboardStream(getCtx(), merchant.cookie)
    await waitUntil(() => stream().listenerCount(merchant.userId) === 2)

    first.close()
    await waitUntil(() => stream().listenerCount(merchant.userId) === 1)

    second.close()
    await waitUntil(() => stream().listenerCount(merchant.userId) === 0)
  })

  it('leaks no listener across many connect/disconnect cycles — a reconnecting client is always a clean subscribe+unsubscribe pair', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-lifecycle-reconnect@example.test')

    for (let i = 0; i < 8; i++) {
      const client: SseClient = await openDashboardStream(getCtx(), merchant.cookie)
      await waitUntil(() => stream().listenerCount(merchant.userId) === 1)
      client.close()
      await waitUntil(() => stream().listenerCount(merchant.userId) === 0)
    }

    expect(stream().listenerCount(merchant.userId)).toBe(0)
  })

  it('closing the whole Nest application cleanly tears down the dedicated LISTEN connection (no unhandled rejection/crash)', async () => {
    // A separate, throwaway context — this test tears it down itself (not
    // via the describe block's shared `afterAll`), so it must not reuse
    // the outer `ctx`.
    const local = await startApiTestContext()
    const merchant = await registerMerchant(local, 'sse-lifecycle-shutdown@example.test')
    const client = await openDashboardStream(local, merchant.cookie)

    // teardown() closes the app (running DashboardListenerService's
    // onModuleDestroy — ends its dedicated pg.Client — and DbService's own,
    // for the pool) and then stops the container; resolving cleanly, with
    // no unhandled rejection anywhere in that chain, is the assertion.
    client.close()
    await expect(local.teardown()).resolves.toBeUndefined()
  })
})
