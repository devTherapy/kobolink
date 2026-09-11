import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { DashboardHeader } from './DashboardHeader'

/**
 * Route protection's authoritative half (PLAN.md F2 "Done when"). `middleware.ts`
 * already redirected the plainly-signed-out case (no cookie at all) before
 * this ever runs — what lands here is either a genuinely valid session, or a
 * cookie that is present but stale/revoked, which only a real `auth.me`
 * round trip (via `getSession()`) can tell apart from a valid one. Every
 * route under `/dashboard` shares this one check because they all share
 * this layout — no page beneath it re-implements it.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getSession()
  if (!session) {
    // The middleware's own redirect preserves the exact path via `?next=`;
    // this fallback path does not have it (a Server Component layout has no
    // direct read of the current request's pathname) — sending the merchant
    // back to `/dashboard` itself is still a same-origin, ordinary next step
    // rather than a wrong redirect.
    redirect('/login?next=%2Fdashboard')
  }

  return (
    <div className="min-h-dvh bg-(--color-ground)">
      <DashboardHeader user={session.user} />
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  )
}
