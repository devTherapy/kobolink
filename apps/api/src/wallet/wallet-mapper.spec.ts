import { WalletTransactionSchema } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import type * as schema from '../db/schema/index.js'
import { rowToWalletTransaction } from './wallet-mapper.js'

type PostingRow = typeof schema.postings.$inferSelect

function makeTransferRow(overrides: Partial<PostingRow> = {}, metadataOverrides: Record<string, unknown> = {}): PostingRow {
  return {
    id: 'pst_xyz789',
    kind: 'transfer',
    reference: 'wal_2A3b4C5d6E',
    idempotencyScope: 'usr_sender',
    idempotencyKey: 'client-key-1',
    metadata: {
      senderUserId: 'usr_sender',
      senderDisplayName: 'Ada Lovelace',
      recipientUserId: 'usr_recipient',
      recipientDisplayName: 'Grace Hopper',
      note: 'lunch money',
      ...metadataOverrides,
    },
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    ...overrides,
  }
}

function makeTopupRow(overrides: Partial<PostingRow> = {}, metadataOverrides: Record<string, unknown> = {}): PostingRow {
  return makeTransferRow(
    { kind: 'topup', reference: 'wal_topup12345', ...overrides },
    { senderUserId: null, senderDisplayName: null, recipientUserId: 'usr_recipient', recipientDisplayName: 'Grace Hopper', note: null, ...metadataOverrides },
  )
}

describe('rowToWalletTransaction', () => {
  it('maps the debit side of a transfer (sender’s own perspective): negative amount, counterparty is the recipient', () => {
    const transaction = rowToWalletTransaction(makeTransferRow(), -50_000)

    expect(() => WalletTransactionSchema.parse(transaction)).not.toThrow()
    expect(transaction).toEqual({
      postingId: 'pst_xyz789',
      kind: 'transfer',
      amountKobo: -50_000,
      counterparty: 'Grace Hopper',
      note: 'lunch money',
      createdAt: '2026-09-01T12:00:00.000Z',
    })
  })

  it('maps the credit side of a transfer (recipient’s own perspective): positive amount, counterparty is the sender', () => {
    const transaction = rowToWalletTransaction(makeTransferRow(), 50_000)

    expect(() => WalletTransactionSchema.parse(transaction)).not.toThrow()
    expect(transaction.amountKobo).toBe(50_000)
    expect(transaction.counterparty).toBe('Ada Lovelace')
  })

  it('a topup has no human counterparty regardless of sign', () => {
    const credited = rowToWalletTransaction(makeTopupRow(), 100_000)
    expect(credited.counterparty).toBeNull()
    expect(credited.kind).toBe('topup')

    expect(() => WalletTransactionSchema.parse(credited)).not.toThrow()
  })

  it('note is null when the transfer carried none', () => {
    const transaction = rowToWalletTransaction(makeTransferRow({}, { note: null }), -50_000)
    expect(transaction.note).toBeNull()
  })

  it('throws — rather than silently returning a contract-violating body — if metadata fails its own schema', () => {
    expect(() => rowToWalletTransaction(makeTransferRow({ metadata: { not: 'the right shape' } }), -50_000)).toThrow()
  })

  it('throws if metadata is missing entirely (null)', () => {
    expect(() => rowToWalletTransaction(makeTransferRow({ metadata: null }), -50_000)).toThrow()
  })
})
