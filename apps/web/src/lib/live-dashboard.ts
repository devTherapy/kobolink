import type { DashboardStats, Payment, PaymentLink } from '@kobolink/contracts'
import type { LiveEvent } from './dashboard-stream'

/**
 * How live events combine with what the server rendered (PLAN.md F7).
 *
 * The rule the whole feature rests on: **the server render is the truth, an
 * event is a bridge to it.** An event is applied the instant it arrives so the
 * merchant sees the change now, and every event also schedules a
 * `router.refresh()` (see `DashboardStreamProvider`) that brings the
 * authoritative figures back as props. Nothing here does arithmetic on money
 * or counters — the event either carries the absolute value (`stats`, a whole
 * `link`, a whole `payment`) or it is left for the refresh. That is what keeps
 * a lost event, a duplicate event and an out-of-order event from ever leaving
 * the screen wrong for longer than one refresh.
 *
 * These are pure functions of (baseline, events) rather than state, so there is
 * nothing to reset when a refresh delivers a newer baseline: an event the new
 * baseline already reflects is recognised and ignored.
 */

/** Milliseconds for ordering two ISO timestamps; an unparseable one sorts first (never wins). */
function at(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/**
 * Identity for de-duplication: the payment reference, scoped by outcome (the
 * same reference legitimately appears once as completed and never also as
 * failed, but the key does not rely on that). Link events have no natural
 * identity — and do not need one, because applying one twice is a no-op.
 */
export function eventKey(event: LiveEvent): string | null {
  switch (event.type) {
    case 'payment.completed':
    case 'payment.failed':
      return `${event.type}:${event.payment.reference}`
    case 'link.created':
    case 'link.updated':
      return null
  }
}

export interface DashboardSnapshot {
  stats: DashboardStats
  links: PaymentLink[]
}

export interface LiveDashboardView extends DashboardSnapshot {
  /** The newest completed payment the baseline does not yet include, for the screen-reader announcement. */
  latestPayment: Payment | null
}

/**
 * The dashboard as the server last rendered it, plus whatever has arrived
 * since. `baseline.stats.asOf` is the cut-off: an event whose `stats` were
 * taken at or before it is already part of the baseline.
 *
 * Per-link counters (`paymentCount`, `totalPaidKobo`) are deliberately *not*
 * bumped from a `payment.completed` event — that would be arithmetic, and the
 * refresh the same event schedules corrects them within a moment. `link.created`
 * and `link.updated` carry the whole link, so those are applied as-is.
 */
export function mergeDashboard(baseline: DashboardSnapshot, events: readonly LiveEvent[]): LiveDashboardView {
  const cutoff = at(baseline.stats.asOf)
  let stats = baseline.stats
  let latestPayment: Payment | null = null
  const patches = new Map<string, { link: PaymentLink; created: boolean }>()

  for (const event of events) {
    if (event.type === 'payment.failed') continue
    if (at(event.stats.asOf) <= cutoff) continue
    if (at(event.stats.asOf) > at(stats.asOf)) stats = event.stats

    if (event.type === 'payment.completed') {
      latestPayment = event.payment
    } else {
      const previous = patches.get(event.link.code)
      patches.set(event.link.code, {
        link: event.link,
        created: event.type === 'link.created' || previous?.created === true,
      })
    }
  }

  if (patches.size === 0) return { stats, links: baseline.links, latestPayment }

  const known = new Set(baseline.links.map((link) => link.code))
  // `link.updated` for a link that is not on this page is not a new row: it is an old link
  // changing. Only a `link.created` inserts, newest first like the list.
  const inserted = [...patches.values()]
    .filter((patch) => patch.created && !known.has(patch.link.code))
    .map((patch) => patch.link)
    .reverse()
  const links = [...inserted, ...baseline.links.map((link) => patches.get(link.code)?.link ?? link)]
  return { stats, links, latestPayment }
}

/**
 * The newest `link.created` / `link.updated` for `code` that is later than the
 * server render at `asOf`, or `null` when the render is current. A whole
 * `PaymentLink`, so it can replace the rendered one outright.
 *
 * `asOf` is read *after* the page's reads finished (`loadLinkDetail`), so an
 * event that raced the render is dropped here and picked up by its own
 * refresh instead of being applied on top of data that already includes it.
 */
export function liveLinkOverride(code: string, asOf: string | undefined, events: readonly LiveEvent[]): PaymentLink | null {
  const cutoff = asOf === undefined ? Number.NEGATIVE_INFINITY : at(asOf)
  let latest: { link: PaymentLink; at: number } | null = null
  for (const event of events) {
    if (event.type !== 'link.created' && event.type !== 'link.updated') continue
    if (event.link.code !== code) continue
    const when = at(event.stats.asOf)
    if (when <= cutoff) continue
    if (latest === null || when >= latest.at) latest = { link: event.link, at: when }
  }
  return latest?.link ?? null
}

/** Payments that arrived for `code`, newest first. Both outcomes: a decline is a row the merchant wants to see. */
export function livePaymentsFor(code: string, events: readonly LiveEvent[]): Payment[] {
  const payments: Payment[] = []
  for (const event of events) {
    if ((event.type === 'payment.completed' || event.type === 'payment.failed') && event.payment.code === code) {
      payments.push(event.payment)
    }
  }
  return payments.reverse()
}

/**
 * The rendered first page with live payments laid over it. A reference in both
 * takes the live version (events only ever carry a terminal state; the page may
 * have caught the payment while still `pending`) in the page's own position; a
 * reference only in `live` goes on top. Never lists a reference twice.
 */
export function mergePayments(rendered: readonly Payment[], live: readonly Payment[]): Payment[] {
  if (live.length === 0) return [...rendered]
  const liveByReference = new Map(live.map((payment) => [payment.reference, payment]))
  const renderedReferences = new Set(rendered.map((payment) => payment.reference))
  const fresh = [...liveByReference.values()].filter((payment) => !renderedReferences.has(payment.reference))
  return [...fresh, ...rendered.map((payment) => liveByReference.get(payment.reference) ?? payment)]
}

/** Appends `incoming` to `existing`, dropping any `reference` already present. */
export function appendUnique(existing: readonly Payment[], incoming: readonly Payment[]): Payment[] {
  const seen = new Set(existing.map((payment) => payment.reference))
  return [...existing, ...incoming.filter((payment) => !seen.has(payment.reference))]
}
