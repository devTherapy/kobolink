import { formatNaira, type DashboardStats } from '@kobolink/contracts'
import { Card } from '@/components/ui/Card'

/**
 * The dashboard's stat row (DESIGN-SPEC §4.1): total collected, payment
 * count, active links. Read verbatim from `DashboardStats` — never computed
 * client-side from the links list — so this and `LinksTable` beneath it can
 * never disagree about the same snapshot (see `DashboardStatsSchema`'s own
 * doc comment in `packages/contracts`).
 *
 * A plain function component: nothing here needs a hook or an event handler,
 * so it renders as part of `DashboardPage`'s server-side HTML with no client
 * JS of its own — same reasoning as `NonPayableScreen`.
 *
 * Non-interactive, like `Card`/`Pill`: no hover/focus/active/disabled state
 * of its own. Its one loading state lives one level up, in `app/dashboard/
 * loading.tsx`, which renders its own skeleton shaped like this same grid
 * rather than this component growing a `loading` prop for a state it is
 * never actually mounted during.
 */
export function StatStrip({ stats }: { stats: DashboardStats }) {
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard label="Total collected" value={formatNaira(stats.totalCollectedKobo)} />
      <StatCard label="Payments" value={stats.paymentCount.toLocaleString('en-NG')} />
      <StatCard label="Active links" value={stats.activeLinks.toLocaleString('en-NG')} />
    </dl>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  // A `<div>` grouping one `dt`/`dd` pair inside `dl` — valid HTML5 (`dl`'s
  // content model allows `div` wrappers around `dt`+`dd` groups), and what
  // lets each stat be its own bordered `Card` instead of three cards forced
  // to share one flat `dl`.
  return (
    <Card as="div" className="flex flex-col gap-1">
      <dt className="text-[13px] font-medium text-(--color-ink-3)">{label}</dt>
      <dd className="tabular text-[26px] font-semibold text-(--color-ink)">{value}</dd>
    </Card>
  )
}
