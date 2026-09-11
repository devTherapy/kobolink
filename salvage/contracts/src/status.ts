import type { LinkResolution, PaymentLink } from '@/types'

/**
 * The single source of truth for "can this link be paid right now".
 *
 * Both the web checkout page and the mobile apps answer this question, and
 * they must agree — a link the website refuses must not be payable in the app.
 * Keeping it as one pure function of (link, now) is what makes that testable.
 */
export function resolveLink(
  link: PaymentLink | null,
  now: Date = new Date(),
): LinkResolution {
  if (!link) return { kind: 'not-found' }
  if (link.status === 'disabled') return { kind: 'disabled', link }

  if (link.expiresAt) {
    const expiry = new Date(link.expiresAt)
    if (Number.isFinite(expiry.getTime()) && expiry.getTime() <= now.getTime()) {
      return { kind: 'expired', link, expiredAt: link.expiresAt }
    }
  }

  if (!link.isReusable && link.paymentCount > 0) {
    return { kind: 'already-paid', link }
  }

  return { kind: 'payable', link }
}

/** The badge a merchant sees in the dashboard, which folds expiry into status. */
export function displayStatus(
  link: PaymentLink,
  now: Date = new Date(),
): 'Active' | 'Disabled' | 'Expired' | 'Paid' {
  const resolution = resolveLink(link, now)
  switch (resolution.kind) {
    case 'disabled':
      return 'Disabled'
    case 'expired':
      return 'Expired'
    case 'already-paid':
      return 'Paid'
    default:
      return 'Active'
  }
}
