import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API,
  SSE_HEARTBEAT_MS,
  exampleUser,
  examplePayment,
  exampleStats,
  type DashboardEvent,
} from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { FakeEventSource } from '@/test/fake-event-source'
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STALE_AFTER_HEARTBEATS,
  configuredHeartbeatMs,
  openDashboardStream,
  parseDashboardEvent,
  probeMerchantSession,
  reconnectDelayMs,
  type DashboardStream,
  type SessionProbe,
  type LiveEvent,
  type StreamStatus,
} from './dashboard-stream'

const payment = examplePayment({ reference: 'kbl_aaaaaaaaaa' })
const completed: DashboardEvent = { type: 'payment.completed', payment, stats: exampleStats() }
const heartbeat: DashboardEvent = { type: 'heartbeat', at: '2026-06-15T12:00:15.000Z' }

describe('parseDashboardEvent', () => {
  it('accepts every frame that matches the contract, heartbeats included', () => {
    expect(parseDashboardEvent(JSON.stringify(completed))).toEqual(completed)
    expect(parseDashboardEvent(JSON.stringify(heartbeat))).toEqual(heartbeat)
  })

  it('drops — never throws on — anything else', () => {
    expect(parseDashboardEvent('not json')).toBeNull()
    expect(parseDashboardEvent(JSON.stringify({ type: 'payment.completed' }))).toBeNull()
    expect(parseDashboardEvent(JSON.stringify({ type: 'mystery' }))).toBeNull()
    expect(parseDashboardEvent(undefined)).toBeNull()
    expect(parseDashboardEvent(42)).toBeNull()
  })

  it('rejects a payment whose moneyMoved contradicts its status — the contract invariant holds on the wire too', () => {
    const lying = { ...completed, payment: { ...payment, moneyMoved: false } }
    expect(parseDashboardEvent(JSON.stringify(lying))).toBeNull()
  })
})

describe('reconnectDelayMs', () => {
  it('doubles from about a second up to a cap, with jitter that only ever shortens the wait by half', () => {
    expect(reconnectDelayMs(0, () => 1)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(0, () => 0)).toBe(RECONNECT_BASE_MS / 2)
    expect(reconnectDelayMs(1, () => 1)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelayMs(3, () => 1)).toBe(RECONNECT_BASE_MS * 8)
    expect(reconnectDelayMs(20, () => 1)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelayMs(20, () => 0)).toBe(RECONNECT_MAX_MS / 2)
  })
})

describe('configuredHeartbeatMs', () => {
  it('follows the contract default, and a deployment override only when it is a positive number', () => {
    expect(configuredHeartbeatMs(undefined)).toBe(SSE_HEARTBEAT_MS)
    expect(configuredHeartbeatMs('')).toBe(SSE_HEARTBEAT_MS)
    expect(configuredHeartbeatMs('abc')).toBe(SSE_HEARTBEAT_MS)
    expect(configuredHeartbeatMs('-5')).toBe(SSE_HEARTBEAT_MS)
    expect(configuredHeartbeatMs('60000')).toBe(60_000)
  })
})

describe('openDashboardStream', () => {
  let statuses: StreamStatus[]
  let events: LiveEvent[]
  let resyncs: number
  let online: boolean
  let windowTarget: EventTarget
  let stream: DashboardStream

  function open(overrides: Partial<Parameters<typeof openDashboardStream>[0]> = {}): DashboardStream {
    stream = openDashboardStream({
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
      onResync: () => {
        resyncs += 1
      },
      createEventSource: (url) => new FakeEventSource(url),
      // The session is fine unless a test says otherwise: a failure is then an ordinary blip.
      probeSession: () => Promise.resolve('ok'),
      isOnline: () => online,
      target: windowTarget,
      random: () => 1,
      ...overrides,
    })
    return stream
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.reset()
    statuses = []
    events = []
    resyncs = 0
    online = true
    windowTarget = new EventTarget()
  })

  afterEach(() => {
    stream.close()
    vi.useRealTimers()
  })

  it('connects to the dashboard stream, says "connecting", then "live" once it is open', () => {
    open()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.latest.url).toBe(API.dashboard.stream)
    expect(statuses).toEqual(['connecting'])

    FakeEventSource.latest.open()
    expect(statuses).toEqual(['connecting', 'live'])
    // Nothing was missed on a clean first connection, so there is nothing to re-read.
    expect(resyncs).toBe(0)
  })

  it('hands on payment and link events, and swallows heartbeats and malformed frames', () => {
    open()
    const source = FakeEventSource.latest
    source.open()

    source.send(heartbeat)
    source.sendRaw('payment.completed', '{broken')
    source.send(completed)

    expect(events).toEqual([completed])
  })

  it('listens for every event name the contract defines — an EventSource only routes unnamed frames to onmessage', () => {
    open()
    const source = FakeEventSource.latest
    for (const type of ['heartbeat', 'payment.completed', 'payment.failed', 'link.created', 'link.updated']) {
      expect(source.listenerCount(type), type).toBe(1)
    }
  })

  describe('a network blip', () => {
    it('on error: closes the dead source, says "reconnecting", and opens a fresh one after a backoff', () => {
      open()
      const first = FakeEventSource.latest
      first.open()

      first.error()
      expect(first.closed).toBe(true)
      expect(statuses.at(-1)).toBe('reconnecting')
      expect(FakeEventSource.instances).toHaveLength(1)

      vi.advanceTimersByTime(RECONNECT_BASE_MS)
      expect(FakeEventSource.instances).toHaveLength(2)
      expect(FakeEventSource.latest).not.toBe(first)
    })

    it('resumes: once the new connection opens it is "live" again, events flow, and the caller is told to re-read the server exactly once', () => {
      open()
      FakeEventSource.latest.open()
      FakeEventSource.latest.error()
      vi.advanceTimersByTime(RECONNECT_BASE_MS)

      FakeEventSource.latest.open()
      expect(statuses).toEqual(['connecting', 'live', 'reconnecting', 'live'])
      expect(resyncs).toBe(1)

      FakeEventSource.latest.send(completed)
      expect(events).toEqual([completed])
    })

    it('keeps trying with a growing wait while the API stays down, and says "reconnecting" throughout', () => {
      open()
      FakeEventSource.latest.open()
      FakeEventSource.latest.error()

      // random() = 1: waits of 1s, 2s, 4s.
      vi.advanceTimersByTime(1_000)
      expect(FakeEventSource.instances).toHaveLength(2)
      FakeEventSource.latest.error()

      vi.advanceTimersByTime(1_999)
      expect(FakeEventSource.instances).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(FakeEventSource.instances).toHaveLength(3)
      FakeEventSource.latest.error()

      vi.advanceTimersByTime(3_999)
      expect(FakeEventSource.instances).toHaveLength(3)
      vi.advanceTimersByTime(1)
      expect(FakeEventSource.instances).toHaveLength(4)

      expect(statuses.filter((status) => status === 'live')).toHaveLength(1)
      expect(statuses.at(-1)).toBe('reconnecting')
    })

    it('a success resets the backoff, so the next blip starts from a second again', () => {
      open()
      FakeEventSource.latest.open()
      FakeEventSource.latest.error()
      vi.advanceTimersByTime(1_000)
      FakeEventSource.latest.error()
      vi.advanceTimersByTime(2_000)
      FakeEventSource.latest.open() // third attempt succeeds

      FakeEventSource.latest.error()
      vi.advanceTimersByTime(RECONNECT_BASE_MS)
      expect(FakeEventSource.instances).toHaveLength(4)
    })

    it('a first connection that fails is also "reconnecting", and re-reads the server when it finally opens', () => {
      open()
      FakeEventSource.latest.error()
      expect(statuses).toEqual(['connecting', 'reconnecting'])

      vi.advanceTimersByTime(RECONNECT_BASE_MS)
      FakeEventSource.latest.open()
      expect(statuses.at(-1)).toBe('live')
      expect(resyncs).toBe(1)
    })

    it('ignores anything a superseded source says after it was replaced', () => {
      open()
      const first = FakeEventSource.latest
      first.open()
      first.error()
      vi.advanceTimersByTime(RECONNECT_BASE_MS)

      // A closed source delivers nothing (as in a browser) — and even a stray call must not matter.
      first.send(completed)
      expect(events).toEqual([])
    })
  })

  describe('a session that ended while the stream was open', () => {
    /** A native EventSource cannot say why it failed, so the stream asks the API who it is. */
    function probeReturning(result: SessionProbe) {
      const probe = vi.fn<() => Promise<SessionProbe>>(() => Promise.resolve(result))
      open({ probeSession: probe })
      return probe
    }

    it('401: stops, says "signed-out", and never retries — a reconnect could not succeed', async () => {
      const probe = probeReturning('signed-out')
      FakeEventSource.latest.open()
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(0)

      expect(probe).toHaveBeenCalledTimes(1)
      expect(statuses.at(-1)).toBe('signed-out')
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 3)
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(statuses.filter((status) => status === 'signed-out')).toHaveLength(1)
      // Nothing to re-read: there is no session to read with.
      expect(resyncs).toBe(0)
    })

    it('403 (a customer account): stops, says "stopped", and never retries', async () => {
      probeReturning('forbidden')
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(0)

      expect(statuses.at(-1)).toBe('stopped')
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 3)
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    it('a signed-out stream stays stopped when the browser comes back online', async () => {
      probeReturning('signed-out')
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(0)

      windowTarget.dispatchEvent(new Event('offline'))
      windowTarget.dispatchEvent(new Event('online'))
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(statuses.at(-1)).toBe('signed-out')
    })

    it('anything the probe cannot settle (a 5xx, a dropped connection) is an ordinary blip: keep reconnecting', async () => {
      probeReturning('unknown')
      FakeEventSource.latest.open()
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(0)
      expect(statuses.at(-1)).toBe('reconnecting')

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS)
      expect(FakeEventSource.instances).toHaveLength(2)
    })

    it('a probe that still says the session is fine changes nothing', async () => {
      probeReturning('ok')
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS)
      expect(statuses.at(-1)).toBe('reconnecting')
      expect(FakeEventSource.instances).toHaveLength(2)
    })

    it('does not ask while the browser knows it is offline — that failure is the network, not the session', async () => {
      const probe = probeReturning('signed-out')
      FakeEventSource.latest.open()
      online = false
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(0)
      expect(probe).not.toHaveBeenCalled()
      expect(statuses.at(-1)).toBe('offline')
    })

    it('asks once at a time, not once per queued failure', async () => {
      let resolve: (result: SessionProbe) => void = () => undefined
      const probe = vi.fn(
        () =>
          new Promise<SessionProbe>((done) => {
            resolve = done
          }),
      )
      open({ probeSession: probe })
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS) // retry made; still no answer
      FakeEventSource.latest.error()
      expect(probe).toHaveBeenCalledTimes(1)

      resolve('signed-out')
      await vi.advanceTimersByTimeAsync(0)
      expect(statuses.at(-1)).toBe('signed-out')
    })

    it('an answer that arrives after the connection recovered is stale and ignored', async () => {
      let resolve: (result: SessionProbe) => void = () => undefined
      open({
        probeSession: () =>
          new Promise<SessionProbe>((done) => {
            resolve = done
          }),
      })
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS)
      FakeEventSource.latest.open()
      expect(statuses.at(-1)).toBe('live')

      resolve('signed-out')
      await vi.advanceTimersByTimeAsync(0)
      expect(statuses.at(-1)).toBe('live')
      expect(FakeEventSource.latest.closed).toBe(false)
    })

    it('an answer that arrives after close() does nothing', async () => {
      let resolve: (result: SessionProbe) => void = () => undefined
      open({
        probeSession: () =>
          new Promise<SessionProbe>((done) => {
            resolve = done
          }),
      })
      FakeEventSource.latest.error()
      const before = statuses.length
      stream.close()
      resolve('signed-out')
      await vi.advanceTimersByTimeAsync(0)
      expect(statuses).toHaveLength(before)
    })

    it('a probe that throws is "unknown", not a crash', async () => {
      open({ probeSession: () => Promise.reject(new Error('boom')) })
      FakeEventSource.latest.error()
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS)
      expect(statuses.at(-1)).toBe('reconnecting')
      expect(FakeEventSource.instances).toHaveLength(2)
    })
  })

  describe('a connection that goes quiet without an error', () => {
    it('is treated as dead once heartbeats stop for more than two intervals, and replaced', () => {
      open()
      const first = FakeEventSource.latest
      first.open()

      vi.advanceTimersByTime(SSE_HEARTBEAT_MS * STALE_AFTER_HEARTBEATS - 1)
      expect(statuses.at(-1)).toBe('live')

      vi.advanceTimersByTime(1)
      expect(first.closed).toBe(true)
      expect(statuses.at(-1)).toBe('reconnecting')
    })

    it('stays live for as long as heartbeats keep arriving', () => {
      open()
      FakeEventSource.latest.open()

      for (let beat = 0; beat < 10; beat += 1) {
        vi.advanceTimersByTime(SSE_HEARTBEAT_MS)
        FakeEventSource.latest.send(heartbeat)
      }
      expect(statuses).toEqual(['connecting', 'live'])
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    it('measures silence against the heartbeat interval it was told the server uses', () => {
      open({ heartbeatMs: 60_000 })
      FakeEventSource.latest.open()
      vi.advanceTimersByTime(SSE_HEARTBEAT_MS * STALE_AFTER_HEARTBEATS * 2)
      expect(statuses.at(-1)).toBe('live')
    })
  })

  describe('the browser going offline', () => {
    it('says "offline", closes the source, and does not poll the network while it is down', () => {
      open()
      const source = FakeEventSource.latest
      source.open()

      online = false
      windowTarget.dispatchEvent(new Event('offline'))
      expect(source.closed).toBe(true)
      expect(statuses.at(-1)).toBe('offline')

      vi.advanceTimersByTime(RECONNECT_MAX_MS * 3)
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    it('reconnects immediately when it comes back, and re-reads the server', () => {
      open()
      FakeEventSource.latest.open()
      online = false
      windowTarget.dispatchEvent(new Event('offline'))

      online = true
      windowTarget.dispatchEvent(new Event('online'))
      expect(FakeEventSource.instances).toHaveLength(2)
      expect(statuses.at(-1)).toBe('reconnecting')

      FakeEventSource.latest.open()
      expect(statuses.at(-1)).toBe('live')
      expect(resyncs).toBe(1)
    })

    it('an error while the browser knows it is offline is "offline", not "reconnecting"', () => {
      open()
      FakeEventSource.latest.open()
      online = false
      FakeEventSource.latest.error()
      expect(statuses.at(-1)).toBe('offline')
    })

    it('starts "offline" — without opening a connection — when the page loads with no network', () => {
      online = false
      open()
      expect(statuses).toEqual(['offline'])
      expect(FakeEventSource.instances).toHaveLength(0)

      online = true
      windowTarget.dispatchEvent(new Event('online'))
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    it('an "online" event while the stream is healthy does not tear it down', () => {
      open()
      FakeEventSource.latest.open()
      windowTarget.dispatchEvent(new Event('online'))
      expect(FakeEventSource.instances).toHaveLength(1)
    })
  })

  describe('close()', () => {
    it('closes the source and stops everything: no retry, no watchdog, no status, no events', () => {
      open()
      const source = FakeEventSource.latest
      source.open()
      source.error() // a retry is now pending
      const before = statuses.length

      stream.close()
      vi.advanceTimersByTime(RECONNECT_MAX_MS * 3)

      expect(FakeEventSource.instances).toHaveLength(1)
      expect(statuses).toHaveLength(before)
    })

    it('closes a live source, and stops listening for online / offline', () => {
      const remove = vi.spyOn(windowTarget, 'removeEventListener')
      open()
      const source = FakeEventSource.latest
      source.open()

      stream.close()
      expect(source.closed).toBe(true)
      // Not just ignored: detached, so a page that navigates away leaves nothing on `window`.
      expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['offline', 'online']))
      expect(remove).toHaveBeenCalledTimes(2)

      online = false
      windowTarget.dispatchEvent(new Event('offline'))
      windowTarget.dispatchEvent(new Event('online'))
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(statuses.at(-1)).toBe('live')
    })
  })
})

describe('probeMerchantSession', () => {
  const customer = { ...exampleUser(), role: 'customer' as const }

  function meAnswers(handler: Parameters<typeof http.get>[1]) {
    server.use(http.get(API.auth.me, handler))
  }

  it('a merchant session is fine', async () => {
    meAnswers(() => HttpResponse.json({ user: exampleUser({ role: 'merchant' }) }))
    await expect(probeMerchantSession()).resolves.toBe('ok')
  })

  it('401 unauthenticated is a signed-out visitor', async () => {
    meAnswers(() =>
      HttpResponse.json({ code: 'unauthenticated', message: 'Your session has expired.' }, { status: 401 }),
    )
    await expect(probeMerchantSession()).resolves.toBe('signed-out')
  })

  it('a signed-in customer is forbidden — the stream answers a customer 403', async () => {
    meAnswers(() => HttpResponse.json({ user: customer }))
    await expect(probeMerchantSession()).resolves.toBe('forbidden')
  })

  it('a bare 401 from a proxy (no ApiError body) is not evidence the session ended', async () => {
    meAnswers(() => new HttpResponse('<html>nope</html>', { status: 401 }))
    await expect(probeMerchantSession()).resolves.toBe('unknown')
  })

  it('a 5xx, a dropped connection and a malformed body are all unknown', async () => {
    meAnswers(() => HttpResponse.json({ code: 'internal', message: 'x' }, { status: 500 }))
    await expect(probeMerchantSession()).resolves.toBe('unknown')
    meAnswers(() => HttpResponse.error())
    await expect(probeMerchantSession()).resolves.toBe('unknown')
    meAnswers(() => HttpResponse.json({ nope: true }))
    await expect(probeMerchantSession()).resolves.toBe('unknown')
  })

  it('never reuses a cached answer', async () => {
    let cache: string | null = null
    meAnswers(({ request }) => {
      cache = request.cache
      return HttpResponse.json({ user: exampleUser({ role: 'merchant' }) })
    })
    await probeMerchantSession()
    expect(cache).toBe('no-store')
  })
})
