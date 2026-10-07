'use client'

import { useId, useOptimistic, useState, useTransition } from 'react'
import { displayStatus, type PaymentLink } from '@kobolink/contracts'
import { Card } from '@/components/ui/Card'
import { StatusPill } from '@/components/ui/Pill'
import { Switch } from '@/components/ui/Switch'
import { client } from '@/lib/api'
import { describeStatusFailure } from '@/lib/link-status'

/**
 * The link's on/off switch and the status badge it drives (PLAN.md F5).
 *
 * **Optimistic, and honest about it.** Flipping the switch changes it — and
 * the badge — *immediately*, before the request returns, because a merchant
 * turning a link off mid-incident should not wait on a round trip to see the
 * switch respond. `useOptimistic` holds that guess on top of the last
 * *confirmed* link (`confirmed`, from the server's own response): if the
 * request succeeds, `confirmed` becomes the server's answer; if it fails,
 * the guess is simply discarded when the transition ends and the switch
 * snaps back to what the server last said — and an inline message says what
 * failed and what state the link is really in. The rollback is the
 * `useOptimistic` contract, not a hand-written "undo" that could be skipped
 * by a code path nobody tested.
 *
 * Both updates after the `await` run inside a second `startTransition`, so
 * the confirmed value and the end of the optimistic overlay land in the same
 * render (React's rule for async actions): without it there is a frame where
 * the badge shows the optimistic value over the *old* confirmed one.
 *
 * Only the stored `active` / `disabled` is toggled. Expiry and single-use
 * exhaustion are derived by `displayStatus()` and cannot be switched; the
 * badge shows the derived word, and a line of help says so when it
 * overrides the switch.
 *
 * Two live regions, both always mounted (one inserted at the moment it has
 * content is not reliably announced): `role="status"` for the success
 * message, and the failure is a `role="alert"` linked to the switch by
 * `aria-describedby`, so a screen-reader user hears it and finds it again.
 */
/**
 * Only what the switch and badge read — not the whole `PaymentLink` — because
 * every prop of a client component is serialised into the page's payload
 * (`server-serialization`). A full `PaymentLink` satisfies this.
 */
export type LinkStatusSource = Pick<PaymentLink, 'code' | 'status' | 'isReusable' | 'expiresAt' | 'paymentCount'>

export function LinkStatusControl({ link }: { link: LinkStatusSource }) {
  const [confirmed, setConfirmed] = useState(link)
  const [status, setOptimisticStatus] = useOptimistic(confirmed.status)
  const [isPending, startTransition] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const failureId = useId()

  const shown = displayStatus({ ...confirmed, status })

  function handleCheckedChange(next: boolean) {
    const attempted = next ? 'active' : 'disabled'
    setFailure(null)
    setAnnouncement('')

    startTransition(async () => {
      setOptimisticStatus(attempted)
      try {
        const updated = await client.links.updateStatus(confirmed.code, attempted)
        startTransition(() => {
          setConfirmed(updated)
          setAnnouncement(updated.status === 'active' ? 'Link turned on.' : 'Link turned off.')
        })
      } catch (error) {
        startTransition(() => {
          setFailure(describeStatusFailure(error, attempted))        })
      }
    })
  }

  return (
    <Card as="section" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[16px] font-semibold text-(--color-ink)">Status</h2>
        <StatusPill status={shown} />
      </div>

      <Switch
        checked={status === 'active'}
        onCheckedChange={handleCheckedChange}
        status={isPending ? 'loading' : failure ? 'error' : 'idle'}
        aria-describedby={failure ? failureId : undefined}
      >
        Accepting payments
      </Switch>

      <p className="text-[13px] text-(--color-ink-2)">
        {shown === 'Expired'
          ? 'This link has expired, so it cannot take payments whatever this switch says.'
          : shown === 'Paid'
            ? 'This single-use link has been paid, so it cannot take another payment.'
            : 'Turn this off to stop new payments. Anyone who opens the link will see that it is turned off. Payments already made are not affected.'}
      </p>

      <p role="status" className="text-[13px] text-(--color-ink-2) empty:hidden">
        {announcement}
      </p>
      {failure ? (
        <p id={failureId} role="alert" className="text-[13px] text-(--color-danger)">
          <strong className="font-semibold">Change not saved.</strong> {failure}
        </p>
      ) : null}
    </Card>
  )
}
