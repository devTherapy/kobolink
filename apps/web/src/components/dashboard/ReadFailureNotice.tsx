import type { ReactElement } from 'react'
import { MerchantAccessError, UnexpectedResponseError } from '@/lib/read-failure'

/**
 * The two failures of a dashboard read that a retry cannot fix, rendered by the
 * page itself — not by `error.tsx` — because a thrown Server Component error
 * reaches that boundary stripped of its name and message in production (see
 * `classifyReadFailure`). Plain server markup, no client island: nothing here
 * is interactive beyond a link, so there is no hover/loading/error state of
 * its own to ship beyond the link's.
 *
 * Both are *read* screens, so both say that nothing was changed.
 */

const LINK_CLASSES =
  'mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) bg-(--color-brand) px-5 text-[14px] font-semibold text-white hover:bg-(--color-brand-hover) active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)'

/**
 * A signed-in customer account. No retry and no sign-in link — `/login` sends a
 * signed-in visitor straight back to the dashboard — so the next step is the
 * "Log out" the layout's header always carries.
 */
export function MerchantAccessNotice() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-[23px] font-semibold text-(--color-ink)">This account can&apos;t use the merchant dashboard</h1>
      <p className="max-w-sm text-[14px] text-(--color-ink-2)">
        You&apos;re signed in with a customer account, and only merchant accounts can see links and payments. Nothing
        was changed. To continue, use Log out at the top of the page, then sign in with your merchant account.
      </p>
    </div>
  )
}

/**
 * Kobolink answered, but not in a shape this app can read — our fault, not the
 * visitor's and not their connection. A reload is offered because it can help
 * when the app and the server were mid-deploy; it is a plain link (a full
 * navigation re-runs the page's fetch), not a button that pretends to retry.
 */
export function UnexpectedResponseNotice({ subject, reloadHref }: { subject: string; reloadHref: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-[23px] font-semibold text-(--color-ink)">Kobolink sent back something unexpected</h1>
      <p className="max-w-sm text-[14px] text-(--color-ink-2)">
        We reached Kobolink, but its answer for {subject} wasn&apos;t in a form we could read. That&apos;s a fault on our
        side, not something you did. Nothing was changed, and your links and payments are unaffected. Reloading may
        fix it; if it keeps happening, try again later.
      </p>
      {/* A full document navigation on purpose: `next/link` would reuse the cached failed render. */}
      <a href={reloadHref} className={LINK_CLASSES}>
        Reload
      </a>
    </div>
  )
}

/**
 * The page-side half of `classifyReadFailure`: the notice for an error of one
 * of its two non-retryable classes, or `null` for anything else — which the
 * caller must rethrow so `error.tsx` (or a redirect) handles it.
 */
export function noticeForReadFailure(
  error: unknown,
  { subject, reloadHref }: { subject: string; reloadHref: string },
): ReactElement | null {
  if (error instanceof MerchantAccessError) return <MerchantAccessNotice />
  if (error instanceof UnexpectedResponseError) return <UnexpectedResponseNotice subject={subject} reloadHref={reloadHref} />
  return null
}
