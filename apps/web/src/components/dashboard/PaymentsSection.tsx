'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Payment } from '@kobolink/contracts'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table } from '@/components/ui/Table'
import { client } from '@/lib/api'
import { isSessionExpired, signInHref } from '@/lib/link-status'
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
 * Two things happen when a page arrives. It is *announced* ("N more payments
 * loaded. Showing M.") in an always-mounted `role="status"`, because rows
 * appearing below the fold are otherwise silent. And if it was the last page
 * the button that was just pressed unmounts, which would drop focus to
 * `<body>` — so focus moves to that same status line, which sits where the
 * button was. (A middle page leaves the button, and focus, in place.)
 *
 * A failure that signing in would fix (`unauthenticated`) offers a link to
 * `/login?next=` this page instead of a retry that can never succeed.
 *
 * Not live yet: F7 (SSE) owns "a payment in another tab moves the numbers".
 */
export function PaymentsSection({ code, initialPayments, initialCursor }: PaymentsSectionProps) {
  const [payments, setPayments] = useState(initialPayments)
  const [cursor, setCursor] = useState(initialCursor)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [loadedNote, setLoadedNote] = useState('')
  const noteRef = useRef<HTMLParagraphElement>(null)

  // After the last page the pressed button is gone; land focus on the line that says what arrived.
  // Keyed on the note, which is new text on every load (it carries the running total).
  useEffect(() => {
    if (loadedNote !== '' && cursor === null) noteRef.current?.focus()
  }, [loadedNote, cursor])

  async function handleShowMore() {
    if (cursor === null) return
    setLoadState('loading')
    setSessionExpired(false)
    try {
      const page = await client.links.payments(code, { cursor, limit: PAGE_SIZE })
      const merged = appendUnique(payments, page.items)
      const added = merged.length - payments.length
      setPayments(merged)
      setCursor(page.nextCursor)
      setLoadedNote(`${added} more payment${added === 1 ? '' : 's'} loaded. Showing ${merged.length}.`)
      setLoadState('idle')
    } catch (error) {
      setSessionExpired(isSessionExpired(error))
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
          {sessionExpired ? null : (
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
          )}
          {loadState === 'error' ? (
            <p role="alert" className="text-[13px] text-(--color-danger)">
              <strong className="font-semibold">Couldn&apos;t load more payments.</strong>{' '}
              {sessionExpired ? (
                <>
                  Your session has expired. The payments above are unaffected and no money moved.{' '}
                  <Link
                    href={signInHref(`/dashboard/links/${code}`)}
                    className="inline-flex min-h-11 items-center font-medium text-(--color-brand) underline underline-offset-2 hover:text-(--color-brand-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
                  >
                    Sign in again
                  </Link>
                </>
              ) : (
                'The payments above are unaffected and no money moved — this only stopped the next page loading. Try again.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {/* Always mounted, and focusable by script only (`tabIndex={-1}`): a live region inserted
          with its text is not reliably announced, and this is where focus lands after the last page. */}
      <p
        ref={noteRef}
        role="status"
        tabIndex={-1}
        className="px-4 text-[13px] text-(--color-ink-2) outline-none empty:hidden not-empty:py-3"
      >
        {loadedNote}
      </p>
    </Card>
  )
}
