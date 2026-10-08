import { describe, expect, it } from 'vitest'
import { exampleLink, examplePayment, exampleStats, type PaymentLink } from '@kobolink/contracts'
import type { LiveEvent } from './dashboard-stream'
import {
  appendUnique,
  eventKey,
  liveLinkOverride,
  livePaymentsFor,
  mergeDashboard,
  mergePayments,
} from './live-dashboard'

const T0 = '2026-06-15T12:00:00.000Z'
const T1 = '2026-06-15T12:00:05.000Z'
const T2 = '2026-06-15T12:00:09.000Z'

const baselineStats = exampleStats({ asOf: T0 })
const linkA = exampleLink({ code: 'aaaaaaaa', title: 'Link A' })
const linkB = exampleLink({ code: 'bbbbbbbb', title: 'Link B' })

function completed(reference: string, stats = exampleStats({ asOf: T1, paymentCount: 4 }), code = linkA.code): LiveEvent {
  return { type: 'payment.completed', payment: examplePayment({ reference, code }), stats }
}

describe('eventKey', () => {
  it('keys a payment event by outcome and reference, and leaves link events — which are idempotent — unkeyed', () => {
    expect(eventKey(completed('kbl_aaaaaaaaaa'))).toBe('payment.completed:kbl_aaaaaaaaaa')
    expect(
      eventKey({ type: 'payment.failed', payment: examplePayment({ reference: 'kbl_bbbbbbbbbb', status: 'failed', completedAt: null }) }),
    ).toBe('payment.failed:kbl_bbbbbbbbbb')
    expect(eventKey({ type: 'link.updated', link: linkA, stats: baselineStats })).toBeNull()
  })
})

describe('mergeDashboard', () => {
  const baseline = { stats: baselineStats, links: [linkA, linkB] }

  it('is the baseline untouched when nothing has arrived', () => {
    const view = mergeDashboard(baseline, [])
    expect(view.stats).toBe(baselineStats)
    expect(view.links).toBe(baseline.links)
    expect(view.latestPayment).toBeNull()
  })

  it('takes the stats a payment event carries — the server computed them, the client adds nothing up', () => {
    const stats = exampleStats({ asOf: T1, totalCollectedKobo: 7_400_000, paymentCount: 4 })
    const view = mergeDashboard(baseline, [completed('kbl_aaaaaaaaaa', stats)])
    expect(view.stats).toEqual(stats)
    expect(view.latestPayment?.reference).toBe('kbl_aaaaaaaaaa')
  })

  it('does not bump a link row\'s counters from a payment event: that is the refresh\'s job', () => {
    const view = mergeDashboard(baseline, [completed('kbl_aaaaaaaaaa')])
    expect(view.links).toBe(baseline.links)
  })

  it('keeps the newest stats when events arrive out of order', () => {
    const newer = exampleStats({ asOf: T2, paymentCount: 6 })
    const older = exampleStats({ asOf: T1, paymentCount: 5 })
    const view = mergeDashboard(baseline, [completed('kbl_aaaaaaaaaa', newer), completed('kbl_bbbbbbbbbb', older)])
    expect(view.stats).toEqual(newer)
  })

  it('ignores an event the baseline already includes — a refresh landed after it', () => {
    const fresh = { ...baseline, stats: exampleStats({ asOf: T2, paymentCount: 5 }) }
    const view = mergeDashboard(fresh, [completed('kbl_aaaaaaaaaa', exampleStats({ asOf: T1, paymentCount: 4 }))])
    expect(view.stats).toBe(fresh.stats)
    expect(view.latestPayment).toBeNull()
  })

  it('ignores a failed payment: no money moved, so no figure changes', () => {
    const failed: LiveEvent = {
      type: 'payment.failed',
      payment: examplePayment({ reference: 'kbl_cccccccccc', status: 'failed', completedAt: null }),
    }
    const view = mergeDashboard(baseline, [failed])
    expect(view.stats).toBe(baselineStats)
    expect(view.latestPayment).toBeNull()
  })

  it('puts a created link at the top of the list, newest first, and takes its stats', () => {
    const created = exampleLink({ code: 'cccccccc', title: 'Link C' })
    const created2 = exampleLink({ code: 'dddddddd', title: 'Link D' })
    const stats = exampleStats({ asOf: T2, activeLinks: 4 })
    const view = mergeDashboard(baseline, [
      { type: 'link.created', link: created, stats: exampleStats({ asOf: T1, activeLinks: 3 }) },
      { type: 'link.created', link: created2, stats },
    ])
    expect(view.links.map((link) => link.code)).toEqual(['dddddddd', 'cccccccc', 'aaaaaaaa', 'bbbbbbbb'])
    expect(view.stats).toEqual(stats)
  })

  it('never lists a link twice: a created link the baseline already has is not inserted again', () => {
    const view = mergeDashboard(baseline, [{ type: 'link.created', link: linkB, stats: exampleStats({ asOf: T1 }) }])
    expect(view.links.map((link) => link.code)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })

  it('replaces an updated link in place', () => {
    const turnedOff: PaymentLink = { ...linkB, status: 'disabled' }
    const view = mergeDashboard(baseline, [{ type: 'link.updated', link: turnedOff, stats: exampleStats({ asOf: T1 }) }])
    expect(view.links).toEqual([linkA, turnedOff])
  })

  it('does not turn an update to a link that is not on this page into a new row', () => {
    const elsewhere = exampleLink({ code: 'zzzzzzzz' })
    const view = mergeDashboard(baseline, [{ type: 'link.updated', link: elsewhere, stats: exampleStats({ asOf: T1 }) }])
    expect(view.links.map((link) => link.code)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })

  it('a link created then updated is one row, with the update applied', () => {
    const created = exampleLink({ code: 'cccccccc', title: 'Link C' })
    const view = mergeDashboard(baseline, [
      { type: 'link.created', link: created, stats: exampleStats({ asOf: T1 }) },
      { type: 'link.updated', link: { ...created, status: 'disabled' }, stats: exampleStats({ asOf: T2 }) },
    ])
    expect(view.links.map((link) => `${link.code}:${link.status}`)).toEqual(['cccccccc:disabled', 'aaaaaaaa:active', 'bbbbbbbb:active'])
  })
})

describe('liveLinkOverride', () => {
  it('is null when no event concerns this link', () => {
    expect(liveLinkOverride('aaaaaaaa', T0, [])).toBeNull()
    expect(liveLinkOverride('aaaaaaaa', T0, [{ type: 'link.updated', link: linkB, stats: exampleStats({ asOf: T1 }) }])).toBeNull()
    expect(liveLinkOverride('aaaaaaaa', T0, [completed('kbl_aaaaaaaaaa')])).toBeNull()
  })

  it('is the newest link event for the code that is later than the render', () => {
    const first: PaymentLink = { ...linkA, status: 'disabled' }
    const second: PaymentLink = { ...linkA, status: 'active' }
    const override = liveLinkOverride('aaaaaaaa', T0, [
      { type: 'link.updated', link: first, stats: exampleStats({ asOf: T1 }) },
      { type: 'link.updated', link: second, stats: exampleStats({ asOf: T2 }) },
    ])
    expect(override).toBe(second)
  })

  it('ignores an event the render already includes', () => {
    const stale: PaymentLink = { ...linkA, status: 'disabled' }
    expect(liveLinkOverride('aaaaaaaa', T2, [{ type: 'link.updated', link: stale, stats: exampleStats({ asOf: T1 }) }])).toBeNull()
  })
})

describe('livePaymentsFor', () => {
  it('collects both outcomes for the code, newest first, and no other link\'s', () => {
    const failed: LiveEvent = {
      type: 'payment.failed',
      payment: examplePayment({ reference: 'kbl_bbbbbbbbbb', code: linkA.code, status: 'failed', completedAt: null }),
    }
    const payments = livePaymentsFor(linkA.code, [
      completed('kbl_aaaaaaaaaa'),
      failed,
      completed('kbl_cccccccccc', undefined, linkB.code),
    ])
    expect(payments.map((payment) => payment.reference)).toEqual(['kbl_bbbbbbbbbb', 'kbl_aaaaaaaaaa'])
  })
})

describe('mergePayments / appendUnique', () => {
  const rendered = [examplePayment({ reference: 'kbl_1111111111', status: 'pending', completedAt: null }), examplePayment({ reference: 'kbl_2222222222' })]

  it('puts a new payment on top and leaves the rendered ones where they were', () => {
    const live = [examplePayment({ reference: 'kbl_3333333333' })]
    expect(mergePayments(rendered, live).map((payment) => payment.reference)).toEqual(['kbl_3333333333', 'kbl_1111111111', 'kbl_2222222222'])
  })

  it('never lists a reference twice, and lets the live (terminal) version replace a rendered pending one in place', () => {
    const settled = examplePayment({ reference: 'kbl_1111111111', status: 'success' })
    const merged = mergePayments(rendered, [settled, settled])
    expect(merged.map((payment) => payment.reference)).toEqual(['kbl_1111111111', 'kbl_2222222222'])
    expect(merged[0]?.status).toBe('success')
  })

  it('is just the rendered page when nothing is live', () => {
    expect(mergePayments(rendered, [])).toEqual(rendered)
  })

  it('appendUnique drops a reference that is already shown', () => {
    const merged = appendUnique(rendered, [rendered[1]!, examplePayment({ reference: 'kbl_4444444444' })])
    expect(merged.map((payment) => payment.reference)).toEqual(['kbl_1111111111', 'kbl_2222222222', 'kbl_4444444444'])
  })
})
