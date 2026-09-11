import { z } from 'zod'
import { PaymentLinkSchema } from './links.js'
import { PaymentSchema } from './payments.js'
import { IsoDateTimeSchema, KoboSchema } from './primitives.js'

/**
 * The stat strip. Read from the API, never computed client-side: the three
 * numbers and the table beneath them must come from the same snapshot or
 * they will disagree on screen.
 */
export const DashboardStatsSchema = z
  .object({
    totalCollectedKobo: KoboSchema,
    paymentCount: z.int().min(0),
    activeLinks: z.int().min(0),
    asOf: IsoDateTimeSchema,
  })
  .meta({ id: 'DashboardStats' })
export type DashboardStats = z.infer<typeof DashboardStatsSchema>

/**
 * Events on `GET /api/stream/dashboard` (Server-Sent Events). Each SSE
 * message has `event: <type>` and a JSON `data:` body matching the variant.
 * `heartbeat` keeps proxies from closing an idle connection; clients ignore
 * it. `id:` carries a monotonic cursor so a reconnecting client can resume
 * with `Last-Event-ID`.
 */
export const DashboardEventSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('heartbeat'), at: IsoDateTimeSchema }),
    z.object({ type: z.literal('payment.completed'), payment: PaymentSchema, stats: DashboardStatsSchema }),
    z.object({ type: z.literal('payment.failed'), payment: PaymentSchema }),
    z.object({ type: z.literal('link.created'), link: PaymentLinkSchema, stats: DashboardStatsSchema }),
    z.object({ type: z.literal('link.updated'), link: PaymentLinkSchema, stats: DashboardStatsSchema }),
  ])
  .meta({ id: 'DashboardEvent' })
export type DashboardEvent = z.infer<typeof DashboardEventSchema>
export type DashboardEventType = DashboardEvent['type']

export const DASHBOARD_EVENT_TYPES = [
  'heartbeat',
  'payment.completed',
  'payment.failed',
  'link.created',
  'link.updated',
] as const satisfies readonly DashboardEventType[]

/** Recommended heartbeat interval; proxies commonly cut idle streams at 30–60s. */
export const SSE_HEARTBEAT_MS = 15_000
