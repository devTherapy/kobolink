import type { PaymentLink, PublicLink, PublicLinkState } from './links.js'

/** The fields resolution needs. Both the merchant and the public view carry them. */
export type ResolvableLink = Pick<PublicLink, 'isReusable' | 'expiresAt'> & {
  status: PaymentLink['status']
  paymentCount: number
}

export type LinkResolution<L extends ResolvableLink = PaymentLink> =
  | { kind: 'not-found' }
  | { kind: 'disabled'; link: L }
  | { kind: 'expired'; link: L; expiredAt: string }
  | { kind: 'already-paid'; link: L }
  | { kind: 'payable'; link: L }

/**
 * The single source of truth for "can this link be paid right now".
 *
 * The API answers this for `GET /api/links/:code/public`, the web checkout
 * renders from the answer, and both mobile apps do the same — so a link the
 * website refuses can never be payable in the app. Keeping it as one pure
 * function of (link, now) is what makes that testable.
 */
export function resolveLink<L extends ResolvableLink>(
  link: L | null,
  now: Date = new Date(),
): LinkResolution<L> {
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

/** The wire form of a resolution: the state the public endpoint returns. */
export function toPublicLinkState(resolution: LinkResolution<ResolvableLink>): PublicLinkState | null {
  switch (resolution.kind) {
    case 'not-found':
      return null
    case 'disabled':
    case 'expired':
    case 'already-paid':
    case 'payable':
      return resolution.kind
  }
}

/** The badge a merchant sees in the dashboard, which folds expiry into status. */
export function displayStatus(
  link: ResolvableLink,
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
    case 'payable':
    case 'not-found':
      return 'Active'
  }
}
