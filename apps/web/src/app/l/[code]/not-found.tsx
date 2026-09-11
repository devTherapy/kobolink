import Link from 'next/link'
import type { Metadata } from 'next'
import { CheckoutCard, CheckoutShell } from '@/components/checkout/CheckoutCard'

/**
 * Next's file convention for this segment: rendered whenever `page.tsx`
 * (or its `generateMetadata`) calls `notFound()` — a malformed code, or a
 * well-formed one the public endpoint answers `not_found` for. Own
 * metadata, since the page's own `generateMetadata` never resolves a title
 * for a link that does not exist.
 *
 * No explicit `robots` here: Next.js already answers a `notFound()`
 * response with a 404 status and its own `noindex` robots meta tag. Setting
 * one again produced a second, duplicate `<meta name="robots">` in the
 * rendered head — the 404 handling, not this file, owns that tag.
 */
export const metadata: Metadata = {
  title: { absolute: 'Link not found · Kobolink' },
}

export default function LinkNotFound() {
  return (
    <CheckoutShell>
      <CheckoutCard>
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-[23px] font-semibold text-(--color-ink)">Link not found</h1>
          <p className="text-[14px] text-(--color-ink-2)">
            This payment link does not exist, or the code was mistyped. No money has moved.
          </p>
          <Link
            href="/"
            className="mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) px-4 text-[13px] font-medium text-(--color-brand) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
          >
            Go to Kobolink
          </Link>
        </div>
      </CheckoutCard>
    </CheckoutShell>
  )
}
