import { describe, expect, it } from 'vitest'
import { formatDateTime, formatShortDate } from './format'

describe('formatShortDate', () => {
  it('renders a human-readable calendar date, not a raw ISO string', () => {
    const formatted = formatShortDate('2026-06-02T09:00:00.000Z')
    expect(formatted).not.toMatch(/\dT\d/)
    expect(formatted).toMatch(/2026/)
    expect(formatted).toMatch(/Jun/)
  })

  it('carries no time-of-day component — a table column needs a date, not a clock', () => {
    const formatted = formatShortDate('2026-06-02T23:45:00.000Z')
    expect(formatted).not.toMatch(/:\d\d/)
  })

  it('is pinned to Africa/Lagos, so a date near the day boundary reads the same in SSR and CI regardless of the runtime zone', () => {
    // 23:45 UTC on the 2nd is already the 3rd in Lagos (WAT, UTC+1) —
    // rendered in a different zone this would read as a different day.
    const formatted = formatShortDate('2026-06-02T23:45:00.000Z')
    expect(formatted).toMatch(/3 Jun 2026|Jun 3, 2026/)
  })
})

describe('formatDateTime', () => {
  it('adds the Lagos time of day to the date, 24-hour', () => {
    // 18:20 UTC is 19:20 in Lagos (WAT, UTC+1) — the zone is pinned, not the runtime's.
    const formatted = formatDateTime('2026-06-14T18:20:00.000Z')
    expect(formatted).toMatch(/14 Jun 2026|Jun 14, 2026/)
    expect(formatted).toMatch(/19:20/)
  })
})
