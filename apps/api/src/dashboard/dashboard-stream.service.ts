import { EventEmitter } from 'node:events'
import { Injectable } from '@nestjs/common'
import type { DashboardEvent } from '@kobolink/contracts'

export interface DashboardStreamMessage {
  /** Monotonic within this process — see `sse-frame.ts` and this class's own doc comment. */
  id: number
  event: DashboardEvent
}

/**
 * The in-process fan-out `DashboardStreamController` and
 * `DashboardListenerService` share — PLAN.md's B6 row, "two subscribers
 * both receive an event". One Node `EventEmitter`, one channel per
 * merchant (`merchant:<id>`): every SSE connection for that merchant adds
 * one listener to that channel and removes it on disconnect
 * (`DashboardStreamController`), and the *one* process-wide Postgres
 * `LISTEN` connection (`DashboardListenerService`) is the only thing that
 * ever calls `publish`. Scoping lives here, not in a filter downstream of a
 * single global channel: a caller can only ever receive what was published
 * to its own merchant's channel, so "never another merchant's events" is
 * true by construction, not by a check that could be forgotten on some
 * other code path.
 *
 * `id` is a single counter shared by every merchant and every event type
 * (heartbeats included, via `nextId()` — see `DashboardStreamController`),
 * not one counter per channel: two browser tabs for the *same* merchant
 * that both receive the same published event see the same `id` for it
 * (assigned once, here, before `emit` fans it out), which is the property
 * a future replay-by-id would need. It resets on every process restart —
 * this PR does not persist it or use it for replay (see
 * `DashboardStreamController`'s doc comment for what "reconnect" does and
 * does not do yet).
 */
@Injectable()
export class DashboardStreamService {
  private readonly emitter = new EventEmitter()
  private nextEventId = 1

  constructor() {
    // Many merchants, many tabs each, all sharing one emitter — the default
    // limit of 10 listeners (a per-event-name warning, not an error, but
    // still noise on a real deployment) does not describe a resource leak
    // here the way it would for a single fixed event name; each merchant's
    // channel is its own name and cleanup is `DashboardStreamController`'s
    // job (proven by `dashboard-stream-lifecycle.integration.test.ts`), not
    // this emitter's.
    this.emitter.setMaxListeners(0)
  }

  /** The next id in the shared sequence, for a message this service itself does not `publish` (the controller's own heartbeats). */
  nextId(): number {
    return this.nextEventId++
  }

  /** Fans `event` out to every currently-subscribed connection for `merchantId`, and only those. */
  publish(merchantId: string, event: DashboardEvent): void {
    const message: DashboardStreamMessage = { id: this.nextId(), event }
    this.emitter.emit(this.channel(merchantId), message)
  }

  /**
   * Subscribes one connection to `merchantId`'s channel. Returns an
   * unsubscribe function — call it exactly once, when that connection
   * closes, so a dropped/reconnected client never accumulates a second,
   * leaked listener behind the one the new connection just added.
   */
  subscribe(merchantId: string, onMessage: (message: DashboardStreamMessage) => void): () => void {
    const channel = this.channel(merchantId)
    this.emitter.on(channel, onMessage)
    let unsubscribed = false
    return () => {
      // Idempotent — a connection's cleanup can run from more than one
      // event (`close`, an error) and must not double-remove (harmless with
      // Node's EventEmitter, since `off` of an already-removed listener is
      // a no-op, but the guard also stops a mis-implemented cleanup path
      // from ever removing a *different* listener for the same channel).
      if (unsubscribed) return
      unsubscribed = true
      this.emitter.off(channel, onMessage)
    }
  }

  /** Test-only introspection: how many live SSE connections `merchantId` currently has. Proves the lifecycle tests' "no leak" assertions directly instead of inferring it indirectly. */
  listenerCount(merchantId: string): number {
    return this.emitter.listenerCount(this.channel(merchantId))
  }

  private channel(merchantId: string): string {
    return `merchant:${merchantId}`
  }
}
