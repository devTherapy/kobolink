import type { ExecutionContext } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import type { ResolvedSession } from './auth.service.js'
import type { AuthenticatedRequest } from './authenticated-request.js'
import { MerchantGuard } from './merchant.guard.js'

function contextWithAuth(auth: ResolvedSession | undefined): ExecutionContext {
  const request = { auth } as AuthenticatedRequest
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

function resolvedSession(role: 'merchant' | 'customer'): ResolvedSession {
  return {
    user: {
      id: role === 'merchant' ? 'u_merchant' : 'u_customer',
      role,
      email: `${role}@example.test`,
      phone: null,
      displayName: role === 'merchant' ? 'A Merchant' : 'A Customer',
      createdAt: new Date(0).toISOString(),
    },
  } as ResolvedSession
}

describe('MerchantGuard (review round 1, finding 6 — previously untested)', () => {
  it('allows a merchant through', () => {
    const guard = new MerchantGuard()
    expect(guard.canActivate(contextWithAuth(resolvedSession('merchant')))).toBe(true)
  })

  it('rejects a customer with forbidden, not unauthenticated — they are a real, authenticated user, just not allowed here', () => {
    const guard = new MerchantGuard()
    expect.assertions(2)
    try {
      guard.canActivate(contextWithAuth(resolvedSession('customer')))
    } catch (error) {
      expect(error).toBeInstanceOf(ApiErrorException)
      expect((error as ApiErrorException).getResponse()).toMatchObject({ code: 'forbidden' })
    }
  })

  it('rejects a request with no resolved session as unauthenticated — only reachable if a route uses MerchantGuard without SessionGuard ahead of it', () => {
    const guard = new MerchantGuard()
    expect.assertions(2)
    try {
      guard.canActivate(contextWithAuth(undefined))
    } catch (error) {
      expect(error).toBeInstanceOf(ApiErrorException)
      expect((error as ApiErrorException).getResponse()).toMatchObject({ code: 'unauthenticated' })
    }
  })
})
