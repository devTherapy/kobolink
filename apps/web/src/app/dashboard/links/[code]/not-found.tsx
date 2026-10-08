import Link from 'next/link'

/**
 * Rendered whenever `page.tsx` calls `notFound()`: a code that is malformed,
 * unknown, or belongs to another merchant. The API answers all three with the
 * same 404 on purpose, so this screen must not hint at which one it was —
 * "doesn't exist or isn't on your account" is the whole truth it can tell.
 *
 * Inside `DashboardLayout`, so the merchant keeps the header and a way out.
 */
export default function LinkNotFound() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-[23px] font-semibold text-(--color-ink)">We couldn&apos;t find that link</h1>
      <p className="max-w-sm text-[14px] text-(--color-ink-2)">
        It doesn&apos;t exist, or it isn&apos;t on your account. Check the address, or pick a link from your list.
        Nothing has been changed.
      </p>
      <Link
        href="/dashboard"
        className="mt-2 inline-flex min-h-11 items-center justify-center rounded-(--radius-input) bg-(--color-brand) px-5 text-[14px] font-semibold text-white hover:bg-(--color-brand-hover) active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
      >
        Back to all links
      </Link>
    </div>
  )
}
