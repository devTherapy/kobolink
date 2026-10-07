import { randomUUID } from 'node:crypto'
import { API, InitializeCheckoutResponseSchema, PaymentLinkSchema } from '@kobolink/contracts'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DashboardStreamService } from '../src/dashboard/dashboard-stream.service.js'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'
import { openDashboardStream, type SseClient } from './support/sse-client.js'

/** Short, so the idle-revocation test (the heartbeat tick is its only trigger) stays fast. */
const HEARTBEAT_MS = 100
/** The bound a revoked/expired stream must end within: a few heartbeat ticks, far under the real 15s. */
const END_WITHIN_MS = 3_000
const PASSWORD = 'correct horse battery staple'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A stream authenticates once, at connect (`SessionGuard`). Without a
 * re-check, a tab whose session was later revoked (logout elsewhere, admin
 * revoke) or expired kept receiving the merchant's payment events until the
 * connection happened to drop. These tests pin the contract: once the
 * session behind an open stream stops resolving, nothing further is
 * delivered, the response ends, and the connection's listener is released.
 */
describe('GET /api/stream/dashboard — session revocation (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined
  let pool: Pool | undefined
  const openClients: SseClient[] = []

  beforeAll(async () => {
    process.env.DASHBOARD_HEARTBEAT_MS = String(HEARTBEAT_MS)
    ctx = await startApiTestContext()
    pool = new Pool({ connectionString: getCtx().connectionString })
  }, 120_000)

  afterEach(() => {
    for (const client of openClients.splice(0)) client.close()
  })

  afterAll(async () => {
    await pool?.end()
    await ctx?.teardown()
    delete process.env.DASHBOARD_HEARTBEAT_MS
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  function getPool(): Pool {
    if (pool === undefined) throw new Error('beforeAll did not produce a pool — see its own failure above')
    return pool
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

  async function connect(cookie: string): Promise<SseClient> {
    const client = await openDashboardStream(getCtx(), cookie)
    openClients.push(client)
    return client
  }

  /** A second, independent session for the same merchant, as the Cookie header value. */
  async function loginAgain(email: string): Promise<string> {
    const response = await getCtx().request.post(API.auth.login).send({ email, password: PASSWORD, client: 'web' })
    if (response.status !== 200) throw new Error(`fixture login failed: ${response.status} ${JSON.stringify(response.body)}`)
    const setCookie = response.headers['set-cookie'] as string[] | string
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c) => c.split(';')[0])
      .find((c) => c?.startsWith('kobolink_session='))
    if (cookie === undefined) throw new Error('no session cookie on login')
    return cookie
  }

  /** The merchant's registration session (the oldest, so unaffected by `loginAgain`). */
  async function firstSessionId(userId: string): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      'select id from sessions where user_id = $1 order by created_at asc limit 1',
      [userId],
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('no session row for fixture user')
    return id
  }

  async function createLink(cookie: string): Promise<string> {
    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', cookie)
      .send({ title: 'A link', isReusable: true, amountKobo: 250_000 })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  async function pay(code: string): Promise<string> {
    const init = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', `test-idem-${randomUUID()}`)
      .send({ code, amountKobo: 250_000, payerName: 'Chidinma Okafor', payerEmail: 'chidinma@example.test' })
    if (init.status !== 201) throw new Error(`fixture initialize failed: ${init.status} ${JSON.stringify(init.body)}`)
    const reference = InitializeCheckoutResponseSchema.parse(init.body).reference
    const verify = await getCtx()
      .request.post(API.checkout.verify)
      .set('Idempotency-Key', `test-idem-${randomUUID()}`)
      .send({ reference })
    if (verify.status !== 200) throw new Error(`fixture verify failed: ${verify.status} ${JSON.stringify(verify.body)}`)
    return reference
  }

  function paymentFrames(client: SseClient): string[] {
    return client
      .frames()
      .filter((f) => f.event === 'payment.completed' || f.event === 'payment.failed')
      .map((f) => f.event)
  }

  it('logout elsewhere: the open stream receives nothing further, ends, and releases its listener', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-revoke-logout@example.test')
    const code = await createLink(merchant.cookie)
    const client = await connect(merchant.cookie)
    await waitUntil(() => stream().listenerCount(merchant.userId) === 1)

    // The real revocation path: POST /api/auth/logout with the same credential.
    const logout = await getCtx().request.post(API.auth.logout).set('Cookie', merchant.cookie)
    expect(logout.status).toBe(204)

    await pay(code)

    await client.waitForEnd(END_WITHIN_MS)
    expect(paymentFrames(client)).toEqual([])
    await waitUntil(() => stream().listenerCount(merchant.userId) === 0)
  })

  it('session expiry: the open stream receives nothing further and ends', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-revoke-expiry@example.test')
    const code = await createLink(merchant.cookie)
    const sessionId = await firstSessionId(merchant.userId)
    const client = await connect(merchant.cookie)
    await waitUntil(() => stream().listenerCount(merchant.userId) === 1)

    await getPool().query(`update sessions set expires_at = now() - interval '1 day' where id = $1`, [sessionId])

    await pay(code)

    await client.waitForEnd(END_WITHIN_MS)
    expect(paymentFrames(client)).toEqual([])
    await waitUntil(() => stream().listenerCount(merchant.userId) === 0)
  })

  it('an idle stream (no events at all) ends on a heartbeat tick after an admin revokes its session', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-revoke-idle@example.test')
    const sessionId = await firstSessionId(merchant.userId)
    const client = await connect(merchant.cookie)
    await waitUntil(() => stream().listenerCount(merchant.userId) === 1)

    // Not through the logout endpoint: a direct row update, as an admin tool would.
    await getPool().query('update sessions set revoked_at = now() where id = $1', [sessionId])

    await client.waitForEnd(END_WITHIN_MS)
    await waitUntil(() => stream().listenerCount(merchant.userId) === 0)
  })

  it("revoking one session leaves the same merchant's other stream open and still receiving", async () => {
    const email = 'sse-revoke-sibling@example.test'
    const merchant = await registerMerchant(getCtx(), email)
    const siblingCookie = await loginAgain(email)
    const code = await createLink(merchant.cookie)
    const revoked = await connect(merchant.cookie)
    const kept = await connect(siblingCookie)
    await waitUntil(() => stream().listenerCount(merchant.userId) === 2)

    const logout = await getCtx().request.post(API.auth.logout).set('Cookie', merchant.cookie)
    expect(logout.status).toBe(204)

    const reference = await pay(code)

    const frame = await kept.waitForFrame((f) => f.event === 'payment.completed')
    expect((frame.data as { payment: { reference: string } }).payment.reference).toBe(reference)
    await revoked.waitForEnd(END_WITHIN_MS)
    expect(paymentFrames(revoked)).toEqual([])
    await waitUntil(() => stream().listenerCount(merchant.userId) === 1)
  })
})
