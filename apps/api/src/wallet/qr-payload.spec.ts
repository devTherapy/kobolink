import { QR_PAYLOAD_VERSION, QrPayloadSchema } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import { buildQrPayload } from './qr-payload.js'

describe('buildQrPayload', () => {
  it('builds a QrPayload that satisfies the contract schema exactly, with an amount', () => {
    const payload = buildQrPayload({ phone: '+2348031234567', displayName: 'Ada Lovelace' }, 50_000)

    expect(() => QrPayloadSchema.parse(payload)).not.toThrow()
    expect(payload).toEqual({
      v: QR_PAYLOAD_VERSION,
      toPhone: '+2348031234567',
      displayName: 'Ada Lovelace',
      amountKobo: 50_000,
    })
  })

  it('a null amount means "pay whatever you like" — still a valid payload', () => {
    const payload = buildQrPayload({ phone: '+2348031234567', displayName: 'Ada Lovelace' }, null)

    expect(() => QrPayloadSchema.parse(payload)).not.toThrow()
    expect(payload.amountKobo).toBeNull()
  })

  it('throws for a user with no phone on file — nobody could scan their way to paying them', () => {
    expect(() => buildQrPayload({ phone: null, displayName: 'Ada Lovelace' }, null)).toThrow()
  })
})
