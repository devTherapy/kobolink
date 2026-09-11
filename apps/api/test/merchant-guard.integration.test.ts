import type { Server } from 'node:http'
import { Controller, Get, type INestApplication, UseGuards } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { User } from '@kobolink/contracts'
import supertest, { type Agent } from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuthService, type ResolvedSession } from '../src/auth/auth.service.js'
import { CurrentUser } from '../src/auth/current-user.decorator.js'
import { MerchantGuard } from '../src/auth/merchant.guard.js'
import { SessionGuard } from '../src/auth/session.guard.js'
import { configureApp } from '../src/configure-app.js'

const MERCHANT_TOKEN = 'test-merchant-token'
const CUSTOMER_TOKEN = 'test-customer-token'

function fakeUser(role: 'merchant' | 'customer'): User {
  return {
    id: role === 'merchant' ? 'u_merchant' : 'u_customer',
    role,
    email: `${role}@example.test`,
    phone: null,
    displayName: role === 'merchant' ? 'A Merchant' : 'A Customer',
    createdAt: new Date(0).toISOString(),
  }
}

interface PingBody {
  ok: boolean
  userId: string
}

/** Registered only for this test — a throwaway stand-in for a real merchant-only route, none of which exist yet (B3 is the first). */
@Controller('test-only')
class MerchantOnlyTestController {
  @Get('merchant-ping')
  @UseGuards(SessionGuard, MerchantGuard)
  ping(@CurrentUser() user: User): PingBody {
    return { ok: true, userId: user.id }
  }
}

/**
 * Review round 1, finding 6: `MerchantGuard` had no test at all —
 * `merchant.guard.spec.ts` covers its logic directly; this file exercises
 * the real composition (`@UseGuards(SessionGuard, MerchantGuard)`, real
 * HTTP, real Nest DI, the real global exception filter) end to end, against
 * a throwaway test-only route. `AuthService` is stubbed rather than real —
 * this is purely a guard-composition concern, so no Postgres/Testcontainers
 * is needed to prove it.
 */
describe('SessionGuard + MerchantGuard composition (throwaway test-only route, no Postgres)', () => {
  let app: INestApplication | undefined
  let request: Agent | undefined

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MerchantOnlyTestController],
      providers: [
        SessionGuard,
        MerchantGuard,
        {
          provide: AuthService,
          useValue: {
            resolveSession: (token: string): Promise<ResolvedSession | undefined> => {
              if (token === MERCHANT_TOKEN) return Promise.resolve({ user: fakeUser('merchant') } as ResolvedSession)
              if (token === CUSTOMER_TOKEN) return Promise.resolve({ user: fakeUser('customer') } as ResolvedSession)
              return Promise.resolve(undefined)
            },
          },
        },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    configureApp(app)
    await app.init()
    request = supertest(app.getHttpServer() as Server)
  })

  afterAll(async () => {
    await app?.close()
  })

  it('401 with no credential at all', async () => {
    const response = await getRequest().get('/api/test-only/merchant-ping')
    expect(response.status).toBe(401)
  })

  it('403 for an authenticated customer', async () => {
    const response = await getRequest().get('/api/test-only/merchant-ping').set('Authorization', `Bearer ${CUSTOMER_TOKEN}`)
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'forbidden' })
  })

  it('200 for an authenticated merchant', async () => {
    const response = await getRequest().get('/api/test-only/merchant-ping').set('Authorization', `Bearer ${MERCHANT_TOKEN}`)
    expect(response.status).toBe(200)
    const body = response.body as PingBody
    expect(body.ok).toBe(true)
    expect(body.userId).toBe('u_merchant')
  })

  function getRequest(): Agent {
    if (request === undefined) throw new Error('beforeAll did not produce a request agent — see its own failure above')
    return request
  }
})
