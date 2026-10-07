import Link from 'next/link'
import type { User } from '@kobolink/contracts'
import { LogoutButton } from '@/components/auth/LogoutButton'
import { ConnectionStatus } from '@/components/live/ConnectionStatus'

/**
 * The authenticated area's header/nav shell. A plain Server Component — the
 * merchant's name comes from the session `DashboardLayout` already resolved
 * (one `getSession()` call for the whole route segment, not a second
 * client-side fetch just to fill in a name in the corner — see
 * `LogoutButton`'s own doc comment for the one place this route segment
 * does need a real client call). `LogoutButton` is the only interactive
 * piece, and it carries its own `"use client"` boundary. `ConnectionStatus`
 * (F7) is a client island too, but display-only: it reads the live stream's
 * state from the provider `DashboardLayout` mounts around this header.
 */
export function DashboardHeader({ user }: { user: User }) {
  return (
    <header className="border-b border-(--color-border) bg-(--color-surface)">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/dashboard" className="text-[16px] font-semibold text-(--color-ink)">
          Kobolink
        </Link>
        <div className="flex min-w-0 items-center gap-3">
          <ConnectionStatus />
          <p className="hidden text-[14px] text-(--color-ink-2) sm:block">{user.displayName}</p>
          <LogoutButton />
        </div>
      </div>
    </header>
  )
}
