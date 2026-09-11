import Link from 'next/link'

/**
 * Placeholder home. The real merchant surface is `/dashboard` (F2/F3); this
 * page exists so the app has an honest root route before that lands — no
 * marketing copy that isn't true yet.
 */
export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-[26px] font-semibold text-(--color-ink)">Kobolink</h1>
      <p className="max-w-sm text-[14px] text-(--color-ink-2)">
        Payment links for Nigerian merchants. Create a link, share it, get paid.
      </p>
      <Link
        href="/dashboard"
        className="inline-flex min-h-11 items-center justify-center rounded-(--radius-input) bg-(--color-brand) px-5 text-[14px] font-medium text-white hover:bg-(--color-brand-hover) focus-visible:outline-2 focus-visible:outline-(--color-brand)"
      >
        Go to Dashboard
      </Link>
    </main>
  )
}
