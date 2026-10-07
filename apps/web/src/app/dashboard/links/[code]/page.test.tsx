import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { API, exampleLink } from '@kobolink/contracts'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { linkStore, paymentsByCode } from '@/mocks/state'
import LinkDetailPage, { generateMetadata } from './page'

const cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => cookieHeader }),
}))

/**
 * `LinkStatusControl`, `CopyLink` and `PaymentsSection` are client islands:
 * rendered to static markup they still SSR their initial DOM, but a hook that
 * needs the App Router must not throw. None of them calls `useRouter`, so no
 * `next/navigation` mock is needed beyond `notFound`'s own behaviour, which
 * is the real one here (it throws a tagged error Next turns into a 404).
 */
const params = Promise.resolve({ code: 'aBcDeFgH' })

/** What `notFound()` throws: Next recognises the digest and answers 404. */
const NOT_FOUND_ERROR: { digest: unknown } = { digest: expect.stringContaining('404') as unknown }

describe('/dashboard/links/[code]', () => {
  it('renders the link, its share URL, its QR code and its payments into the server HTML', async () => {
    const html = renderToStaticMarkup(await LinkDetailPage({ params }))

    expect(html).toContain('Ankara Two-Piece Set')
    expect(html).toContain('Size 12, ships within Lagos in 2 days.')
    // Share: the URL as text (value of the read-only field) and a QR image whose alternative carries it.
    expect(html).toContain('value="https://pay.folusayo.com/l/aBcDeFgH"')
    expect(html).toMatch(/role="img"[^>]*aria-label="QR code for Ankara Two-Piece Set\. Scanning it opens https:\/\/pay\.folusayo\.com\/l\/aBcDeFgH"/)
    expect(html).toContain('Copy link')
    // The switch, rendered in its initial state.
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    // Figures — money formatted by the contract, "Any amount" never ₦0.
    expect(html).toContain('₦18,500')
    expect(html).toContain('₦55,500')
    // First page of payments is in the HTML before any JS.
    expect(html).toContain('Ngozi Okafor')
    expect(html).toContain('kbl_7hK2mN9pQr')
  })

  it('says "Any amount" for an open-amount link rather than ₦0', async () => {
    linkStore.set('aBcDeFgH', exampleLink({ amountKobo: null, totalPaidKobo: 0, paymentCount: 0 }))
    paymentsByCode.set('aBcDeFgH', [])

    const html = renderToStaticMarkup(await LinkDetailPage({ params }))

    // The Amount figure is words; the Collected figure beside it is a genuine ₦0.
    expect(html).toMatch(/Amount<\/dt><dd[^>]*>Any amount</)
    expect(html).toMatch(/Collected<\/dt><dd[^>]*>₦0</)
    // …and the empty payments table teaches rather than shows a bare header.
    expect(html).toContain('No payments yet')
  })

  it('renders the disabled state: switch off, badge Disabled', async () => {
    linkStore.set('aBcDeFgH', exampleLink({ status: 'disabled' }))

    const html = renderToStaticMarkup(await LinkDetailPage({ params }))

    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('Disabled')
  })

  it('links back to the dashboard', async () => {
    const html = renderToStaticMarkup(await LinkDetailPage({ params }))
    expect(html).toContain('href="/dashboard"')
  })

  it('titles the document with the link title', async () => {
    await expect(generateMetadata({ params })).resolves.toEqual({ title: 'Ankara Two-Piece Set' })
  })

  it('is not-found for a link the API 404s — as a merchant\'s other-merchant link does — not a crash', async () => {
    server.use(
      http.get(API.links.item(':code'), () =>
        HttpResponse.json({ code: 'not_found', message: 'Link not found.' }, { status: 404 }),
      ),
      http.get(API.links.payments(':code'), () =>
        HttpResponse.json({ code: 'not_found', message: 'Link not found.' }, { status: 404 }),
      ),
    )

    await expect(LinkDetailPage({ params })).rejects.toMatchObject(NOT_FOUND_ERROR)
    await expect(generateMetadata({ params })).resolves.toEqual({ title: 'Link not found' })
  })

  it('is not-found for a malformed code', async () => {
    await expect(LinkDetailPage({ params: Promise.resolve({ code: 'x' }) })).rejects.toMatchObject(NOT_FOUND_ERROR)
  })
})
