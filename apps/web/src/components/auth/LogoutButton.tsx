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
 * Not best-effort: navigating to `/login` after a *failed* logout used to be
 * the plan, but it backfires. `/login` itself calls `getSession()`, and a
 * failed request means the API never cleared the cookie — so `getSession()`
 * finds it still valid and immediately redirects back to `/dashboard`. Net
 * result was a flash of `/login` and the merchant silently still signed in,
 * with no indication anything went wrong. So: only navigate once
 * `client.auth.logout()` has actually resolved. A failure shows `Button`'s
 * own `status="error"` state instead and leaves the merchant on the
 * dashboard, able to retry.
 */
export function LogoutButton() {
  const router = useRouter()
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  async function handleLogout() {
    setStatus('loading')
    try {
      await client.auth.logout()
      // Bust the dashboard route segment's client-side cache *before*
      // leaving it — `router.refresh()` targets the current route, so this
      // has to run while `/dashboard` is still current. Otherwise a browser
      // Back after logout could serve the cached (still-authenticated-looking)
      // dashboard from the router cache instead of hitting `DashboardLayout`'s
      // `getSession()` guard again.
      router.refresh()
      router.replace('/login')
      // Deliberately no `setStatus('idle')` on the success path — this
      // component is about to be unmounted by the navigation above.
    } catch (error) {
      console.error(error)
      setStatus('error')
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      surface="surface"
      status={status}
      errorMessage="Logout failed. Check your connection and try again."
      onClick={() => void handleLogout()}
    >
      Log out
    </Button>
  )
}
