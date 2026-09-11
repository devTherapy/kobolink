'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { client } from '@/lib/api'
import { Button } from '@/components/ui/Button'

/**
 * A plain client call, not a Server Action: `client.auth.logout()` runs as a
 * genuine browser `fetch` to the same-origin `/api/*` rewrite, so it carries
 * the httpOnly session cookie and receives the API's clearing `Set-Cookie`
 * exactly the way any other same-origin request does — no manual cookie
 * plumbing needed the way `getSession` needs on the server, where there is
 * no browser cookie jar to rely on.
 *
 * Best-effort: even if the network call fails, there is nothing useful left
 * to do with a session the merchant explicitly asked to end other than send
 * them to `/login` anyway — staying on the dashboard with a logout button
 * that silently did nothing is the worse failure mode.
 */
export function LogoutButton() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)

  async function handleLogout() {
    setIsLoading(true)
    try {
      await client.auth.logout()
    } catch (error) {
      // Best-effort — see the doc comment above. Logged, not surfaced: the
      // merchant is being sent to `/login` regardless, and a banner here
      // would just be noise on the way out the door.
      console.error(error)
    } finally {
      router.replace('/login')
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      surface="surface"
      status={isLoading ? 'loading' : 'idle'}
      onClick={() => void handleLogout()}
    >
      Log out
    </Button>
  )
}
