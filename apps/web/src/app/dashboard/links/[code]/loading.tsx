import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Table } from '@/components/ui/Table'
import { PAYMENTS_TABLE_COLUMNS } from '@/components/dashboard/PaymentsTable'

/**
 * Next's file convention: shown while `page.tsx`'s link and payments fetch is
 * in flight. Shaped like the page it stands in for — back link, title, the
 * QR card with its URL row, the status and details cards, then the payments
 * table's own header with skeleton rows — never a centred spinner (§11).
 *
 * The QR placeholder is the same 192px square the real code renders at, and
 * `PAYMENTS_TABLE_COLUMNS` is the real table's column list, so nothing jumps
 * when the content arrives.
 */
export default function LinkDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton shape="block" height="2.75rem" width="6.5rem" aria-label="Loading navigation" />

      <div className="flex flex-col gap-2">
        <Skeleton shape="line" width="16rem" aria-label="Loading link title" />
        <Skeleton shape="line" width="24rem" className="max-w-full" aria-label="Loading link description" />
      </div>

      <div className="grid items-start gap-6 md:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <Skeleton shape="line" width="8rem" aria-label="Loading share section" />
          <div className="flex justify-center">
            <Skeleton shape="block" width="12rem" height="12rem" aria-label="Loading QR code" />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Skeleton shape="block" height="2.75rem" aria-label="Loading link URL" />
            <Skeleton shape="block" height="2.75rem" width="7rem" aria-label="Loading copy button" />
          </div>
        </Card>

        <div className="flex flex-col gap-6">
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <Skeleton shape="line" width="5rem" aria-label="Loading status" />
              <Skeleton shape="block" width="4rem" height="1.5rem" aria-label="Loading status badge" />
            </div>
            <Skeleton shape="block" width="12rem" height="2.75rem" aria-label="Loading status switch" />
            <Skeleton shape="line" width="90%" aria-label="Loading status help" />
          </Card>
          <Card className="flex flex-col gap-3">
            <Skeleton shape="line" width="5rem" aria-label="Loading details" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {Array.from({ length: 6 }, (_unused, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <Skeleton shape="line" width="50%" aria-label="Loading detail label" />
                  <Skeleton shape="line" width="70%" aria-label="Loading detail value" />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card padding="none">
        <div className="px-4 pt-4 pb-2">
          <Skeleton shape="line" width="6rem" aria-label="Loading payments heading" />
        </div>
        <Table
          columns={PAYMENTS_TABLE_COLUMNS}
          rows={[]}
          rowKey={(payment) => payment.reference}
          emptyState={null}
          loading
          loadingRowCount={4}
        />
      </Card>
    </div>
  )
}
