import type { Metadata } from 'next'
import { getSession } from '@/lib/session'
import { loadDashboardData } from '@/lib/dashboard'
import { StatStrip } from '@/components/dashboard/StatStrip'
import { LinksTable } from '@/components/dashboard/LinksTable'

export const metadata: Metadata = {
  title: 'Dashboard',
}

/**
 * A merchant's own numbers must never be served from a cached build — same
 * reasoning as F6's checkout page (`dynamic = 'force-dynamic'`), applied to
 * data that's private instead of public. Reading cookies in
 * `loadDashboardData` already makes Next infer this route as dynamic; this
 * is cheap, explicit insurance against that inference ever changing quietly
 * out from under it.
 */
export const dynamic = 'force-dynamic'

/**
 * The dashboard's home screen (PLAN.md F3, DESIGN-SPEC §4.1): the stat strip
 * and the links table. An async Server Component — `DashboardLayout` above
 * it already redirects a signed-out visitor, so nothing here needs a
 * client-side loading flicker for the common case; `app/dashboard/loading.tsx`
 * is what a merchant sees for the moment this fetch is actually in flight,
 * and `app/dashboard/error.tsx` for the moment it fails.
 *
 * `session` is read again here (not threaded down from the layout) purely
 * for `displayName` — free, since `getSession` wraps `auth.me` in React's
 * `cache()`, so this and the layout share the one request instead of paying
 * for it twice.
 *
 * `getSession()` and `loadDashboardData()` depend on nothing but the
 * incoming request's own cookie — neither result feeds the other — so they
 * run concurrently via `Promise.all` rather than as two sequential `await`s,
 * which would otherwise force `auth.me` to finish before `stats`/`links`
 * even start (`async-parallel`).
 */
export default async function DashboardPage() {
  const [session, { stats, links }] = await Promise.all([getSession(), loadDashboardData()])
  const displayName = session?.user.displayName ?? 'there'

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-[23px] font-semibold text-(--color-ink)">Welcome back, {displayName}.</h1>
      <StatStrip stats={stats} />
      <LinksTable links={links.items} />
    </div>
  )
}
