import { formatNaira, type Payment, type PaymentStatus } from '@kobolink/contracts'
import { StatusPill, type PillStatus } from '@/components/ui/Pill'
import type { TableColumn } from '@/components/ui/Table'
import { formatDateTime } from '@/lib/format'

/**
 * Payment states get the payment vocabulary of `Pill` — `Paid` / `Pending` /
 * `Failed` — not the wire enum's `success`. (A *link* that has been paid is
 * also `Paid`; the two never share a row, so the word is unambiguous here.)
 */
const PILL_FOR_PAYMENT: Record<PaymentStatus, PillStatus> = {
  success: 'Paid',
  pending: 'Pending',
  failed: 'Failed',
}

/**
 * Exported so `app/dashboard/links/[code]/loading.tsx` renders the skeleton
 * against the same headers and column count, the way `LINKS_TABLE_COLUMNS`
 * does for the dashboard — a second hand-kept list would drift.
 *
 * Every row says whether money moved: a failed or pending payment names
 * "No money moved" beneath its badge (§11: failure states say whether money
 * moved), and `failureReason` is the API's own words for what went wrong.
 * `payerEmail` arrives already masked by the API (`maskEmail`) — it is shown
 * as given, never reconstructed.
 */
export const PAYMENTS_TABLE_COLUMNS: TableColumn<Payment>[] = [
  {
    key: 'payer',
    header: 'Payer',
    render: (payment) => (
      <div className="flex min-w-0 max-w-[16rem] flex-col gap-0.5">
        <span className="truncate font-medium text-(--color-ink)">{payment.payerName}</span>
        <span className="truncate text-[13px] text-(--color-ink-3)">{payment.payerEmail}</span>
      </div>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    numeric: true,
    render: (payment) => formatNaira(payment.amountKobo),
  },
  {
    key: 'status',
    header: 'Status',
    render: (payment) => (
      <div className="flex flex-col items-start gap-1">
        <StatusPill status={PILL_FOR_PAYMENT[payment.status]} />
        {payment.moneyMoved ? null : (
          // A floor on the width, or in a narrow column the sentence wraps to a word per line.
          <span className="min-w-36 max-w-56 text-[13px] text-(--color-ink-3)">
            {payment.failureReason ? `${payment.failureReason} ` : null}No money moved.
          </span>
        )}
      </div>
    ),
  },
  {
    key: 'date',
    header: 'Date',
    render: (payment) => (
      <div className="flex flex-col gap-0.5">
        <span className="whitespace-nowrap">{formatDateTime(payment.createdAt)}</span>
        <span className="font-mono text-[12px] text-(--color-ink-3)">{payment.reference}</span>
      </div>
    ),
  },
]
