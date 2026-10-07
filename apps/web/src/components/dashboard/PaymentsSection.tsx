'use client'

import { useState } from 'react'
import type { Payment } from '@kobolink/contracts'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table } from '@/components/ui/Table'
import { client } from '@/lib/api'
import { CoinsIcon } from './icons'
import { PAYMENTS_TABLE_COLUMNS } from './PaymentsTable'

/** One page; the API default is 20 too, but a cursor request must say it (`PageQuery.limit` is required once parsed). */
const PAGE_SIZE = 20

export interface PaymentsSectionProps {
  code: string
  /** The server-rendered first page. */
  initialPayments: Payment[]
  initialCursor: string | null
}

/** Append `incoming` to `existing`, dropping any `reference` already shown. */
function appendUnique(existing: Payment[], incoming: Payment[]): Payment[] {
  const seen = new Set(existing.map((payment) => payment.reference))
  return [...existing, ...incoming.filter((payment) => !seen.has(payment.reference))]
}

/**
 * The link's payments (DESIGN-SPEC §4.2), newest first. The first page is
 * rendered on the server by the page — present in the HTML before any JS —
 * and this island only owns what happens *after* it: "Show more", which
 * follows `nextCursor` and appends.
 *
 * The cursor is opaque and owned by the API; this only echoes it back. A
 * page that fails to load names what failed, says the payments already shown
 * are fine and that no money moved (it is a read), and the same button
 * retries from the same cursor — nothing is skipped or duplicated
 * (`appendUnique` drops a reference that is already on screen, which is also
 * what keeps a future live-update feed from doubling a row).
 *
 * Not live yet: F7 (SSE) owns "a payment in another tab moves the numbers".
 */
export function PaymentsSection({ code, initialPayments, initialCursor }: PaymentsSectionProps) {
  const [payments, setPayments] = useState(initialPayments)
  const [cursor, setCursor] = useState(initialCursor)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle')

  async function handleShowMore() {
    if (cursor === null) return
    setLoadState('loading')
    try {
      const page = await client.links.payments(code, { cursor, limit: PAGE_SIZE })
      setPayments((current) => appendUnique(current, page.items))
      setCursor(page.nextCursor)
      setLoadState('idle')
    } catch {
      setLoadState('error')
    }
  }

  return (
    <Card as="section" padding="none">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-[16px] font-semibold text-(--color-ink)">Payments</h2>
      </div>
      <Table
        columns={PAYMENTS_TABLE_COLUMNS}
        rows={payments}
        rowKey={(payment) => payment.reference}
        emptyState={
          <EmptyState
            as="h3"
            icon={<CoinsIcon />}
            title="No payments yet"
            body="Share the link or let someone scan its QR code. Each payment appears here with who paid, how much, and whether the money moved."
          />
        }
      />
      {cursor !== null ? (
        <div className="flex flex-col items-start gap-2 border-t border-(--color-border-soft) px-4 py-3">
          <Button
            variant="secondary"
            surface="surface"
            status={loadState}
            errorMessage="Couldn't load more payments."
            onClick={() => {
              void handleShowMore()
            }}
          >
            Show more payments
          </Button>
          {loadState === 'error' ? (
            <p role="alert" className="text-[13px] text-(--color-danger)">
              <strong className="font-semibold">Couldn&apos;t load more payments.</strong> The payments above are
              unaffected and no money moved — this only stopped the next page loading. Try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
