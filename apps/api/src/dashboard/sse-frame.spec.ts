import type { DashboardEvent } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import { formatSseFrame } from './sse-frame.js'

describe('formatSseFrame', () => {
  it('writes id, event and data lines terminated by a blank line', () => {
    const event: DashboardEvent = { type: 'heartbeat', at: '2026-01-01T00:00:00.000Z' }
    expect(formatSseFrame(7, event)).toBe(
      'id: 7\nevent: heartbeat\ndata: {"type":"heartbeat","at":"2026-01-01T00:00:00.000Z"}\n\n',
    )
  })

  it('uses the event\'s own discriminant as the SSE event name', () => {
    const event: DashboardEvent = {
      type: 'payment.failed',
      payment: {
        reference: 'kbl_ref',
        code: 'ABCD1234',
        amountKobo: 50_000,
        currency: 'NGN',
        status: 'failed',
        payerName: 'A Payer',
        payerEmail: 'a***@example.com',
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
        failureReason: 'Card declined by the simulated gateway.',
        moneyMoved: false,
      },
    }
    const frame = formatSseFrame(1, event)
    expect(frame.split('\n')[1]).toBe('event: payment.failed')
  })

  it('serialises the full event as one JSON data line, round-trippable', () => {
    const event: DashboardEvent = { type: 'heartbeat', at: '2026-01-01T00:00:00.000Z' }
    const frame = formatSseFrame(3, event)
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    expect(dataLine).toBeDefined()
    expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual(event)
  })
})
