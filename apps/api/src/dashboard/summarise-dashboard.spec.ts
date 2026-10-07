import { describe, expect, it } from 'vitest'
import type { LinkStats } from '../links/link-stats.js'
import { type DashboardLinkRow, summariseDashboard } from './summarise-dashboard.js'

const NOW = new Date('2026-10-07T12:00:00.000Z')
const PAST = new Date('2026-10-01T00:00:00.000Z')
const FUTURE = new Date('2026-11-01T00:00:00.000Z')

function link(code: string, overrides: Partial<DashboardLinkRow> = {}): DashboardLinkRow {
  return { code, status: 'active', isReusable: false, expiresAt: null, ...overrides }
}

function stats(entries: Record<string, LinkStats>): Map<string, LinkStats> {
  return new Map(Object.entries(entries))
}

describe('summariseDashboard', () => {
  it('is all zeros for a merchant with no links', () => {
    expect(summariseDashboard([], new Map(), NOW)).toEqual({ totalCollectedKobo: 0, paymentCount: 0, activeLinks: 0 })
  })

  it('treats a link with no ledger stats as zero collected but still active', () => {
    expect(summariseDashboard([link('AAAAAAAA')], new Map(), NOW)).toEqual({
      totalCollectedKobo: 0,
      paymentCount: 0,
      activeLinks: 1,
    })
  })

  it('sums integer kobo and counts across links', () => {
    const result = summariseDashboard(
      [link('AAAAAAAA', { isReusable: true }), link('BBBBBBBB', { isReusable: true })],
      stats({
        AAAAAAAA: { paymentCount: 2, totalPaidKobo: 150_050 },
        BBBBBBBB: { paymentCount: 1, totalPaidKobo: 1 },
      }),
      NOW,
    )
    expect(result).toEqual({ totalCollectedKobo: 150_051, paymentCount: 3, activeLinks: 2 })
  })

  it('counts activeLinks by resolveLink, not by status: disabled, expired and already-paid single-use are excluded', () => {
    const result = summariseDashboard(
      [
        link('ACTIVEOK', { expiresAt: FUTURE }),
        link('DISABLED', { status: 'disabled' }),
        link('EXPIRED1', { expiresAt: PAST }),
        link('PAIDONCE'),
        link('REUSABLE', { isReusable: true }),
      ],
      stats({
        PAIDONCE: { paymentCount: 1, totalPaidKobo: 10_000 },
        REUSABLE: { paymentCount: 4, totalPaidKobo: 40_000 },
      }),
      NOW,
    )
    // Only ACTIVEOK and REUSABLE still resolve to payable.
    expect(result.activeLinks).toBe(2)
    expect(result.totalCollectedKobo).toBe(50_000)
    expect(result.paymentCount).toBe(5)
  })

  it('keeps money from a disabled or expired link in the total — collected is collected', () => {
    const result = summariseDashboard(
      [link('DISABLED', { status: 'disabled', isReusable: true })],
      stats({ DISABLED: { paymentCount: 1, totalPaidKobo: 25_000 } }),
      NOW,
    )
    expect(result).toEqual({ totalCollectedKobo: 25_000, paymentCount: 1, activeLinks: 0 })
  })

  it('uses asOf for expiry: a link expiring exactly at asOf is already expired', () => {
    expect(summariseDashboard([link('EDGEEDGE', { expiresAt: NOW })], new Map(), NOW).activeLinks).toBe(0)
    expect(summariseDashboard([link('EDGEEDGE', { expiresAt: NOW })], new Map(), new Date(NOW.getTime() - 1)).activeLinks).toBe(1)
  })
})
