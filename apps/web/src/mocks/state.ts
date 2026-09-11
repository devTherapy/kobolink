import { exampleLink, exampleWallet, type PaymentLink } from '@kobolink/contracts'

/**
 * The MSW handler set's in-memory backend. A payment-link mock that always
 * answers from a fresh fixture cannot model "create it, then disable it,
 * then resolve it" — the exact sequence F4/F5/F6 screens exercise — so the
 * handlers share this store instead. Money-moving handlers (`checkout.*`,
 * `wallet.*`) read and write it too, which is what makes the simulated
 * decline, the idempotency replay, and the overdraft rejection possible.
 *
 * Test-only state: `resetMockState()` runs in `src/test/setup.ts`'s
 * `afterEach`, alongside `server.resetHandlers()`, so one test's writes never
 * leak into the next.
 */

export const INITIAL_WALLET_BALANCE_KOBO = 12_500_000

export const linkStore = new Map<string, PaymentLink>()

export interface CheckoutSession {
  code: string
  amountKobo: number
  payerName: string
  payerEmail: string
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

function seedLinkStore(): void {
  const seed = exampleLink()
  linkStore.set(seed.code, seed)
}

export function resetMockState(): void {
  linkStore.clear()
  seedLinkStore()
  checkoutSessions.clear()
  idempotencyStore.clear()
  walletState.balanceKobo = INITIAL_WALLET_BALANCE_KOBO
}

// Seed once at module load too, so a handler used outside the Vitest
// lifecycle (e.g. the browser worker in `npm run dev`) still has data.
seedLinkStore()

export function walletFixture() {
  return exampleWallet({ balanceKobo: walletState.balanceKobo })
}
