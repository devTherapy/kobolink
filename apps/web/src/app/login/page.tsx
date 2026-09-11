import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { sameOriginPath } from '@/lib/next-path'
import { AuthShell } from '@/components/auth/AuthShell'
import { LoginForm } from '@/components/auth/LoginForm'

export const metadata: Metadata = {
  title: 'Sign in',
}

/**
 * `/login` — DESIGN-SPEC §4: "a form and a redirect, not a page with a
 * design." An async **Server Component** shell around `LoginForm`'s one
 * client island, the same split F6's `/l/[code]` uses — this page has no
 * Open Graph card to protect, but there is still no reason to ship the
 * static heading and shell as client JS.
 *
 * `searchParams` is a `Promise` in this Next.js major version, same as
 * `/l/[code]`'s `params` (see that page's own doc comment).
 */
interface PageProps {
  searchParams: Promise<{ next?: string }>
}

export default async function LoginPage({ searchParams }: PageProps) {
  const { next: rawNext } = await searchParams
  const next = sameOriginPath(rawNext)

  // Already signed in: `/login` has nothing left to do for this visitor.
  // Read via `getSession()`, same authoritative call the dashboard layout
  // makes — a stale cookie here just means this check is a no-op, not a
  // wrong redirect, since `getSession()` fails closed.
  const session = await getSession()
  if (session) redirect(next ?? '/dashboard')

  return (
    <AuthShell title="Sign in" subtitle="Collect payments with Kobolink.">
      <LoginForm next={next} />
    </AuthShell>
  )
}
