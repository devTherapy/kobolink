import { http, HttpResponse, type HttpResponseResolver, type JsonBodyType } from 'msw'
import {
  API,
  HTTP_STATUS_FOR_ERROR,
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  SCHEMAS,
  examplePayment,
  examplePublicLinkResponse,
  exampleLink,
  exampleStats,
  exampleUser,
  exampleWallet,
  newPaymentReference,
  toPublicLink,
  LoginRequestSchema,
  RegisterRequestSchema,
  CreateLinkRequestSchema,
  UpdateLinkStatusRequestSchema,
  InitializeCheckoutRequestSchema,
  VerifyCheckoutRequestSchema,
  TransferRequestSchema,
  TopUpRequestSchema,
  type ApiError,
  type ErrorCode,
  type SchemaName,
} from '@kobolink/contracts'

/**
 * Every handler builds its response from a `@kobolink/contracts` fixture and
 * validates the result against `SCHEMAS[name]` before returning it — a
 * response shape that drifts from the contract fails the test that exercises
 * it, not silently ships a screen against a lie.
 */
type JsonResponse = ReturnType<typeof HttpResponse.json>

function respond<Name extends SchemaName>(name: Name, body: unknown, status = 200): JsonResponse {
  const result = SCHEMAS[name].safeParse(body)
  if (!result.success) {
    throw new Error(
      `MSW handler for "${name}" returned a body that fails its own contract schema:\n${result.error.message}`,
    )
  }
  return HttpResponse.json(body as JsonBodyType, { status })
}

function errorResponse(code: ErrorCode, message: string, extra: Partial<ApiError> = {}): JsonResponse {
  const body: ApiError = { code, message, ...extra }
  return HttpResponse.json(body, { status: HTTP_STATUS_FOR_ERROR[code] })
}

/** Every money-moving write requires this header; a missing one is `validation_failed`. */
function readIdempotencyKey(request: Request): string | null {
  const key = request.headers.get(IDEMPOTENCY_HEADER)
  if (!key || !IdempotencyKeySchema.safeParse(key).success) return null
  return key
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  return text.length > 0 ? (JSON.parse(text) as unknown) : undefined
}

const withCode =
  (build: (code: string) => JsonResponse): HttpResponseResolver =>
  ({ params }) => {
    const code = typeof params.code === 'string' ? params.code : ''
    return build(code)
  }

export const handlers = [
  // ---- health -------------------------------------------------------------
  // No schema exists for this shape in packages/contracts (SCHEMAS has no
  // "Health" entry) — returned verbatim from the README rather than invented
  // as a new contract shape. Flagged in the PR description.
  http.get(API.health, () => HttpResponse.json({ status: 'ok' })),

  // ---- auth -----------------------------------------------------------------
  http.post(API.auth.register, async ({ request }) => {
    const parsed = RegisterRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'Could not register with that input.')
    const user = exampleUser({
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      phone: parsed.data.phone ?? null,
      role: parsed.data.role,
    })
    return respond(
      'AuthResponse',
      {
        user,
        session: { id: 'ses_9f8h2Kd3Lm1', expiresAt: '2026-06-22T12:00:00.000Z' },
        ...(parsed.data.client === 'mobile' ? { token: 'a'.repeat(48) } : {}),
      },
      201,
    )
  }),

  http.post(API.auth.login, async ({ request }) => {
    const parsed = LoginRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'Could not sign in with that input.')
    return respond('AuthResponse', {
      user: exampleUser({ email: parsed.data.email }),
      session: { id: 'ses_9f8h2Kd3Lm1', expiresAt: '2026-06-22T12:00:00.000Z' },
      ...(parsed.data.client === 'mobile' ? { token: 'a'.repeat(48) } : {}),
    })
  }),

  http.post(API.auth.logout, () => new HttpResponse(null, { status: 204 })),

  http.get(API.auth.me, () => respond('MeResponse', { user: exampleUser() })),

  // ---- links ------------------------------------------------------------
  http.post(API.links.collection, async ({ request }) => {
    const parsed = CreateLinkRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'That link could not be created.')
    return respond(
      'PaymentLink',
      exampleLink({
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        amountKobo: parsed.data.amountKobo,
        isReusable: parsed.data.isReusable,
        expiresAt: parsed.data.expiresAt,
        paymentCount: 0,
        totalPaidKobo: 0,
      }),
      201,
    )
  }),

  http.get(API.links.collection, () =>
    respond('LinkListResponse', { items: [exampleLink()], nextCursor: null }),
  ),

  http.get('/api/links/:code', withCode((code) => respond('PaymentLink', exampleLink({ code })))),

  http.patch('/api/links/:code/status', async ({ request, params }) => {
    const code = typeof params.code === 'string' ? params.code : ''
    const parsed = UpdateLinkStatusRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'That status is not valid.')
    return respond('PaymentLink', exampleLink({ code, status: parsed.data.status }))
  }),

  http.get(
    '/api/links/:code/payments',
    withCode((code) =>
      respond('PaymentListResponse', { items: [examplePayment({ code })], nextCursor: null }),
    ),
  ),

  http.get(
    '/api/links/:code/public',
    withCode((code) => {
      const response = examplePublicLinkResponse({ link: toPublicLink(exampleLink({ code })) })
      return respond('PublicLinkResponse', response)
    }),
  ),

  // ---- checkout -----------------------------------------------------------
  http.post(API.checkout.initialize, async ({ request }) => {
    if (!readIdempotencyKey(request)) {
      return errorResponse('validation_failed', 'Idempotency-Key header is required.')
    }
    const parsed = InitializeCheckoutRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'That checkout could not start.')
    return respond(
      'InitializeCheckoutResponse',
      {
        reference: newPaymentReference(),
        code: parsed.data.code,
        amountKobo: parsed.data.amountKobo,
        currency: 'NGN',
        status: 'pending',
        createdAt: '2026-06-14T18:19:58.000Z',
      },
      201,
    )
  }),

  http.post(API.checkout.verify, async ({ request }) => {
    if (!readIdempotencyKey(request)) {
      return errorResponse('validation_failed', 'Idempotency-Key header is required.')
    }
    const parsed = VerifyCheckoutRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'That reference is not valid.')
    return respond('VerifyCheckoutResponse', { payment: examplePayment({ reference: parsed.data.reference }) })
  }),

  // ---- dashboard ----------------------------------------------------------
  http.get(API.dashboard.stats, () => respond('DashboardStats', exampleStats())),
  // API.dashboard.stream is Server-Sent Events, not a JSON response body —
  // MSW's http handlers do not model SSE. Left for F7, which wires the SSE
  // client and needs a streaming mock, not a `respond()`-shaped one.

  // ---- wallet (Phase 2) -----------------------------------------------------
  http.get(API.wallet.me, () => respond('Wallet', exampleWallet())),

  http.get(API.wallet.transactions, () =>
    respond('WalletTransactionListResponse', { items: [], nextCursor: null }),
  ),

  http.post(API.wallet.transfer, async ({ request }) => {
    if (!readIdempotencyKey(request)) {
      return errorResponse('validation_failed', 'Idempotency-Key header is required.')
    }
    const parsed = TransferRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'That transfer could not be started.')
    const wallet = exampleWallet({ balanceKobo: 12_500_000 - parsed.data.amountKobo })
    return respond('TransferResponse', {
      transaction: {
        postingId: 'pst_3kR8mN2xVq',
        kind: 'transfer',
        amountKobo: -parsed.data.amountKobo,
        counterparty: null,
        note: parsed.data.note ?? null,
        createdAt: '2026-06-15T12:00:00.000Z',
      },
      wallet,
    })
  }),

  http.post(API.wallet.topup, async ({ request }) => {
    if (!readIdempotencyKey(request)) {
      return errorResponse('validation_failed', 'Idempotency-Key header is required.')
    }
    const parsed = TopUpRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'That top-up could not be started.')
    const wallet = exampleWallet({ balanceKobo: 12_500_000 + parsed.data.amountKobo })
    return respond('TransferResponse', {
      transaction: {
        postingId: 'pst_7pL4qW9nKs',
        kind: 'topup',
        amountKobo: parsed.data.amountKobo,
        counterparty: null,
        note: null,
        createdAt: '2026-06-15T12:00:00.000Z',
      },
      wallet,
    })
  }),
]
