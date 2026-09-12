import { API, type AuthResponse, AuthResponseSchema } from '@kobolink/contracts'
import type { ApiTestContext } from './api-test-context.js'

/**
 * Shared by every B3 (`links`) integration test file: registers a real user
 * through the actual `POST /api/auth/register` endpoint (B2, already
 * merged) and hands back the `Cookie` header value for subsequent
 * authenticated requests — the same pattern `auth-session.integration.test.ts`
 * uses inline, promoted here since B3's suites each need several merchants
 * and a customer, not just one or two fixture users.
 */
export interface RegisteredUser {
  cookie: string
  userId: string
  displayName: string
  phone: string | null
}

function sessionCookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const setCookie = response.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie !== undefined ? [setCookie] : []
  const match = cookies.map((c) => c.split(';')[0]).find((c) => c?.startsWith('kobolink_session='))
  if (match === undefined) throw new Error('no kobolink_session cookie in response headers')
  return match
}

async function register(
  ctx: ApiTestContext,
  email: string,
  displayName: string,
  role: 'merchant' | 'customer',
  phone?: string,
): Promise<RegisteredUser> {
  const response = await ctx.request.post(API.auth.register).send({
    email,
    password: 'correct horse battery staple',
    displayName,
    role,
    client: 'web',
    ...(phone !== undefined ? { phone } : {}),
  })
  if (response.status !== 201) {
    throw new Error(`fixture register (${role}) failed: ${response.status} ${JSON.stringify(response.body)}`)
  }
  const body: AuthResponse = AuthResponseSchema.parse(response.body)
  return { cookie: sessionCookieFrom(response), userId: body.user.id, displayName: body.user.displayName, phone: body.user.phone }
}

export async function registerMerchant(
  ctx: ApiTestContext,
  email: string,
  displayName = 'Adebayo Stores',
  phone?: string,
): Promise<RegisteredUser> {
  return register(ctx, email, displayName, 'merchant', phone)
}

export async function registerCustomer(
  ctx: ApiTestContext,
  email: string,
  displayName = 'A Customer',
  phone?: string,
): Promise<RegisteredUser> {
  return register(ctx, email, displayName, 'customer', phone)
}
