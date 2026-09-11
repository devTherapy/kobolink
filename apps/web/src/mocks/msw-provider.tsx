'use client'

import { useEffect, useState } from 'react'

/**
 * Starts the MSW browser worker before rendering children, only when
 * `NEXT_PUBLIC_API_MOCKING=enabled` — the escape hatch that lets `npm run
 * dev` run the web app against `packages/contracts` fixtures with no
 * `apps/api` process running. Unset the flag (the default) to talk to the
 * real API via the `next.config.ts` rewrite.
 */
export function MswProvider({ children }: { children: React.ReactNode }) {
  const enabled = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
  const [ready, setReady] = useState(!enabled)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void import('./browser').then(({ worker }) =>
      worker.start({ onUnhandledRequest: 'bypass' }).then(() => {
        if (!cancelled) setReady(true)
      }),
    )
    return () => {
      cancelled = true
    }
  }, [enabled])

  if (!ready) return null
  return children
}
