import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { HTTP_STATUS_FOR_ERROR } from '@kobolink/contracts'
import { ApiErrorException } from '../errors/api-error.exception.js'
import { toApiErrorResponse } from './error-mapping.js'

describe('toApiErrorResponse', () => {
  it('forwards an ApiErrorException body and status untouched', () => {
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

  it.each([
    [new NotFoundException('no such link'), 404, 'not_found'],
    [new UnauthorizedException(), 401, 'unauthenticated'],
    [new ForbiddenException(), 403, 'forbidden'],
    [new ConflictException('already exists'), 409, 'conflict'],
    [new BadRequestException('bad input'), 400, 'validation_failed'],
  ] as const)('maps a bare Nest %s to status %i and code %s', (exception, status, code) => {
    const result = toApiErrorResponse(exception)

    expect(result.status).toBe(status)
    expect(result.body.code).toBe(code)
    expect(result.body.message.length).toBeGreaterThan(0)
  })

  it('keeps the exception status even when no contract code maps to it cleanly', () => {
    // 418 has no entry in the fallback table; the status must still be honoured.
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

  it('maps a non-HttpException (a genuine bug) to an opaque internal error, never leaking detail', () => {
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
