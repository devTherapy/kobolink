import { describe, expect, it } from 'vitest'
import { ApiErrorSchema, ErrorCodeSchema, HTTP_STATUS_FOR_ERROR, isApiError } from '../src/index.js'

describe('errors', () => {
  it('maps every error code to an HTTP status, and nothing else', () => {
    expect(Object.keys(HTTP_STATUS_FOR_ERROR).sort()).toEqual([...ErrorCodeSchema.options].sort())
    for (const status of Object.values(HTTP_STATUS_FOR_ERROR)) expect(status).toBeGreaterThanOrEqual(400)
  })

  it('recognises a well-formed error body and rejects a loose one', () => {
    expect(isApiError({ code: 'not_found', message: 'No such link' })).toBe(true)
    expect(isApiError({ code: 'validation_failed', message: 'x', fields: { title: ['Required'] } })).toBe(true)
    expect(isApiError({ code: 'teapot', message: 'x' })).toBe(false)
    expect(isApiError({ message: 'x' })).toBe(false)
    expect(ApiErrorSchema.safeParse({ code: 'internal', message: '' }).success).toBe(false)
  })

  it('a link_not_payable error can carry the resolved state, and only a known one', () => {
    expect(isApiError({ code: 'link_not_payable', message: 'x', state: 'already-paid' })).toBe(true)
    expect(isApiError({ code: 'link_not_payable', message: 'x', state: 'active' })).toBe(false)
  })

  it('has no payment_declined code — a gateway decline is a 200 with status failed, never an error', () => {
    expect(ErrorCodeSchema.options).not.toContain('payment_declined')
  })
})
