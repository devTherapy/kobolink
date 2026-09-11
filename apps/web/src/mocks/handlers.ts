import { http, HttpResponse, type JsonBodyType, type PathParams } from 'msw'
import {
  API,
  HTTP_STATUS_FOR_ERROR,
  IDEMPOTENCY_HEADER,
  IdempotencyKeySchema,
  LinkCodeSchema,
  SCHEMAS,
  exampleLink,
  exampleUser,
  isSimulatedDecline,
  maskEmail,
  newLinkCode,
  newPaymentReference,
  resolveLink,
  toPublicLink,
  toPublicLinkState,
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
  type Payment,
  type PaymentLink,
  type SchemaName,
} from '@kobolink/contracts'
import {
  checkoutSessions,
  computeDashboardStats,
  idempotencyStore,
  linkStore,
  paymentsByCode,
  recordSuccessfulPayment,
  walletFixture,
  walletState,
} from './state'

/**
 * Every handler builds its response from a `@kobolink/contracts` fixture (or
 * the in-memory store in `state.ts`) and validates the result against
 * `SCHEMAS[name]` — or, for an error, `SCHEMAS.ApiError` — before returning
 * it. A response shape that drifts from the contract throws in the test that
 * exercises it, not silently ships a screen against a lie.
 */
interface JsonResult {
  status: number
  body: unknown
}
type JsonResponse = ReturnType<typeof HttpResponse.json>

function buildSuccess<Name extends SchemaName>(name: Name, body: unknown, status = 200): JsonResult {
  const result = SCHEMAS[name].safeParse(body)
  if (!result.success) {
    throw new Error(
      `MSW handler for "${name}" returned a body that fails its own contract schema:\n${result.error.message}`,
    )
  }
  return { status, body }
}

/**
 * `moneyMoved` is set on every error from the four money-moving endpoints
 * (`checkout.initialize`, `checkout.verify`, `wallet.transfer`,
 * `wallet.topup`) and absent everywhere else — callers pass it via `extra`.
 */
function buildError(code: ErrorCode, message: string, extra: Partial<ApiError> = {}): JsonResult {
  const body: ApiError = { code, message, ...extra }
  const result = SCHEMAS.ApiError.safeParse(body)
  if (!result.success) {
    throw new Error(`MSW handler returned an ApiError that fails its own contract schema:\n${result.error.message}`)
  }
  return { status: HTTP_STATUS_FOR_ERROR[code], body }
}

function toResponse(result: JsonResult): JsonResponse {
  return HttpResponse.json(result.body as JsonBodyType, { status: result.status })
}

function respond<Name extends SchemaName>(name: Name, body: unknown, status = 200): JsonResponse {
  return toResponse(buildSuccess(name, body, status))
}

function errorResponse(code: ErrorCode, message: string, extra: Partial<ApiError> = {}): JsonResponse {
  return toResponse(buildError(code, message, extra))
}

/** Every money-moving write requires this header; a missing one is `validation_failed`. */
function readIdempotencyKey(request: Request): string | null {
  const key = request.headers.get(IDEMPOTENCY_HEADER)
  if (!key || !IdempotencyKeySchema.safeParse(key).success) return null
  return key
}

/** A malformed JSON body parses to `undefined` — which fails every request schema's `safeParse` and answers `validation_failed` — rather than letting `JSON.parse` throw into MSW's generic 500. */
async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * README: "the server stores (scope, key, request hash, response)... A
 * replay with the same scope, key and body returns the stored response with
 * the original status; the same key with a different body is
 * `idempotency_mismatch`." `pathKey` is the scope for these unauthenticated
 * endpoints, matching what the real API uses.
 */
function withIdempotency(pathKey: string, key: string, requestData: unknown, compute: () => JsonResult): JsonResult {
  const storeKey = `${pathKey}:${key}`
  const requestHash = JSON.stringify(requestData)
  const existing = idempotencyStore.get(storeKey)
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return buildError('idempotency_mismatch', 'This Idempotency-Key was already used with a different request.', {
        moneyMoved: false,
      })
    }
    return { status: existing.status, body: existing.body }
  }
  const result = compute()
  idempotencyStore.set(storeKey, { requestHash, status: result.status, body: result.body })
  return result
}

/** A malformed or unknown code is `not_found`, never a crash. */
function requireLink(code: string): PaymentLink | JsonResponse {
  if (!LinkCodeSchema.safeParse(code).success) {
    return errorResponse('not_found', 'No link with that code.')
  }
  const link = linkStore.get(code)
  if (!link) {
    return errorResponse('not_found', 'No link with that code.')
  }
  return link
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`
}

function codeParam(params: PathParams<string>): string {
  const value = params.code
  return typeof value === 'string' ? value : ''
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
    const code = newLinkCode()
    const link = exampleLink({
      code,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      amountKobo: parsed.data.amountKobo,
      isReusable: parsed.data.isReusable,
      expiresAt: parsed.data.expiresAt,
      paymentCount: 0,
      totalPaidKobo: 0,
    })
    linkStore.set(code, link)
    return respond('PaymentLink', link, 201)
  }),

  http.get(API.links.collection, () =>
    // README: "Only the caller's links, newest first." linkStore is
    // insertion-ordered (oldest first), so reverse it.
    respond('LinkListResponse', { items: Array.from(linkStore.values()).reverse(), nextCursor: null }),
  ),

  http.get(API.links.item(':code'), ({ params }) => {
    const linkOrError = requireLink(codeParam(params))
    if (linkOrError instanceof HttpResponse) return linkOrError
    return respond('PaymentLink', linkOrError)
  }),

  http.patch(API.links.status(':code'), async ({ request, params }) => {
    const linkOrError = requireLink(codeParam(params))
    if (linkOrError instanceof HttpResponse) return linkOrError
    const parsed = UpdateLinkStatusRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse('validation_failed', 'That status is not valid.')
    const updated: PaymentLink = { ...linkOrError, status: parsed.data.status }
    linkStore.set(updated.code, updated)
    return respond('PaymentLink', updated)
  }),

  http.get(API.links.payments(':code'), ({ params }) => {
    const linkOrError = requireLink(codeParam(params))
    if (linkOrError instanceof HttpResponse) return linkOrError
    // Already newest first — `recordSuccessfulPayment` unshifts.
    const items = paymentsByCode.get(linkOrError.code) ?? []
    return respond('PaymentListResponse', { items, nextCursor: null })
  }),

  http.get(API.links.resolve(':code'), ({ params }) => {
    const linkOrError = requireLink(codeParam(params))
    if (linkOrError instanceof HttpResponse) return linkOrError
    const resolution = resolveLink(linkOrError)
    const state = toPublicLinkState(resolution)
    // Unreachable in practice — `requireLink` already excluded "not found",
    // the only resolution `toPublicLinkState` maps to null — but kept so a
    // future change to either function fails loudly instead of returning an
    // invalid PublicLinkResponse.
    if (state === null) return errorResponse('not_found', 'No link with that code.')
    return respond('PublicLinkResponse', { state, link: toPublicLink(linkOrError) })
  }),

  // ---- checkout -----------------------------------------------------------
  http.post(API.checkout.initialize, async ({ request }) => {
    const key = readIdempotencyKey(request)
    if (!key) return errorResponse('validation_failed', 'Idempotency-Key header is required.', { moneyMoved: false })
    const parsed = InitializeCheckoutRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse('validation_failed', 'That checkout could not start.', { moneyMoved: false })
    }

    const result = withIdempotency(API.checkout.initialize, key, parsed.data, (): JsonResult => {
      const link = linkStore.get(parsed.data.code) ?? null
      const resolution = resolveLink(link)
      if (resolution.kind === 'not-found') {
        return buildError('not_found', 'No link with that code.', { moneyMoved: false })
      }
      if (resolution.kind !== 'payable') {
        return buildError('link_not_payable', 'This link cannot be paid right now.', {
          moneyMoved: false,
          state: toPublicLinkState(resolution) ?? undefined,
        })
      }
      if (resolution.link.amountKobo !== null && resolution.link.amountKobo !== parsed.data.amountKobo) {
        return buildError('amount_mismatch', 'That amount does not match this link.', { moneyMoved: false })
      }
      const reference = newPaymentReference()
      checkoutSessions.set(reference, {
        code: resolution.link.code,
        amountKobo: parsed.data.amountKobo,
        payerName: parsed.data.payerName,
        payerEmail: parsed.data.payerEmail,
      })
      return buildSuccess(
        'InitializeCheckoutResponse',
        {
          reference,
          code: resolution.link.code,
          amountKobo: parsed.data.amountKobo,
          currency: 'NGN',
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
        201,
      )
    })

    return toResponse(result)
  }),

  http.post(API.checkout.verify, async ({ request }) => {
    const key = readIdempotencyKey(request)
    if (!key) return errorResponse('validation_failed', 'Idempotency-Key header is required.', { moneyMoved: false })
    const parsed = VerifyCheckoutRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse('validation_failed', 'That reference is not valid.', { moneyMoved: false })
    }

    const result = withIdempotency(API.checkout.verify, key, parsed.data, (): JsonResult => {
      const session = checkoutSessions.get(parsed.data.reference)
      if (!session) {
        return buildError('not_found', 'No checkout with that reference.', { moneyMoved: false })
      }

      // A verify is a *read* of this reference's one outcome — Paystack's
      // shape, deliberately. Once decided, re-verifying (even under a
      // different Idempotency-Key, which the memo above does not cover
      // since its key differs) must return the same payment, never decide
      // again or post to the link a second time.
      if (session.result) {
        return buildSuccess('VerifyCheckoutResponse', { payment: session.result })
      }

      const declined = isSimulatedDecline(session.payerEmail)
      const now = new Date().toISOString()
      const payment: Payment = {
        reference: parsed.data.reference,
        code: session.code,
        amountKobo: session.amountKobo,
        currency: 'NGN',
        status: declined ? 'failed' : 'success',
        payerName: session.payerName,
        payerEmail: maskEmail(session.payerEmail),
        createdAt: now,
        completedAt: now,
        failureReason: declined ? 'Card declined by the simulated gateway.' : null,
        moneyMoved: !declined,
      }
      session.result = payment
      if (!declined) recordSuccessfulPayment(session.code, payment)

      return buildSuccess('VerifyCheckoutResponse', { payment })
    })

    return toResponse(result)
  }),

  // ---- dashboard ----------------------------------------------------------
  http.get(API.dashboard.stats, () => respond('DashboardStats', computeDashboardStats())),
  // API.dashboard.stream is Server-Sent Events, not a JSON response body —
  // MSW's http handlers do not model SSE. Left for F7, which wires the SSE
  // client and needs a streaming mock, not a `respond()`-shaped one.

  // ---- wallet (Phase 2) -----------------------------------------------------
  http.get(API.wallet.me, () => respond('Wallet', walletFixture())),

  http.get(API.wallet.transactions, () =>
    respond('WalletTransactionListResponse', { items: [], nextCursor: null }),
  ),

  http.post(API.wallet.transfer, async ({ request }) => {
    const key = readIdempotencyKey(request)
    if (!key) return errorResponse('validation_failed', 'Idempotency-Key header is required.', { moneyMoved: false })
    const parsed = TransferRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse('validation_failed', 'That transfer could not be started.', { moneyMoved: false })
    }

    const result = withIdempotency(API.wallet.transfer, key, parsed.data, (): JsonResult => {
      if (parsed.data.amountKobo > walletState.balanceKobo) {
        return buildError('insufficient_funds', 'This wallet does not have enough balance for that transfer.', {
          moneyMoved: false,
        })
      }
      walletState.balanceKobo -= parsed.data.amountKobo
      return buildSuccess('TransferResponse', {
        transaction: {
          postingId: newId('pst'),
          kind: 'transfer',
          amountKobo: -parsed.data.amountKobo,
          counterparty: null,
          note: parsed.data.note ?? null,
          createdAt: new Date().toISOString(),
        },
        wallet: walletFixture(),
      })
    })

    return toResponse(result)
  }),

  http.post(API.wallet.topup, async ({ request }) => {
    const key = readIdempotencyKey(request)
    if (!key) return errorResponse('validation_failed', 'Idempotency-Key header is required.', { moneyMoved: false })
    const parsed = TopUpRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) {
      return errorResponse('validation_failed', 'That top-up could not be started.', { moneyMoved: false })
    }

    const result = withIdempotency(API.wallet.topup, key, parsed.data, (): JsonResult => {
      walletState.balanceKobo += parsed.data.amountKobo
      return buildSuccess('TransferResponse', {
        transaction: {
          postingId: newId('pst'),
          kind: 'topup',
          amountKobo: parsed.data.amountKobo,
          counterparty: null,
          note: null,
          createdAt: new Date().toISOString(),
        },
        wallet: walletFixture(),
      })
    })

    return toResponse(result)
  }),
]
