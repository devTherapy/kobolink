import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { sameOriginPath } from '@/lib/next-path'
import { AuthShell } from '@/components/auth/AuthShell'
import { RegisterForm } from '@/components/auth/RegisterForm'

export const metadata: Metadata = {
  title: 'Create an account',
}

/** `/register` — the server shell around `RegisterForm`'s client island. See `/login/page.tsx` for the split this mirrors. */
interface PageProps {
  searchParams: Promise<{ next?: string }>
}

export default async function RegisterPage({ searchParams }: PageProps) {
  const { next: rawNext } = await searchParams
  const next = sameOriginPath(rawNext)

  const session = await getSession()
  if (session) redirect(next ?? '/dashboard')

  return (
    <AuthShell title="Create an account" subtitle="Start collecting payments in minutes.">
      <RegisterForm next={next} />
    </AuthShell>
  )
}
