/**
 * Deterministic example values for every response shape. The web app's MSW
 * handlers, the API's tests and the mobile previews build from these so that
 * a fixture drifting from the contract is a type error here, not a surprise
 * in someone else's test.
 */
import type { DashboardStats } from './dashboard.js'
import type { PaymentLink, PublicLink, PublicLinkResponse } from './links.js'
import type { Payment } from './payments.js'
import type { User } from './users.js'
import type { Wallet } from './wallet.js'

export const FIXTURE_NOW = '2026-06-15T12:00:00.000Z' as const

export function exampleUser(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_2Hh9kq3mV1',
    role: 'merchant',
    email: 'adebayo@example.com',
    phone: '+2348031234567',
    displayName: 'Adebayo Stores',
    createdAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  }
}

export function exampleLink(overrides: Partial<PaymentLink> = {}): PaymentLink {
  return {
    code: 'aBcDeFgH',
    merchantId: 'usr_2Hh9kq3mV1',
    merchantName: 'Adebayo Stores',
    title: 'Ankara Two-Piece Set',
    description: 'Size 12, ships within Lagos in 2 days.',
    amountKobo: 1_850_000,
    currency: 'NGN',
    status: 'active',
    isReusable: true,
    expiresAt: null,
    createdAt: '2026-06-02T09:00:00.000Z',
    paymentCount: 3,
    totalPaidKobo: 5_550_000,
    ...overrides,
  }
}

export function toPublicLink(link: PaymentLink): PublicLink {
  return {
    code: link.code,
    merchantName: link.merchantName,
    title: link.title,
    description: link.description,
    amountKobo: link.amountKobo,
    currency: link.currency,
    isReusable: link.isReusable,
    expiresAt: link.expiresAt,
  }
}

export function examplePublicLinkResponse(
  overrides: Partial<PublicLinkResponse> = {},
): PublicLinkResponse {
  return { state: 'payable', link: toPublicLink(exampleLink()), ...overrides }
}

export function examplePayment(overrides: Partial<Payment> = {}): Payment {
  const merged: Payment = {
    reference: 'kbl_7hK2mN9pQr',
    code: 'aBcDeFgH',
    amountKobo: 1_850_000,
    currency: 'NGN',
    status: 'success',
    payerName: 'Ngozi Okafor',
    payerEmail: 'n***@example.com',
    createdAt: '2026-06-14T18:20:00.000Z',
    completedAt: '2026-06-14T18:20:04.000Z',
    failureReason: null,
    moneyMoved: true,
    ...overrides,
  }
  // Keep the invariant unless the caller is deliberately breaking it.
  if (overrides.moneyMoved === undefined) merged.moneyMoved = merged.status === 'success'
  return merged
}

export function exampleStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    totalCollectedKobo: 5_550_000,
    paymentCount: 3,
    activeLinks: 1,
    asOf: FIXTURE_NOW,
    ...overrides,
  }
}

export function exampleWallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    accountId: 'acc_9mQ2xV7kLp',
    currency: 'NGN',
    balanceKobo: 12_500_000,
    asOf: FIXTURE_NOW,
    ...overrides,
  }
}
