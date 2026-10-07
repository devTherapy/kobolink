'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { formatNaira, type Payment } from '@kobolink/contracts'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table } from '@/components/ui/Table'
import { useDashboardStream } from '@/components/live/DashboardStreamProvider'
import { client } from '@/lib/api'
import { isSessionExpired, signInHref } from '@/lib/link-status'
import { appendUnique, livePaymentsFor, mergePayments } from '@/lib/live-dashboard'
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
 * **Live (F7).** Payments the stream delivers for this link are laid over the
 * rendered first page — newest on top, a reference already there replaced by
 * the live version, never listed twice (`mergePayments`) — and a failed attempt
 * is a row too, saying no money moved. Nothing live is copied into state:
 * `initialPayments` / `initialCursor` are read on every render, so when the
 * `router.refresh()` that each event schedules delivers a newer first page, it
 * simply shows. State holds only what this component fetched itself — the pages
 * after the first — so a refresh never discards a "Show more" the merchant did,
 * and the cursor follows those pages once there are any. Because a new payment
 * pushes the first page's last item onto the second, that item is kept between
 * the two (`slidOff`) rather than falling into the gap between the first page
 * and the cursor the older pages were fetched with.
 */
export function PaymentsSection({ code, initialPayments, initialCursor }: PaymentsSectionProps) {
  const { events } = useDashboardStream()
  // Pages fetched by "Show more", after the rendered first page; `undefined` until one is.
  const [olderPayments, setOlderPayments] = useState<Payment[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined)
  const livePayments = useMemo(() => livePaymentsFor(code, events), [code, events])
  const firstPage = useMemo(() => mergePayments(initialPayments, livePayments), [initialPayments, livePayments])

  // Pages are keyset-paginated: a new payment pushes the last item of the first page off it, but the
  // older pages were fetched with a cursor that starts *after* that item, so it would be in neither
  // list. When the first page changes while older pages are loaded, what slid off is kept (newest
  // first) between the two, so the table stays gap-free and agrees with the API's own counts. Before
  // any "Show more" there is nothing to bridge: the cursor then comes from the latest first page.
  const [slidOff, setSlidOff] = useState<Payment[]>([])
  const [previousFirstPage, setPreviousFirstPage] = useState(firstPage)
  if (firstPage !== previousFirstPage) {
    setPreviousFirstPage(firstPage)
    if (olderCursor !== undefined) {
      const stillOnFirstPage = new Set(firstPage.map((payment) => payment.reference))
      const slid = previousFirstPage.filter((payment) => !stillOnFirstPage.has(payment.reference))
      if (slid.length > 0) setSlidOff((previous) => appendUnique(slid, previous))
    }
  }

  const payments = useMemo(
    () => appendUnique(appendUnique(firstPage, slidOff), olderPayments),
    [firstPage, slidOff, olderPayments],
  )
  const cursor = olderCursor === undefined ? initialCursor : olderCursor
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sessionExpired, setSessionExpired] = useState(false)
  // How many rows the last "Show more" added, and a counter that is new on every load. The note's
  // running total is derived at render, so it stays true when a refresh or a live payment changes the list.
  const [lastAdded, setLastAdded] = useState<number | null>(null)
  const [loadCount, setLoadCount] = useState(0)
  const loadedNote =
    lastAdded === null ? '' : `${lastAdded} more payment${lastAdded === 1 ? '' : 's'} loaded. Showing ${payments.length}.`
  const noteRef = useRef<HTMLParagraphElement>(null)

  // After the last page the pressed button is gone; land focus on the line that says what arrived.
  // Keyed on the load, not the note text: a live payment changes the total but is not a reason to move focus.
  useEffect(() => {
    if (loadCount > 0 && cursor === null) noteRef.current?.focus()
  }, [loadCount, cursor])

  async function handleShowMore() {
    if (cursor === null) return
    setLoadState('loading')
    setSessionExpired(false)
    try {
      const page = await client.links.payments(code, { cursor, limit: PAGE_SIZE })
      const added = appendUnique(payments, page.items).length - payments.length
      setOlderPayments((previous) => appendUnique(previous, page.items))
      setOlderCursor(page.nextCursor)
      setLastAdded(added)
      setLoadCount((count) => count + 1)
      setLoadState('idle')
    } catch (error) {
      setSessionExpired(isSessionExpired(error))
      setLoadState('error')
    }
  }

  // The newest payment to have arrived live, said once to a screen reader — a row appearing at
  // the top of a table is otherwise silent. Always mounted: a live region inserted with its text
  // is not reliably announced. A bare `aria-live` rather than `role="status"`: the "Show more"
  // note below already is the one status region this component's focus handling relies on.
  const latestLive = livePayments[0]

  return (
    <Card as="section" padding="none">
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {latestLive === undefined
          ? null
          : latestLive.moneyMoved
            ? `New payment: ${formatNaira(latestLive.amountKobo)} from ${latestLive.payerName}.`
            : `A payment from ${latestLive.payerName} failed. No money moved.`}
      </p>
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
