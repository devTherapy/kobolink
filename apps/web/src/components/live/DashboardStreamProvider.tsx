'use client'

import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { openDashboardStream, type LiveEvent, type StreamStatus } from '@/lib/dashboard-stream'
import { eventKey } from '@/lib/live-dashboard'

/** Events kept for the screens to lay over their server render. A refresh follows each one, so this only has to bridge a moment. */
const MAX_EVENTS = 50
const MAX_SEEN = 500
/** Several events in a burst cost one re-render of the server tree, not one each. */
export const REFRESH_DEBOUNCE_MS = 300

export interface DashboardStreamValue {
  status: StreamStatus
  /** Oldest first. De-duplicated: a payment reference appears once per outcome. */
  events: readonly LiveEvent[]
}

const NO_EVENTS: readonly LiveEvent[] = []

/**
 * Outside a provider (a page rendered on its own in a test, or `renderToStaticMarkup`)
 * there is no stream and nothing to lay over the server render — the screens just
 * show what they were given.
 */
const DashboardStreamContext = createContext<DashboardStreamValue>({ status: 'connecting', events: NO_EVENTS })

export function useDashboardStream(): DashboardStreamValue {
  return useContext(DashboardStreamContext)
}

/**
 * The one `EventSource` for everything under `/dashboard` (PLAN.md F7), mounted by
 * `DashboardLayout`. A layout survives navigation between its pages, so moving from
 * the dashboard to a link and back keeps the same connection instead of closing and
 * reopening one per screen. The layout itself stays a Server Component; this island
 * takes the already-rendered tree as `children`.
 *
 * It does three things and keeps the rest out of the tree's way:
 *
 * 1. **Holds the connection.** Status and the (de-duplicated) event log go into
 *    context. Heartbeats never reach React — they only feed the connection's watchdog.
 * 2. **Reconciles with the server.** Every event, and every reconnect after a gap,
 *    schedules `router.refresh()`. The event shows the change immediately; the refresh
 *    makes it true (see `lib/live-dashboard.ts`). The refresh runs in a transition so the
 *    page stays put instead of blanking into `loading.tsx`.
 * 3. **Cleans up.** Unmounting closes the stream and cancels a pending refresh.
 *
 * The context value is memoised on (status, events), so the many components that read
 * it re-render when something actually changed — not on every heartbeat.
 */
export function DashboardStreamProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [events, setEvents] = useState<readonly LiveEvent[]>(NO_EVENTS)
  const seen = useRef(new Set<string>())

  // Reads the current `router` without making it a dependency: the stream must outlive a
  // re-render, and only an unmount may close it.
  const refresh = useEffectEvent(() => {
    startTransition(() => {
      router.refresh()
    })
  })

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = (delayMs: number): void => {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(refresh, delayMs)
    }

    const stream = openDashboardStream({
      onStatus: setStatus,
      onEvent: (event) => {
        const key = eventKey(event)
        if (key !== null) {
          // The same payment must never be counted twice, whatever delivers it.
          if (seen.current.has(key)) return
          seen.current.add(key)
          // A set of strings, but a tab left open for weeks should not grow it forever.
          if (seen.current.size > MAX_SEEN) {
            const [oldest] = seen.current
            if (oldest !== undefined) seen.current.delete(oldest)
          }
        }
        setEvents((previous) => [...previous, event].slice(-MAX_EVENTS))
        scheduleRefresh(REFRESH_DEBOUNCE_MS)
      },
      onResync: () => {
        scheduleRefresh(0)
      },
    })

    return () => {
      clearTimeout(refreshTimer)
      stream.close()
    }
  }, [])

  const value = useMemo(() => ({ status, events }), [status, events])
  return <DashboardStreamContext value={value}>{children}</DashboardStreamContext>
}
