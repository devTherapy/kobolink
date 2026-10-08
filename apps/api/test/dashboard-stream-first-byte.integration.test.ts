import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'
import { ensureListening } from './support/sse-client.js'

/** Far longer than this test waits: only something sent *because of the connect* can satisfy it. */
const HEARTBEAT_MS = 60_000

/**
 * Found by F9's full-stack e2e, not by any earlier suite: behind the Next.js
 * `/api/*` rewrite the browser's `EventSource` did not receive the response
 * head -- so never fired `open`, and the dashboard sat on "Connecting..." --
 * until the first heartbeat, a full 15 seconds after connecting.
 *
 * The cause is that a proxy that pipes the upstream response (Next's rewrite
 * does) only sends the head it was given along with the first body bytes
 * (Node's `ServerResponse` holds `writeHead` until the first write). This API
 * flushed its own head at once, so every direct client -- supertest, curl, the
 * other integration tests -- saw the stream open instantly, but sent nothing in
 * the body until the first heartbeat. The fix is for the body to start at
 * connect: this asserts that, by reading raw bytes with a heartbeat interval
 * far too long to be what delivers them.
 */
describe('GET /api/stream/dashboard — first byte (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    process.env.DASHBOARD_HEARTBEAT_MS = String(HEARTBEAT_MS)
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
    delete process.env.DASHBOARD_HEARTBEAT_MS
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }

  it('writes body bytes as soon as the connection opens, before any heartbeat is due', async () => {
    const merchant = await registerMerchant(getCtx(), 'sse-first-byte@example.test')
    const port = await ensureListening(getCtx())

    const firstChunk = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/stream/dashboard', method: 'GET', headers: { Cookie: merchant.cookie } },
        (res) => {
          res.setEncoding('utf8')
          res.once('data', (chunk: string) => {
            clearTimeout(timer)
            req.destroy()
            resolve(chunk)
          })
        },
      )
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error('no body bytes within 2s of the response head: a header-buffering proxy would hold the head back'))
      }, 2_000)
      req.on('error', () => undefined)
      req.end()
    })

    // A comment frame: every SSE parser (EventSource included) ignores it, so
    // it opens the stream without being an event the client could mistake for data.
    expect(firstChunk.startsWith(':')).toBe(true)
    expect(firstChunk.endsWith('\n\n')).toBe(true)
  })
})
