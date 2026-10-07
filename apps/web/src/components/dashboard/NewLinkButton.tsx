'use client'

import { useRef, useState, useTransition, type MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import type { PaymentLink } from '@kobolink/contracts'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { CreateLinkForm } from './CreateLinkForm'

/**
 * The dashboard's "New link" CTA and the drawer it opens (PLAN.md F4,
 * DESIGN-SPEC §4.1). The dashboard page stays a Server Component; this is the
 * one client island around it, so the drawer and its form ship as JS only
 * where the merchant can use them.
 *
 * On success the drawer closes, focus returns to this button (`Drawer` does
 * that), and `router.refresh()` re-runs the page's server render — the stat
 * strip and links table pick up the new link from the API, no full reload and
 * no client-side copy of the list to keep in step. The refresh runs in a
 * transition so the page never blanks into `loading.tsx` for it.
 *
 * The result is said twice, for two audiences: a persistent `role="status"`
 * line next to the button (visible, and announced politely — it outlives the
 * drawer, which is gone by the time the announcement would otherwise fire),
 * and the new row itself appearing at the top of the table.
 */
export function NewLinkButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [createdTitle, setCreatedTitle] = useState<string | null>(null)
  const [isRefreshing, startRefresh] = useTransition()
  const openerRef = useRef<HTMLElement | null>(null)
  // A ref, not state: nothing renders from it. `Drawer` asks the owner (via
  // `onClose`) and the owner answers from here.
  const pendingRef = useRef(false)

  function handleOpen(event: MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget
    setCreatedTitle(null)
    setOpen(true)
  }

  function handleClose() {
    // Refused while a request is in flight: closing now would orphan its result.
    if (pendingRef.current) return
    setOpen(false)
  }

  function handleCreated(link: PaymentLink) {
    pendingRef.current = false
    setCreatedTitle(link.title)
    setOpen(false)
    startRefresh(() => {
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button onClick={handleOpen} aria-haspopup="dialog">
        New link
      </Button>
      {/* Always mounted (empty until there is something to say): a live region
          inserted at the moment it has content is not reliably announced. */}
      <p
        role="status"
        aria-busy={isRefreshing || undefined}
        className="text-[13px] text-(--color-ink-2) empty:hidden"
      >
        {createdTitle === null ? null : `Created “${createdTitle}”.`}
      </p>

      <Drawer open={open} onClose={handleClose} title="New payment link" returnFocusRef={openerRef}>
        <CreateLinkForm
          onCreated={handleCreated}
          onCancel={handleClose}
          onPendingChange={(pending) => {
            pendingRef.current = pending
          }}
        />
      </Drawer>
    </div>
  )
}
