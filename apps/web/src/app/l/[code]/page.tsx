import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { formatNaira, linkUrl, type PublicLink } from '@kobolink/contracts'
import { checkoutTitle, resolveCheckoutLink } from '@/lib/checkout'
import { CheckoutCard, CheckoutShell } from '@/components/checkout/CheckoutCard'
import { NonPayableScreen } from '@/components/checkout/NonPayableScreen'
import { PayForm } from '@/components/checkout/PayForm'

/**
 * `/l/[code]` — the deep-link target (§4.3). An **async Server Component**,
 * deliberately: the payer's browser (and, just as importantly, WhatsApp's
 * link-preview scraper, which never runs JavaScript at all) must see the
 * merchant name, title and amount in the very first response. Only the
 * payer form below is a `"use client"` island (`PayForm`) — see its own doc
 * comment for why the split sits exactly there.
 *
 * `params` is a `Promise` — an App Router API that changed under this
 * Next.js major version (see `AGENTS.md`); every reader of `params` here
 * `await`s it.
 */
interface PageProps {
  params: Promise<{ code: string }>
}

/**
 * `client.links.resolve`'s `cache: 'no-store'` already makes Next infer this
 * route as dynamic, but that inference depends on the fetch actually running
 * — a build-time prerender attempt for a route with no known params (there
 * is no `generateStaticParams` here) skips it. Force it explicitly: a merchant
 * disabling a link must take effect on the very next visitor, not "whenever
 * this path was last built".
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params
  const resolution = await resolveCheckoutLink(code)
  if (!resolution.found) notFound()

  const { state, link } = resolution.data
  const title = checkoutTitle(state, link)
  const description = link.description ?? `A payment link from ${link.merchantName}, powered by Kobolink.`
  const url = linkUrl(link.code)
  // Read once; not invented when unset — the checkout still works without
  // the app, and an unset id must never produce a bogus banner.
  const iosAppStoreId = process.env.NEXT_PUBLIC_IOS_APP_STORE_ID

  return {
    title: { absolute: title },
    description,
    openGraph: { title, description, url, siteName: 'Kobolink', type: 'website' },
    twitter: { card: 'summary', title, description },
    // A link that cannot be paid still needs its OG title (a merchant may
    // share the URL before it is disabled), but it earns nothing from
    // being indexed the way a real page would.
    robots: state === 'payable' ? undefined : { index: false, follow: false },
    ...(iosAppStoreId ? { itunes: { appId: iosAppStoreId, appArgument: url } } : {}),
  }
}

export default async function CheckoutPage({ params }: PageProps) {
  const { code } = await params
  const resolution = await resolveCheckoutLink(code)
  if (!resolution.found) notFound()

  const { state, link } = resolution.data

  return (
    <CheckoutShell>
      {state === 'payable' ? <PayableCheckout link={link} /> : <NonPayableScreen state={state} link={link} />}
    </CheckoutShell>
  )
}

function PayableCheckout({ link }: { link: PublicLink }) {
  return (
    <div className="flex flex-col gap-4">
      <CheckoutCard>
        <header className="flex flex-col items-center gap-1 text-center">
          <p className="truncate text-[13px] text-(--color-ink-2)">{link.merchantName}</p>
          <h1 className="text-[23px] font-semibold text-(--color-ink)">{link.title}</h1>
          {link.description ? <p className="text-[14px] text-(--color-ink-2)">{link.description}</p> : null}
          {link.amountKobo !== null ? (
            <p className="tabular mt-1 text-[34px] font-semibold text-(--color-ink)">{formatNaira(link.amountKobo)}</p>
          ) : null}
        </header>
      </CheckoutCard>
      <PayForm link={link} />
    </div>
  )
}
