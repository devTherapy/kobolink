import { displayStatus, formatNaira, type PaymentLink } from '@kobolink/contracts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusPill } from '@/components/ui/Pill'
import { Table, type TableColumn } from '@/components/ui/Table'
import { formatShortDate } from '@/lib/format'
import { LinkIcon } from './icons'

/**
 * Exported so `app/dashboard/loading.tsx` can render `Table`'s own skeleton
 * rows against the exact same column set (header text, count, alignment)
 * instead of a second, hand-maintained list that could drift from this one.
 *
 * DESIGN-SPEC §4.1: "title, amount, status, payment count, created date."
 * `code` doubles as `rowKey` — the merchant's own primary key for a link,
 * not shown as its own column here (F5's link detail is where the code and
 * its share URL live).
 */
export const LINKS_TABLE_COLUMNS: TableColumn<PaymentLink>[] = [
  {
    key: 'link',
    header: 'Link',
    render: (link) => (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium text-(--color-ink)">{link.title}</span>
        {link.description ? (
          <span className="truncate text-[13px] text-(--color-ink-3)">{link.description}</span>
        ) : null}
      </div>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    numeric: true,
    // `null` means the payer chooses the amount at checkout (CreateLinkRequestSchema) — said in words, never rendered as ₦0.
    render: (link) => (link.amountKobo === null ? 'Any amount' : formatNaira(link.amountKobo)),
  },
  {
    key: 'status',
    header: 'Status',
    // `displayStatus` folds expiry/exhaustion into the badge a merchant
    // sees — the same derived status `resolveLink()` answers everywhere
    // else, never a raw `status` column that could disagree with it.
    render: (link) => <StatusPill status={displayStatus(link)} />,
  },
  {
    key: 'payments',
    header: 'Payments',
    align: 'right',
    numeric: true,
    render: (link) => link.paymentCount.toLocaleString('en-NG'),
  },
  {
    key: 'created',
    header: 'Created',
    render: (link) => formatShortDate(link.createdAt),
  },
]

/**
 * The dashboard's links table (DESIGN-SPEC §4.1). A plain Server Component —
 * nothing here is interactive yet: `onRowClick` is left unset rather than
 * navigating to `/dashboard/links/[code]`, a route F5 builds. Wiring a click
 * to a page that does not exist yet would be a dead link with today's
 * changes, not a working feature.
 */
export function LinksTable({ links }: { links: PaymentLink[] }) {
  return (
    <Card padding="none">
      <Table
        columns={LINKS_TABLE_COLUMNS}
        rows={links}
        rowKey={(link) => link.code}
        emptyState={
          <EmptyState
            as="h3"
            icon={<LinkIcon />}
            title="No links yet"
            body="Once you create a payment link, it will show up here with its status and payment count."
          />
        }
      />
    </Card>
  )
}
