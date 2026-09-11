import {
  exampleLink,
  examplePayment,
  exampleWallet,
  resolveLink,
  type DashboardStats,
  type Payment,
  type PaymentLink,
} from '@kobolink/contracts'

/**
 * The MSW handler set's in-memory backend. A payment-link mock that always
 * answers from a fresh fixture cannot model "create it, pay it, then resolve
 * it as already-paid" — the exact sequence F4/F5/F6 screens exercise — so
 * the handlers share this store instead. Money-moving handlers (`checkout.*`,
 * `wallet.*`) read and write it too, which is what makes the simulated
 * decline, the idempotency replay, and the overdraft rejection possible.
 *
 * `linkStore`, `paymentsByCode`, and `walletState` are kept mutually
 * consistent: a successful `checkout.verify` is the only thing that writes a
 * payment, and it always updates the link's counters and the payments list
 * together (`recordSuccessfulPayment`) — so `dashboard.stats`, a link's
 * `paymentCount`/`totalPaidKobo`, and `GET .../payments` can never disagree
 * with each other the way three independently-hardcoded fixtures could.
 *
 * Test-only state: `resetMockState()` runs in `src/test/setup.ts`'s
 * `afterEach`, alongside `server.resetHandlers()`, so one test's writes never
 * leak into the next.
 */

export const INITIAL_WALLET_BALANCE_KOBO = 12_500_000

export const linkStore = new Map<string, PaymentLink>()

/** Newest first, matching `GET /api/links/:code/payments`'s contract. */
export const paymentsByCode = new Map<string, Payment[]>()

export interface CheckoutSession {
  code: string
  amountKobo: number
  payerName: string
  payerEmail: string
  /**
   * Set the first time this reference is verified. `checkout.verify` is a
   * *read* of one transaction's outcome, exactly like Paystack's — verifying
   * the same reference again (even under a different Idempotency-Key, which
   * the `(path, key)` memo below does not cover) must return this same
   * payment, never decide the outcome or post to the link a second time.
   */
  result?: Payment
}

export const checkoutSessions = new Map<string, CheckoutSession>()

export interface IdempotencyRecord {
  requestHash: string
  status: number
  body: unknown
}

/** Keyed by `${endpoint path}:${Idempotency-Key}` — the scope the README describes for the unauthenticated checkout endpoints. */
export const idempotencyStore = new Map<string, IdempotencyRecord>()

export const walletState = { balanceKobo: INITIAL_WALLET_BALANCE_KOBO }

function seedDefaultLink(): void {
  const link = exampleLink()
  linkStore.set(link.code, link)
  // Back the fixture's paymentCount: 3 / totalPaidKobo: 5_550_000 with real
  // payment records, so they are the store's answer, not phantom counters
  // sitting next to an empty payments list and a static dashboard total.
  paymentsByCode.set(link.code, [
    examplePayment({
      reference: 'kbl_7hK2mN9pQr',
      code: link.code,
      createdAt: '2026-06-14T18:20:00.000Z',
      completedAt: '2026-06-14T18:20:04.000Z',
    }),
    examplePayment({
      reference: 'kbl_3jL5pR2wXz',
      code: link.code,
      createdAt: '2026-06-13T10:05:00.000Z',
      completedAt: '2026-06-13T10:05:03.000Z',
    }),
    examplePayment({
      reference: 'kbl_9qN4sT8vBc',
      code: link.code,
      createdAt: '2026-06-12T09:15:00.000Z',
      completedAt: '2026-06-12T09:15:02.000Z',
    }),
  ])
}

export function resetMockState(): void {
  linkStore.clear()
  paymentsByCode.clear()
  checkoutSessions.clear()
  idempotencyStore.clear()
  walletState.balanceKobo = INITIAL_WALLET_BALANCE_KOBO
  seedDefaultLink()
}

// Seed once at module load too, so a handler used outside the Vitest
// lifecycle (e.g. the browser worker in `npm run dev`) still has data.
seedDefaultLink()

export function walletFixture() {
  return exampleWallet({ balanceKobo: walletState.balanceKobo })
}

/**
 * The one place a successful payment is written. Called once, from
 * `checkout.verify`'s success path — never from a retry or a replay, both of
 * which return the already-recorded `CheckoutSession.result` instead.
 */
export function recordSuccessfulPayment(code: string, payment: Payment): void {
  const existing = paymentsByCode.get(code) ?? []
  paymentsByCode.set(code, [payment, ...existing])

  const link = linkStore.get(code)
  if (!link) return
  linkStore.set(code, {
    ...link,
    paymentCount: link.paymentCount + 1,
    totalPaidKobo: link.totalPaidKobo + payment.amountKobo,
  })
}

/**
 * `GET /api/dashboard/stats`, computed rather than fixture-returned, so it
 * can never disagree with what a create/verify just did to the store.
 * `activeLinks` uses `resolveLink()` at `now`, matching the README's "not
 * the count of rows with status = 'active'" rule.
 */
export function computeDashboardStats(now: Date = new Date()): DashboardStats {
  let totalCollectedKobo = 0
  let paymentCount = 0
  for (const payments of paymentsByCode.values()) {
    for (const payment of payments) {
      if (payment.status !== 'success') continue
      totalCollectedKobo += payment.amountKobo
      paymentCount += 1
    }
  }

  let activeLinks = 0
  for (const link of linkStore.values()) {
    if (resolveLink(link, now).kind === 'payable') activeLinks += 1
  }

  return { totalCollectedKobo, paymentCount, activeLinks, asOf: now.toISOString() }
}
