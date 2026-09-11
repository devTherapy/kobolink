'use client'

import { useEffect, useState } from 'react'
import { formatNaira, type PublicLinkResponse } from '@kobolink/contracts'
import { ApiRequestError, client } from '@/lib/api'

type LinkSummaryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PublicLinkResponse }

/**
 * A merchant/title/amount card for a payment link, resolved through the
 * public (unauthenticated) endpoint — the same call the `/l/[code]` checkout
 * and both mobile apps make. Exists in F0 to prove the MSW harness end to
 * end; F6 builds the real checkout page around the same `client.links.resolve`
 * call, server-side.
 */
export function LinkSummary({ code }: { code: string }) {
  const [state, setState] = useState<LinkSummaryState>({ status: 'loading' })
  // Reset to "loading" the moment `code` changes, during render rather than
  // in an Effect: https://react.dev/learn/you-might-not-need-an-effect —
  // "adjusting state when a prop changes". An Effect that called setState
  // synchronously on every run would commit the stale screen once before
  // re-rendering to the loading state, an extra paint this avoids.
  const [renderedCode, setRenderedCode] = useState(code)
  if (code !== renderedCode) {
    setRenderedCode(code)
    setState({ status: 'loading' })
  }

  useEffect(() => {
    let cancelled = false

    client.links
      .resolve(code)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof ApiRequestError ? error.error.message : 'Could not load this link.'
        setState({ status: 'error', message })
      })

    return () => {
      cancelled = true
    }
  }, [code])

  if (state.status === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading link"
        className="w-full max-w-sm animate-pulse rounded-(--radius-card) border border-(--color-border) bg-(--color-surface) p-4 shadow-(--shadow-card)"
      >
        <div className="h-3 w-1/2 rounded bg-(--color-border-soft)" />
        <div className="mt-3 h-5 w-3/4 rounded bg-(--color-border-soft)" />
        <div className="mt-3 h-7 w-1/3 rounded bg-(--color-border-soft)" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div
        role="alert"
        className="w-full max-w-sm rounded-(--radius-card) border border-(--color-danger) bg-(--color-danger-tint) p-4 text-[14px] text-(--color-danger)"
      >
        {state.message}
      </div>
    )
  }

  const { link, state: resolution } = state.data

  return (
    <article className="w-full max-w-sm rounded-(--radius-card) border border-(--color-border) bg-(--color-surface) p-4 shadow-(--shadow-card)">
      <p className="truncate text-[13px] text-(--color-ink-2)">{link.merchantName}</p>
      <h2 className="truncate text-[19px] font-semibold text-(--color-ink)">{link.title}</h2>
      <p className="tabular mt-1 text-[23px] font-semibold text-(--color-ink)">
        {link.amountKobo === null ? 'Amount set by payer' : formatNaira(link.amountKobo)}
      </p>
      {resolution !== 'payable' && (
        <p className="mt-2 text-[13px] text-(--color-warning)">
          {resolution === 'disabled' && 'This link is disabled.'}
          {resolution === 'expired' && 'This link has expired.'}
          {resolution === 'already-paid' && 'This link has already been paid.'}
        </p>
      )}
    </article>
  )
}
