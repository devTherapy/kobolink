import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { DashboardStreamProvider } from '@/components/live/DashboardStreamProvider'
import { DashboardHeader } from './DashboardHeader'

/**
 * Route protection's authoritative half (PLAN.md F2 "Done when"). `proxy.ts`
 * already redirected the plainly-signed-out case (no cookie at all) before
 * this ever runs — what lands here is either a genuinely valid session, or a
 * cookie that is present but stale/revoked, which only a real `auth.me`
 * round trip (via `getSession()`) can tell apart from a valid one. Every
 * route under `/dashboard` shares this one check because they all share
 * this layout — no page beneath it re-implements it.
 *
 * It is also where the live stream is mounted (PLAN.md F7): a layout survives
 * navigation between its pages, so the dashboard and a link's page share one
 * connection instead of each opening their own. The layout stays a Server
 * Component; `DashboardStreamProvider` is an island that receives the rendered
 * tree as `children`.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getSession()
  if (!session) {
    // The proxy's own redirect preserves the exact path via `?next=`;
    // this fallback path does not have it (a Server Component layout has no
    // direct read of the current request's pathname) — sending the merchant
    // back to `/dashboard` itself is still a same-origin, ordinary next step
    // rather than a wrong redirect.
    redirect('/login?next=%2Fdashboard')
  }

  return (
    <DashboardStreamProvider>
      <div className="min-h-dvh bg-(--color-ground)">
        <DashboardHeader user={session.user} />
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </div>
    </DashboardStreamProvider>
  )
}
