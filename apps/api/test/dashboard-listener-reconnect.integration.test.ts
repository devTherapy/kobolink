import { randomUUID } from 'node:crypto'
import {
  API,
  InitializeCheckoutResponseSchema,
  PaymentLinkSchema,
  type DashboardEvent,
  DashboardEventSchema,
} from '@kobolink/contracts'
import { Client as PgClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DASHBOARD_LISTENER_APPLICATION_NAME } from '../src/dashboard/dashboard-listener.service.js'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'
import { openDashboardStream, type SseClient } from './support/sse-client.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntilAsync(condition: () => Promise<boolean>, timeoutMs = 15_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() >= deadline) throw new Error(`waitUntilAsync: condition not met within ${timeoutMs}ms`)
    await sleep(pollMs)
  }
}

/**
 * The one test in this suite that forces a *genuine* Postgres-level
 * disconnect on `DashboardListenerService`'s dedicated LISTEN connection —
 * as opposed to `dashboard-stream-lifecycle.integration.test.ts`, which only
 * ever disconnects the *SSE client* side, a different layer entirely that
 * was already covered before this PR.
 *
 * This is the regression test for the concurrent-reconnect-loop bug: `pg`
 * (v8.23.0, pinned in `apps/api/package.json`) emits `end` on *every*
 * underlying stream close, including one that happens mid-way through a
 * *failed* `connect()` call — so a naive "`end` → start a reconnect loop"
 * handler spawns one independent loop per failed attempt, on top of
 * whichever loop is already retrying. Reproducing that requires more than
 * severing the live connection once (a single drop followed by one
 * immediately-successful reconnect never exercises the race — there is no
 * failed attempt for a spurious `end` to race against). So this test:
 *
 *  1. Runs its own dedicated Postgres container with `max_connections`
 *     turned down (`configureContainer`, `api-test-context.ts`'s seam for
 *     this), so it is cheap to open enough throwaway connections to
 *     genuinely exhaust every slot.
 *  2. Terminates the LISTEN client's own backend by PID
 *     (`pg_terminate_backend`, found via `pg_stat_activity` filtered on
 *     `DASHBOARD_LISTENER_APPLICATION_NAME` — exported by the service for
 *     exactly this) — a real Postgres-level disconnect, not a simulated one.
 *  3. Holds every connection slot exhausted for a few seconds *after* that,
 *     so the reconnect attempts that follow don't just find a healthy
 *     server — they genuinely fail (`FATAL: sorry, too many clients
 *     already`), repeatedly, across more than one `RECONNECT_DELAY_MS`
 *     cycle. That repeated, genuine failure is what the old code turned
 *     into an exponentially growing number of concurrent reconnect loops.
 *  4. Frees the slots, gives every loop that might have been spawned (one,
 *     under the fix; more than one, under the bug) a real window to finish
 *     reconnecting, then posts a payment and asserts it is delivered to the
 *     subscriber exactly once — the assertion that fails under the old
 *     code (see this file's own verification note below) because every
 *     leaked, orphaned LISTEN client independently republishes the same
 *     `NOTIFY` to the same subscriber, each with a different event id.
 *
 * Verified against the pre-fix code (temporarily reverting
 * `dashboard-listener.service.ts`'s guard back to the unconditional
 * `client.on('end', () => { if (this.stopped) return; void
 * this.reconnectLoop() })`): this test fails, either on the "exactly one
 * live LISTEN backend" assertion (more than one survives) or on the
 * "exactly one payment.completed frame" assertion (more than one arrives,
 * each with a different `id`) — never passes cleanly. Reverting the fix
 * back is exactly how this was confirmed before landing it.
 */
describe('DashboardListenerService — reconnect after a genuine Postgres-level LISTEN disconnect (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  let admin: PgClient | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext({
      // Small enough that exhausting every slot from the test only needs a
      // couple dozen throwaway connections, not the driver's default 100 —
      // this test's own container, so nothing else is affected.
      configureContainer: (container) => container.withCommand(['postgres', '-c', 'max_connections=25']),
    })
    admin = new PgClient({ connectionString: ctx.connectionString, application_name: 'test-admin' })
    await admin.connect()
  }, 120_000)

  afterAll(async () => {
    await admin?.end()
    await ctx?.teardown()
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  function getAdmin(): PgClient {
    if (admin === undefined) throw new Error('beforeAll did not produce an admin connection — see its own failure above')
    return admin
  }

  async function listenerBackendPids(): Promise<number[]> {
    const { rows } = await getAdmin().query<{ pid: number }>(
      'select pid from pg_stat_activity where application_name = $1',
      [DASHBOARD_LISTENER_APPLICATION_NAME],
    )
    return rows.map((row) => row.pid)
  }

  function idempotencyKey(): string {
    return `test-idem-${randomUUID()}`
  }

  async function createLink(cookie: string): Promise<string> {
    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', cookie)
      .send({ title: 'A link', isReusable: true, amountKobo: 100_000 })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  async function pay(code: string, amountKobo: number): Promise<string> {
    const initResponse = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({ code, amountKobo, payerName: 'Chidinma Okafor', payerEmail: 'chidinma@example.test' })
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

  function isPaymentCompletedFor(reference: string) {
    return (frame: { event: string; data: unknown }): boolean => {
      if (frame.event !== 'payment.completed') return false
      const event = DashboardEventSchema.parse(frame.data) as Extract<DashboardEvent, { type: 'payment.completed' }>
      return event.payment.reference === reference
    }
  }

  it(
    'reconnects exactly once — never N times — after its LISTEN backend is terminated during a genuine connection-exhaustion window',
    async () => {
      const merchant = await registerMerchant(getCtx(), 'sse-pg-reconnect@example.test')
      const code = await createLink(merchant.cookie)
      const client: SseClient = await openDashboardStream(getCtx(), merchant.cookie)

      const [originalPid] = await listenerBackendPids()
      expect(originalPid).toBeDefined()

      // Open throwaway connections until Postgres itself refuses one — this
      // is what makes every reconnect attempt below a *genuine* failure (not
      // merely "the old connection is gone"), regardless of exactly how many
      // slots this container, this role, and everything else already
      // connected happen to leave free. `pg_stat_activity` also carries rows
      // for background workers (autovacuum, walwriter, ...) that never count
      // against `max_connections`, so this fills purely by trial rather than
      // computing a target number from that view.
      const fillers: PgClient[] = []
      async function fillEveryFreeSlot(): Promise<void> {
        for (;;) {
          const filler = new PgClient({
            connectionString: getCtx().connectionString,
            application_name: 'test-filler',
            connectionTimeoutMillis: 2_000,
          })
          try {
            await filler.connect()
          } catch {
            return
          }
          fillers.push(filler)
          if (fillers.length > 200) throw new Error('fixture: max_connections=25 did not exhaust within 200 filler connections')
        }
      }

      await fillEveryFreeSlot()
      expect(fillers.length).toBeGreaterThan(0)

      try {
        // The real Postgres-level disconnect this test is about — not a
        // client socket closing, a server-side termination of the LISTEN
        // client's own backend.
        await getAdmin().query('select pg_terminate_backend($1)', [originalPid])

        // Hold the exhaustion for a few `RECONNECT_DELAY_MS` cycles so more
        // than one reconnect attempt genuinely fails before any succeeds —
        // a single failed-then-immediately-freed attempt wouldn't exercise
        // the race the old code had (spurious `end` firing for a failed
        // attempt while another attempt for the same drop is also retrying).
        // Re-fills on every tick: anything else in the system (the pool,
        // Postgres's own background activity) freeing even one slot mid-way
        // would otherwise hand the listener's next attempt a way through
        // early, before enough failed cycles had happened to matter.
        const exhaustionDeadline = Date.now() + 3_000
        while (Date.now() < exhaustionDeadline) {
          await fillEveryFreeSlot()
          await sleep(100)
        }
      } finally {
        for (const filler of fillers.splice(0)) await filler.end()
      }

      // Settle window: let every reconnect loop that might be alive right
      // now — one, under the fix; possibly several, under the bug —
      // finish its next (now unblocked) connect attempt before either of
      // this test's own assertions run.
      await waitUntilAsync(async () => (await listenerBackendPids()).length >= 1, 15_000)
      await sleep(2_000)

      const liveBeforePayment = await listenerBackendPids()
      // This is the assertion the old code fails directly: every orphaned
      // reconnect loop eventually succeeds too, and none of them is ever
      // closed — so more than one backend survives.
      expect(liveBeforePayment).toHaveLength(1)
      expect(liveBeforePayment).not.toContain(originalPid)

      const reference = await pay(code, 100_000)
      const frame = await client.waitForFrame(isPaymentCompletedFor(reference), 10_000)
      expect(frame.event).toBe('payment.completed')

      // Give a duplicate delivery — the old bug's actual symptom, every
      // leaked listener republishing the same NOTIFY to the same
      // subscriber with a different event id — a real window to show up.
      await sleep(1_500)
      const matches = client.frames().filter(isPaymentCompletedFor(reference))
      expect(matches).toHaveLength(1)
      expect(matches[0]?.id).toBe(frame.id)

      client.close()
    },
    45_000,
  )
})
