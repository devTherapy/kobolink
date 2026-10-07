import {
  API,
  DASHBOARD_EVENT_TYPES,
  DashboardEventSchema,
  SSE_HEARTBEAT_MS,
  type DashboardEvent,
} from '@kobolink/contracts'

/**
 * The browser end of `GET /api/stream/dashboard` (PLAN.md F7). This file is
 * plain TypeScript with no React in it: it owns the connection and nothing
 * else, so the "survives a network blip" half of F7's Done-when can be tested
 * with a fake `EventSource` and fake timers, and `DashboardStreamProvider`
 * only has to translate its callbacks into state.
 *
 * ## Why not just let `EventSource` reconnect itself
 *
 * A native `EventSource` retries after a *network* error on a fixed ~3s
 * timer — no backoff, so a deploy that takes the API down for a minute gets
 * hammered by every open tab — and does not retry at all when the response
 * was refused (a 502 from the proxy, an expired session), leaving the page
 * silently dead. It also cannot tell the page that anything is wrong. So on
 * every `error` this closes the source and runs its own schedule: jittered
 * exponential backoff, reported honestly as `reconnecting`.
 *
 * ## Half-open connections
 *
 * A laptop that changes Wi-Fi networks often never sees an `error`: the TCP
 * connection just goes quiet. The server sends a `heartbeat` event every
 * `SSE_HEARTBEAT_MS` for exactly this, so silence for more than
 * `STALE_AFTER_HEARTBEATS` of them is treated as a dead connection.
 *
 * ## What a gap costs
 *
 * The API does not replay missed events for `Last-Event-ID` (see the
 * `streamDashboard` operation in the OpenAPI document), so anything that
 * happened while disconnected is gone for good. Every successful open after a
 * gap therefore calls `onResync`, and the caller re-reads the server's state.
 */

/** `error` → first retry in 0.5–1s, doubling each attempt up to the cap. */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
/** Silent for this many heartbeat intervals → assume the connection is dead. */
export const STALE_AFTER_HEARTBEATS = 2.5

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

/** The slice of the browser's `EventSource` this file uses — and what tests fake. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

/** An event the page cares about: everything except the keepalive. */
export type LiveEvent = Exclude<DashboardEvent, { type: 'heartbeat' }>

export interface DashboardStreamOptions {
  onStatus: (status: StreamStatus) => void
  onEvent: (event: LiveEvent) => void
  /** The stream is open again after a gap: events in between are lost, re-read the server. */
  onResync: () => void
  url?: string
  /** The server's heartbeat interval; the staleness timeout is a multiple of it. */
  heartbeatMs?: number
  createEventSource?: (url: string) => EventSourceLike
  isOnline?: () => boolean
  /** Where `online` / `offline` are heard. Defaults to `window`. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  random?: () => number
}

export interface DashboardStream {
  close: () => void
}

/** Half fixed, half random: a restarted API is not hit by every tab in the same instant. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

/**
 * One frame's `data:` line → a `DashboardEvent`, or `null` for anything that is
 * not one. Every frame, heartbeats included, is validated against the single
 * contract schema (the `DashboardEvent` doc comment says to). A malformed
 * frame is dropped rather than thrown: one bad message must not take the
 * live view down.
 */
export function parseDashboardEvent(data: unknown): DashboardEvent | null {
  if (typeof data !== 'string') return null
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = DashboardEventSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * The server's heartbeat interval, as far as this build knows it. The API's
 * `DASHBOARD_HEARTBEAT_MS` can be changed per deployment, and the staleness
 * timeout must stay above it or a healthy but quiet stream is torn down
 * every few seconds — hence the matching public variable.
 */
export function configuredHeartbeatMs(raw: string | undefined = process.env.NEXT_PUBLIC_DASHBOARD_HEARTBEAT_MS): number {
  const parsed = Number(raw)
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : SSE_HEARTBEAT_MS
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export function openDashboardStream(options: DashboardStreamOptions): DashboardStream {
  const {
    onStatus,
    onEvent,
    onResync,
    url = API.dashboard.stream,
    heartbeatMs = configuredHeartbeatMs(),
    createEventSource = (target: string): EventSourceLike => new EventSource(target),
    isOnline = browserOnline,
    random = Math.random,
  } = options
  const target = options.target ?? window
  const staleAfterMs = heartbeatMs * STALE_AFTER_HEARTBEATS

  let source: EventSourceLike | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  /** Set by the first failure and cleared by the resync it triggers. */
  let missedSomething = false
  let status: StreamStatus | null = null
  let closed = false

  function setStatus(next: StreamStatus): void {
    if (next === status) return
    status = next
    onStatus(next)
  }

  function clearTimers(): void {
    clearTimeout(retryTimer)
    clearTimeout(watchdogTimer)
    retryTimer = undefined
    watchdogTimer = undefined
  }

  function dropSource(): void {
    source?.close()
    source = null
  }

  function armWatchdog(): void {
    clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(fail, staleAfterMs)
  }

  /** The connection errored, went silent, or was refused. */
  function fail(): void {
    if (closed) return
    clearTimers()
    dropSource()
    missedSomething = true
    if (!isOnline()) {
      setStatus('offline')
      return
    }
    setStatus('reconnecting')
    retryTimer = setTimeout(connect, reconnectDelayMs(attempt, random))
    attempt += 1
  }

  function connect(): void {
    if (closed) return
    clearTimers()
    dropSource()
    if (!isOnline()) {
      missedSomething = true
      setStatus('offline')
      return
    }
    setStatus(missedSomething ? 'reconnecting' : 'connecting')

    const es = createEventSource(url)
    source = es

    es.addEventListener('open', () => {
      if (source !== es) return
      attempt = 0
      setStatus('live')
      armWatchdog()
      if (missedSomething) {
        missedSomething = false
        onResync()
      }
    })
    es.addEventListener('error', () => {
      if (source === es) fail()
    })
    // The server names every frame (`event: payment.completed`), and an
    // `EventSource` only routes unnamed frames to `onmessage` — each name
    // has to be listened for.
    for (const type of DASHBOARD_EVENT_TYPES) {
      es.addEventListener(type, (message) => {
        if (source !== es) return
        armWatchdog()
        const event = parseDashboardEvent((message as MessageEvent<unknown>).data)
        if (event !== null && event.type !== 'heartbeat') onEvent(event)
      })
    }
  }

  const handleOffline = (): void => {
    if (closed) return
    clearTimers()
    dropSource()
    missedSomething = true
    setStatus('offline')
  }
  const handleOnline = (): void => {
    // A stream that is still `live` is left alone; anything else tries now.
    if (closed || status === 'live') return
    attempt = 0
    connect()
  }
  target.addEventListener('offline', handleOffline)
  target.addEventListener('online', handleOnline)

  connect()

  return {
    close() {
      closed = true
      clearTimers()
      dropSource()
      target.removeEventListener('offline', handleOffline)
      target.removeEventListener('online', handleOnline)
    },
  }
}
