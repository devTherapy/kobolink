import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { type ApiError, HTTP_STATUS_FOR_ERROR } from '@kobolink/contracts'
import { ApiErrorException } from '../errors/api-error.exception.js'
import { toApiErrorResponse } from './error-mapping.js'

describe('toApiErrorResponse', () => {
  it('forwards an ApiErrorException body and status untouched on the happy path', () => {
    const exception = new ApiErrorException({
      code: 'link_not_payable',
      message: 'This link cannot be paid right now.',
      state: 'expired',
    })

    const { status, body } = toApiErrorResponse(exception)

    expect(status).toBe(HTTP_STATUS_FOR_ERROR.link_not_payable)
    expect(body).toEqual({
      code: 'link_not_payable',
      message: 'This link cannot be paid right now.',
      state: 'expired',
    })
  })

  it('forwards the parsed ApiError data (unknown keys stripped by zod), not the raw payload', () => {
    const rawPayload = { code: 'not_found', message: 'no such link', extra: 'should not survive' }
    const exception = new ApiErrorException(rawPayload as unknown as ApiError)

    const { body } = toApiErrorResponse(exception)

    expect(body).toEqual({ code: 'not_found', message: 'no such link' })
    expect(body).not.toHaveProperty('extra')
  })

  it('salvages a safe { code, message } and logs when an ApiErrorException payload fails ApiErrorSchema — only the field the refinement rejected is dropped', () => {
    const logger = { error: vi.fn() }
    // ApiErrorSchema's own refinement forbids state: 'payable' on a
    // link_not_payable error; code and message are still trustworthy.
    const exception = new ApiErrorException({
      code: 'link_not_payable',
      message: 'This link cannot be paid right now.',
      state: 'payable',
    })

    const { status, body } = toApiErrorResponse(exception, logger)

    expect(status).toBe(HTTP_STATUS_FOR_ERROR.link_not_payable)
    expect(body).toEqual({ code: 'link_not_payable', message: 'This link cannot be paid right now.' })
    expect(logger.error).toHaveBeenCalledOnce()
  })

  it.each([
    [new NotFoundException('no such link'), 404, 'not_found'],
    [new UnauthorizedException(), 401, 'unauthenticated'],
    [new ForbiddenException(), 403, 'forbidden'],
    [new ConflictException('already exists'), 409, 'conflict'],
    [new BadRequestException('bad input'), 400, 'validation_failed'],
    // No bare exception can say *which* 422 it means; idempotency conflicts
    // are the most common unshaped 422 in this API's surface.
    [new UnprocessableEntityException('key already used'), 422, 'idempotency_mismatch'],
  ] as const)('maps a bare Nest %s to status %i and code %s', (exception, status, code) => {
    const result = toApiErrorResponse(exception)

    expect(result.status).toBe(status)
    expect(result.body.code).toBe(code)
    expect(result.body.message.length).toBeGreaterThan(0)
  })

  it('keeps the exception status even when no contract code maps to it cleanly, rather than forcing HTTP_STATUS_FOR_ERROR[code]', () => {
    // 418 has no entry in the fallback table; the status must still be
    // honoured rather than collapsed to internal's canonical 500.
    class TeapotException extends BadRequestException {}
    const exception = new TeapotException()
    Object.defineProperty(exception, 'getStatus', { value: () => 418 })

    const { status, body } = toApiErrorResponse(exception)

    expect(status).toBe(418)
    expect(body.code).toBe('internal')
  })

  it('collapses class-validator-style string-array messages into one string', () => {
    const exception = new BadRequestException({ message: ['field a is required', 'field b is required'] })

    const { body } = toApiErrorResponse(exception)

    expect(body.message).toBe('field a is required field b is required')
  })

  it('never forwards a 5xx HttpException message verbatim — it can carry driver/internal detail', () => {
    const exception = new InternalServerErrorException('password authentication failed for user "kobolink"')

    const { status, body } = toApiErrorResponse(exception)

    expect(status).toBe(500)
    expect(body.message).toBe('Internal server error.')
    expect(body.message).not.toContain('password')
  })

  it('honours a 4xx status/statusCode on a plain (non-HttpException) error — Express body-parser style', () => {
    const malformedJson = Object.assign(new Error('Unexpected token h in JSON at position 0'), {
      status: 400,
      type: 'entity.parse.failed',
    })

    const { status, body } = toApiErrorResponse(malformedJson)

    expect(status).toBe(400)
    expect(body.code).toBe('validation_failed')
    expect(body.message).toBe('Unexpected token h in JSON at position 0')
  })

  it('honours statusCode too, and an unmapped 4xx falls back to code internal without losing the real status', () => {
    const payloadTooLarge = Object.assign(new Error('request entity too large'), { statusCode: 413 })

    const { status, body } = toApiErrorResponse(payloadTooLarge)

    expect(status).toBe(413)
    expect(body.code).toBe('internal')
    expect(body.message).toBe('request entity too large')
  })

  it('forces an opaque message for a plain error whose own status is 5xx', () => {
    const exception = Object.assign(new Error('ECONNRESET at internal socket layer'), { statusCode: 503 })

    const { status, body } = toApiErrorResponse(exception)

    expect(status).toBe(503)
    expect(body.message).toBe('Internal server error.')
  })

  it('maps a non-HttpException with no usable status (a genuine bug) to an opaque internal error, never leaking detail', () => {
    const { status, body } = toApiErrorResponse(new TypeError('cannot read property of undefined'))

    expect(status).toBe(HTTP_STATUS_FOR_ERROR.internal)
    expect(body).toEqual({ code: 'internal', message: 'Internal server error.' })
  })

  it('maps a thrown non-Error value the same way', () => {
    const { status, body } = toApiErrorResponse('a string was thrown')

    expect(status).toBe(HTTP_STATUS_FOR_ERROR.internal)
    expect(body.code).toBe('internal')
  })
})
