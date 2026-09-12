import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import type { ApiTestContext } from './api-test-context.js'

export interface SseFrame {
  id: number
  event: string
  data: unknown
}

export interface SseClient {
  /** Every complete frame received so far, in the order it arrived. */
  frames(): SseFrame[]
  /**
   * Resolves with the next frame matching `predicate` (default: any frame) —
   * checking already-buffered frames first, then waiting for a new one. This
   * is the suite's synchronisation point instead of a fixed `sleep`: a test
   * awaits exactly the event it is asserting on, never an arbitrary delay it
   * hopes was long enough (same idiom `checkout-verify.integration.test.ts`'s
   * `waitForBlockedBackend` uses for a different kind of "wait for a real
   * condition, not a timer").
   */
  waitForFrame(predicate?: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>
  /** Destroys the client socket — simulates a dropped connection / a closed browser tab. */
  close(): void
}

function parseFrame(raw: string): SseFrame | undefined {
  let id: number | undefined
  let event: string | undefined
  let data: string | undefined
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) id = Number(line.slice('id: '.length))
    else if (line.startsWith('event: ')) event = line.slice('event: '.length)
    else if (line.startsWith('data: ')) data = line.slice('data: '.length)
  }
  if (id === undefined || event === undefined || data === undefined) return undefined
  return { id, event, data: JSON.parse(data) as unknown }
}

/**
 * Binds `ctx.app` to a real, stable port, once. `startApiTestContext`
 * never calls `.listen()` itself — every other integration test only ever
 * goes through supertest, and supertest's own `Test` constructor
 * (`node_modules/supertest/lib/test.js`'s `serverAddress`) calls
 * `app.listen(0)` *for that one request* and — the detail that matters
 * here — closes it again in `end()` once the response is buffered
 * (`if (!addr) this._server = app.listen(0)`, then `server.close(...)`).
 * A plain `GET` that returns one JSON body never notices; an SSE stream
 * that is still open when the assertion runs would find the server
 * already closed under it. Calling `.listen(0)` here ourselves, before any
 * supertest request in the same test file, makes `app.address()` non-null
 * up front — supertest's own `!addr` check then sees a server already
 * listening and never touches (or closes) it.
 */
export async function ensureListening(ctx: ApiTestContext): Promise<number> {
  const server = ctx.app.getHttpServer() as Server
  const existing = server.address()
  if (existing !== null && typeof existing !== 'string') return existing.port
  await ctx.app.listen(0)
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('ensureListening: app.listen(0) did not bind to a TCP port')
  }
  return address.port
}

/**
 * Opens a real, raw HTTP connection to `GET /api/stream/dashboard` and
 * incrementally parses the SSE frames it streams back — supertest buffers
 * an entire response before handing it back, which cannot represent a
 * connection that is still open and receiving events (`checkout-verify
 * .integration.test.ts` and its siblings never need this; B6's SSE stream
 * is the first thing in this suite that does).
 */
export async function openDashboardStream(ctx: ApiTestContext, cookie: string): Promise<SseClient> {
  const port = await ensureListening(ctx)

  const frames: SseFrame[] = []
  const emitter = new EventEmitter()
  let buffer = ''

  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/stream/dashboard',
      method: 'GET',
      headers: { Cookie: cookie },
    },
    (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        // Drains every complete "\n\n"-terminated frame already in the buffer.
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary === -1) break
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = parseFrame(raw)
          if (frame !== undefined) {
            frames.push(frame)
            emitter.emit('frame', frame)
          }
        }
      })
    },
  )
  // A dropped connection this suite never intends to retry on — a failed
  // socket is a test failure via an unresolved waitForFrame timeout, not an
  // unhandled 'error' event crashing the process.
  req.on('error', () => undefined)
  req.end()

  return {
    frames: () => frames.slice(),
    waitForFrame(predicate = () => true, timeoutMs = 5_000) {
      const existing = frames.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)

      return new Promise((resolve, reject) => {
        const onFrame = (frame: SseFrame): void => {
          if (!predicate(frame)) return
          clearTimeout(timer)
          emitter.off('frame', onFrame)
          resolve(frame)
        }
        const timer = setTimeout(() => {
          emitter.off('frame', onFrame)
          reject(new Error(`openDashboardStream: timed out after ${timeoutMs}ms waiting for a matching SSE frame`))
        }, timeoutMs)
        emitter.on('frame', onFrame)
      })
    },
    close() {
      req.destroy()
    },
  }
}
