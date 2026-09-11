'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'

function noopSubscribe(): () => void {
  return () => undefined
}

/**
 * True once React has hydrated on the client, false on the server and on
 * the client's first render (which must match the server's output).
 * `useSyncExternalStore`'s two snapshot arguments give React itself the
 * server/client split — no Effect, no `setState` call to trigger it, so
 * this can't be the "cascading render" `react-hooks/set-state-in-effect`
 * flags on the equivalent `useEffect(() => setMounted(true), [])` pattern.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
}

/**
 * Starts the MSW browser worker when `NEXT_PUBLIC_API_MOCKING=enabled` — the
 * escape hatch that lets `npm run dev` run the web app against
 * `packages/contracts` fixtures with no `apps/api` process running. Unset
 * the flag (the default) to talk to the real API via the `next.config.ts`
 * rewrite; that rewrite, and the real API, are what the browser reaches
 * either way — MSW's worker only ever intercepts requests already inside
 * the browser (it is a Service Worker), never the server render itself.
 *
 * Server render, and the first client render before hydration settles,
 * always show `children` — gating them there would blank out SSR content
 * that must ship in the initial HTML regardless of mocking (F6's Open Graph
 * title, for one). Only *after* hydrating do we hold `children` back, and
 * only while mocking is enabled and its worker isn't ready yet, so an early
 * client-side fetch can't race an unstarted worker.
 */
export function MswProvider({ children }: { children: React.ReactNode }) {
  const enabled = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
  const hydrated = useHydrated()
  const [workerReady, setWorkerReady] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    void import('./browser')
      .then(({ worker }) => worker.start({ onUnhandledRequest: 'bypass' }))
      .then(() => {
        if (!cancelled) setWorkerReady(true)
      })
      .catch((error: unknown) => {
        // The worker failed to install (unsupported browser, blocked
        // service worker, missing public/mockServiceWorker.js). Render
        // anyway — requests will hit the real network and fail there
        // instead of leaving the page blank forever.
        console.error('MSW worker failed to start; falling back to the real network.', error)
        if (!cancelled) setWorkerReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  const holdForWorker = hydrated && enabled && !workerReady
  if (holdForWorker) return null
  return children
}
