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

/** The pages fetched by "Show more", and the first page (`anchor`) their cursor continues from. */
interface LoadedPages {
  anchor: string
  payments: Payment[]
  /** `undefined` until a page has been fetched; then the API's own next cursor, `null` at the end. */
  cursor: string | null | undefined
  lastAdded: number | null
}

const NOTHING_LOADED: LoadedPages = { anchor: '', payments: [], cursor: undefined, lastAdded: null }

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
 * simply shows. State holds only what this component fetched itself — the
 * pages after the first — and stores it with the first page it was fetched
 * against. A refresh that changes that first page (a new payment pushes its last
 * item off it, so the old cursor no longer lines up) drops those pages, and a
 * response still in flight for them, and "Show more" starts again from the new
 * cursor: older pages are never kept across a first-page change, so nothing can
 * fall in a gap. A refresh that finds nothing new keeps what was loaded.
 */
export function PaymentsSection({ code, initialPayments, initialCursor }: PaymentsSectionProps) {
  const { events } = useDashboardStream()
  const livePayments = useMemo(() => livePaymentsFor(code, events), [code, events])
  const firstPage = useMemo(() => mergePayments(initialPayments, livePayments), [initialPayments, livePayments])

  // What the pages after the first were fetched against. A cursor only means something next to the
  // first page it came with, and the first page moves (a new payment pushes its last item off it), so
  // everything fetched here is stored with this key and used only while it still matches the props.
  // When a refresh changes the first page (or its cursor) the old pages are simply not shown any more
  // and "Show more" continues from the new cursor — nothing can fall in a gap between the two. A
  // refresh that finds nothing new produces the same key and keeps what was loaded.
  const anchor = `${initialCursor ?? ''}|${initialPayments.map((payment) => payment.reference).join(',')}`
  const [loaded, setLoaded] = useState<LoadedPages>(NOTHING_LOADED)
  const older = loaded.anchor === anchor ? loaded : NOTHING_LOADED

  const payments = useMemo(() => appendUnique(firstPage, older.payments), [firstPage, older.payments])
  const cursor = older.cursor === undefined ? initialCursor : older.cursor
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sessionExpired, setSessionExpired] = useState(false)
  // A counter that is new on every accepted load: the focus effect keys on it. The note's running total
  // is derived at render, so it stays true when a live payment changes the list.
  const [loadCount, setLoadCount] = useState(0)
  const loadedNote =
    older.lastAdded === null
      ? ''
      : `${older.lastAdded} more payment${older.lastAdded === 1 ? '' : 's'} loaded. Showing ${payments.length}.`
  const noteRef = useRef<HTMLParagraphElement>(null)

  // The latest list and anchor, for a request that resolves later: it must be judged against the page
  // as it is *then*, not as it was when the button was pressed.
  const latest = useRef({ anchor, payments })
  useEffect(() => {
    latest.current = { anchor, payments }
  })

  // After the last page the pressed button is gone; land focus on the line that says what arrived.
  // Keyed on the load, not the note text: a live payment changes the total but is not a reason to move focus.
  useEffect(() => {
    if (loadCount > 0 && cursor === null) noteRef.current?.focus()
  }, [loadCount, cursor])

  async function handleShowMore() {
    if (cursor === null) return
    const requestedAgainst = anchor
    setLoadState('loading')
    setSessionExpired(false)
    try {
      const page = await client.links.payments(code, { cursor, limit: PAGE_SIZE })
      if (latest.current.anchor !== requestedAgainst) {
        // The first page changed while this was in flight; this page continues from the old one.
        setLoadState('idle')
        return
      }
      const current = latest.current.payments
      const added = appendUnique(current, page.items).length - current.length
      setLoaded((previous) => ({
        anchor: requestedAgainst,
        payments: appendUnique(previous.anchor === requestedAgainst ? previous.payments : [], page.items),
        cursor: page.nextCursor,
        lastAdded: added,
      }))
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
