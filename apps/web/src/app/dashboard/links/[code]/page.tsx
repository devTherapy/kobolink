import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { linkUrl } from '@kobolink/contracts'
import { CopyLink } from '@/components/dashboard/CopyLink'
import { ArrowLeftIcon } from '@/components/dashboard/icons'
import { LinkFigures } from '@/components/dashboard/LinkFigures'
import { LinkStatusControl } from '@/components/dashboard/LinkStatusControl'
import { PaymentsSection } from '@/components/dashboard/PaymentsSection'
import { QrCode } from '@/components/dashboard/QrCode'
import { Card } from '@/components/ui/Card'
import { noticeForReadFailure } from '@/components/dashboard/ReadFailureNotice'
import { loadLinkDetail, type LinkDetailResolution } from '@/lib/link-detail'
import { MerchantAccessError, UnexpectedResponseError } from '@/lib/read-failure'

/**
 * `/dashboard/links/[code]` — one link: its share URL and QR code, its on/off
 * switch, its figures, and its payments (PLAN.md F5, DESIGN-SPEC §4.2).
 *
 * An async Server Component. Everything that is just *shown* — the header,
 * the QR code (encoded here, so it costs the browser nothing), the figures
 * and the first page of payments — is in the HTML on arrival. What a merchant
 * can *do*, and what follows the live stream (F7), are client islands, each
 * with its own `"use client"` boundary: `CopyLink`, `LinkStatusControl` (the
 * optimistic switch), `LinkFigures` and `PaymentsSection` ("Show more", and
 * arriving payments laid over its first page).
 *
 * The live ones compare events against `asOf` — when this render's reads
 * finished — so an event the render already includes is not applied twice.
 *
 * `params` is a `Promise` in this Next.js major (see `AGENTS.md`).
 *
 * A link that does not exist, has a malformed code, or belongs to another
 * merchant is the same answer on purpose — the API returns 404, never 403, so
 * a code cannot be probed for existence — and renders `not-found.tsx`.
 */
interface PageProps {
  params: Promise<{ code: string }>
}

/**
 * A merchant's own link, with live counters: never a build-time or cached
 * render. `loadLinkDetail` reads cookies, which already makes this dynamic —
 * this is explicit insurance, same as `/dashboard`.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params
  try {
    const resolution = await loadLinkDetail(code)
    return { title: resolution.found ? resolution.data.link.title : 'Link not found' }
  } catch (error) {
    // The page renders these two itself (below); a title must not turn them
    // back into a thrown error. Anything else is for `error.tsx`.
    if (error instanceof MerchantAccessError || error instanceof UnexpectedResponseError) return { title: 'Link' }
    throw error
  }
}

export default async function LinkDetailPage({ params }: PageProps) {
  const { code } = await params
  let resolution: LinkDetailResolution
  try {
    resolution = await loadLinkDetail(code)
  } catch (error) {
    // A customer account and a body that breaks the contract cannot be fixed by
    // a retry, and `error.tsx` could not tell them from "unreachable" anyway
    // (production strips a thrown error to a digest) — so they render here.
    const notice = noticeForReadFailure(error, { subject: 'this link', reloadHref: `/dashboard/links/${code}` })
    if (notice) return notice
    throw error
  }
  if (!resolution.found) notFound()

  const { link, payments, asOf } = resolution.data
  // The public checkout URL — from the contract's one builder, never assembled here.
  const url = linkUrl(link.code)

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/dashboard"
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-(--radius-input) px-2 text-[13px] font-medium text-(--color-brand) hover:bg-(--color-brand-tint) active:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)"
      >
        <ArrowLeftIcon />
        All links
      </Link>

      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-[23px] font-semibold text-(--color-ink)">{link.title}</h1>
        {link.description ? <p className="break-words text-[14px] text-(--color-ink-2)">{link.description}</p> : null}
      </header>

      <div className="grid items-start gap-6 md:grid-cols-2">
        <Card as="section" className="flex flex-col gap-4">
          <h2 className="text-[16px] font-semibold text-(--color-ink)">Share this link</h2>
          <div className="flex justify-center">
            <QrCode value={url} label={`QR code for ${link.title}. Scanning it opens ${url}`} />
          </div>
          <CopyLink url={url} />
        </Card>

        <div className="flex flex-col gap-6">
          <LinkStatusControl
            link={{
              code: link.code,
              status: link.status,
              isReusable: link.isReusable,
              expiresAt: link.expiresAt,
              paymentCount: link.paymentCount,
            }}
            asOf={asOf}
          />
          <LinkFigures link={link} asOf={asOf} />
        </div>
      </div>

      <PaymentsSection code={link.code} initialPayments={payments.items} initialCursor={payments.nextCursor} />
    </div>
  )
}
