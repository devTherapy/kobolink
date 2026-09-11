import { PaymentSchema } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import type * as schema from '../db/schema/index.js'
import { rowToPayment } from './payment-mapper.js'

type PostingRow = typeof schema.postings.$inferSelect

function makeRow(overrides: Partial<PostingRow> = {}, metadataOverrides: Record<string, unknown> = {}): PostingRow {
  return {
    id: 'pst_abc123',
    kind: 'link_payment',
    reference: 'kbl_2A3b4C5d6E',
    idempotencyScope: '/api/checkout/verify',
    idempotencyKey: 'kbl_2A3b4C5d6E',
    metadata: {
      linkCode: 'KBLDEMX2',
      amountKobo: 500_000,
      payerName: 'Ada Lovelace',
      payerEmail: 'a***@example.com',
      status: 'success',
      failureReason: null,
      ...metadataOverrides,
    },
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    ...overrides,
  }
}

describe('rowToPayment', () => {
  it('maps a successful posting to a Payment that satisfies the contract schema exactly', () => {
    const payment = rowToPayment(makeRow())

    expect(() => PaymentSchema.parse(payment)).not.toThrow()
    expect(payment).toEqual({
      reference: 'kbl_2A3b4C5d6E',
      code: 'KBLDEMX2',
      amountKobo: 500_000,
      currency: 'NGN',
      status: 'success',
      payerName: 'Ada Lovelace',
      payerEmail: 'a***@example.com',
      createdAt: '2026-09-01T12:00:00.000Z',
      completedAt: '2026-09-01T12:00:00.000Z',
      failureReason: null,
      moneyMoved: true,
    })
  })

  it('maps a failed (declined or non-payable) posting with moneyMoved: false and a failureReason', () => {
    const payment = rowToPayment(
      makeRow({}, { status: 'failed', failureReason: 'Card declined by the simulated gateway.' }),
    )

    expect(() => PaymentSchema.parse(payment)).not.toThrow()
    expect(payment.status).toBe('failed')
    expect(payment.moneyMoved).toBe(false)
    expect(payment.failureReason).toBe('Card declined by the simulated gateway.')
  })

  it('createdAt and completedAt are both the posting\'s own createdAt — a Payment is only ever born decided', () => {
    const payment = rowToPayment(makeRow({ createdAt: new Date('2026-06-14T18:20:04.000Z') }))
    expect(payment.createdAt).toBe('2026-06-14T18:20:04.000Z')
    expect(payment.completedAt).toBe('2026-06-14T18:20:04.000Z')
  })

  it('throws — rather than silently returning a contract-violating body — if metadata fails its own schema', () => {
    expect(() => rowToPayment(makeRow({ metadata: { not: 'the right shape' } }))).toThrow()
  })

  it('throws if metadata is missing entirely (null)', () => {
    expect(() => rowToPayment(makeRow({ metadata: null }))).toThrow()
  })
})
