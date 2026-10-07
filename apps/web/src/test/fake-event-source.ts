import type { DashboardEvent } from '@kobolink/contracts'
import type { EventSourceLike } from '@/lib/dashboard-stream'

/**
 * A stand-in for the browser's `EventSource` (jsdom has none) that a test
 * drives by hand: `open()`, `error()`, `send(event)`. It records every
 * instance, so a test can assert that a reconnect made a *new* one and that
 * an old one was closed. Only the slice `lib/dashboard-stream.ts` uses.
 */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []

  static reset(): void {
    FakeEventSource.instances = []
  }

  /** The most recently created source — the one the app is currently listening to. */
  static get latest(): FakeEventSource {
    const latest = FakeEventSource.instances.at(-1)
    if (latest === undefined) throw new Error('no EventSource has been created')
    return latest
  }

  readonly url: string
  closed = false
  private readonly listeners = new Map<string, ((event: Event) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
  }

  /** The connection is established. */
  open(): void {
    this.dispatch('open', new Event('open'))
  }

  /** The connection failed or dropped. */
  error(): void {
    this.dispatch('error', new Event('error'))
  }

  /** One named frame, the way the API writes them (`event: <type>`, `data: <json>`). */
  send(event: DashboardEvent): void {
    this.sendRaw(event.type, JSON.stringify(event))
  }

  sendRaw(type: string, data: string): void {
    this.dispatch(type, new MessageEvent(type, { data }))
  }

  /** How many listeners are attached for `type` — to prove nothing leaks. */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0
  }

  private dispatch(type: string, event: Event): void {
    // A closed EventSource delivers nothing, as in a browser.
    if (this.closed) return
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}
