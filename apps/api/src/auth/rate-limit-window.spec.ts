import { describe, expect, it } from 'vitest'
import { checkWindow, pruneWindow } from './rate-limit-window.js'

const WINDOW_MS = 15 * 60 * 1000

describe('pruneWindow', () => {
  it('keeps a timestamp exactly at the window boundary as expired (strict less-than)', () => {
    expect(pruneWindow([1_000], 1_000 + WINDOW_MS, WINDOW_MS)).toEqual([])
  })

  it('keeps timestamps within the window', () => {
    const now = 1_000_000
    expect(pruneWindow([now - 1, now - WINDOW_MS + 1], now, WINDOW_MS)).toEqual([now - 1, now - WINDOW_MS + 1])
  })

  it('drops timestamps older than the window', () => {
    const now = 1_000_000
    expect(pruneWindow([now - WINDOW_MS - 1], now, WINDOW_MS)).toEqual([])
  })

  it('returns an empty array for an empty input', () => {
    expect(pruneWindow([], 0, WINDOW_MS)).toEqual([])
  })
})

describe('checkWindow', () => {
  it('allows when there are no prior failures', () => {
    const result = checkWindow([], 0, WINDOW_MS, 5)
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0, count: 0 })
  })

  it('allows up to (limit - 1) failures — the limit itself is the count that trips it', () => {
    const now = 0
    const timestamps = [0, 1, 2, 3]
    expect(checkWindow(timestamps, now, WINDOW_MS, 5).allowed).toBe(true)
  })

  it('blocks once the count reaches the limit', () => {
    const now = 0
    const timestamps = [0, 1, 2, 3, 4]
    const result = checkWindow(timestamps, now, WINDOW_MS, 5)
    expect(result.allowed).toBe(false)
    expect(result.count).toBe(5)
  })

  it('computes retryAfterSeconds from the oldest surviving timestamp', () => {
    const now = 10_000
    const oldest = now - WINDOW_MS + 5_000 // ages out in 5s
    const timestamps = [oldest, now - 100, now - 50, now - 20, now - 10]
    const result = checkWindow(timestamps, now, WINDOW_MS, 5)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBe(5)
  })

  it('ignores timestamps that have already aged out of the window', () => {
    const now = 1_000_000
    const stale = Array.from({ length: 10 }, () => now - WINDOW_MS - 1)
    expect(checkWindow(stale, now, WINDOW_MS, 5).allowed).toBe(true)
  })

  it('retryAfterSeconds is 0 while allowed', () => {
    expect(checkWindow([0, 1], 2, WINDOW_MS, 5).retryAfterSeconds).toBe(0)
  })
})
