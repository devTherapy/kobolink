import { useMemo } from 'react'
import type { PaymentLink } from '@kobolink/contracts'
import { liveLinkOverride } from '@/lib/live-dashboard'
import { useDashboardStream } from './DashboardStreamProvider'

/**
 * `rendered` unless the stream has delivered a newer `link.created` /
 * `link.updated` for the same code, in which case that whole link. `asOf` is
 * when the server render's reads finished (`LinkDetailData.asOf`); omit it and
 * every event for the code counts as newer.
 *
 * Generic over the rendered shape so a caller that was handed only part of a
 * link (`LinkStatusControl`'s `Pick`) gets that part back — the override is a
 * full `PaymentLink`, which satisfies any such `Pick`.
 */
export function useLiveLink<T extends Pick<PaymentLink, 'code'>>(rendered: T, asOf?: string): T {
  const { events } = useDashboardStream()
  const code = rendered.code
  const override = useMemo(() => liveLinkOverride(code, asOf, events), [code, asOf, events])
  return (override as T | null) ?? rendered
}
