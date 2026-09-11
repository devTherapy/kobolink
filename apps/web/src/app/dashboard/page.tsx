import type { Metadata } from 'next'
import { getSession } from '@/lib/session'

export const metadata: Metadata = {
  title: 'Dashboard',
}

/**
 * A placeholder — F3 replaces this with the stat strip and links table
 * (PLAN.md). Nothing fake: it greets the signed-in merchant by their real
 * `displayName` from the session `DashboardLayout` already resolved (a
 * second `getSession()` call here is free — `src/lib/session.ts` wraps it in
 * React's `cache()`, so this and the layout share one request instead of
 * paying for `auth.me` twice), and says plainly what is missing rather than
 * inventing numbers or a table with no data behind it.
 */
export default async function DashboardPage() {
  const session = await getSession()
  // `DashboardLayout` already redirects when there is no session — this
  // narrows the type for the render below rather than re-deciding it.
  const displayName = session?.user.displayName ?? 'there'

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[23px] font-semibold text-(--color-ink)">Welcome back, {displayName}.</h1>
      <p className="text-[14px] text-(--color-ink-2)">
        Your links, payment stats and live activity land here in the next build (F3).
      </p>
    </div>
  )
}
