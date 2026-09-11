import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { linkStore } from '@/mocks/state'
import CheckoutPage, { generateMetadata } from './page'

/**
 * F6's own "Done when": *the rendered HTML contains the OG title before any
 * JS runs*. `generateMetadata` and the page component are called directly —
 * no browser, no hydration, nothing client-side involved — and the page's
 * returned element is turned into a literal HTML string with
 * `renderToStaticMarkup`, the same "no client JS" guarantee WhatsApp's own
 * link-preview scraper relies on.
 */
describe('/l/[code] — Done when: the OG title is present before any JS runs', () => {
  const params = Promise.resolve({ code: 'aBcDeFgH' })

  it('resolves the exact fixture title for generateMetadata (<title> and og:title)', async () => {
    const metadata = await generateMetadata({ params })
    expect(metadata.title).toEqual({ absolute: 'Pay ₦18,500 to Adebayo Stores' })
    expect(metadata.openGraph).toMatchObject({ title: 'Pay ₦18,500 to Adebayo Stores' })
    expect(metadata.twitter).toMatchObject({ title: 'Pay ₦18,500 to Adebayo Stores' })
  })

  it('renders the merchant, title and amount into static HTML with no client JS', async () => {
    const element = await CheckoutPage({ params })
    const html = renderToStaticMarkup(element)

    expect(html).toContain('Adebayo Stores')
    expect(html).toContain('Ankara Two-Piece Set')
    expect(html).toContain('₦18,500')
    // The payer form's inputs are part of the same static markup — the
    // island still SSRs its initial DOM, it just is not interactive yet.
    expect(html).toContain('Your name')
  })
})

describe('/l/[code] — non-payable states', () => {
  const code = 'aBcDeFgH'
  const params = Promise.resolve({ code })

  it('renders the disabled screen and states no money moved', async () => {
    const link = linkStore.get(code)
    if (!link) throw new Error('fixture link missing')
    linkStore.set(code, { ...link, status: 'disabled' })

    const metadata = await generateMetadata({ params })
    expect(metadata.title).toEqual({ absolute: 'This link is turned off — Adebayo Stores' })

    const element = await CheckoutPage({ params })
    const html = renderToStaticMarkup(element)
    expect(html).toMatch(/turned off/i)
    expect(html).toMatch(/no money has moved/i)
  })

  it('renders the expired screen and states no money moved', async () => {
    const link = linkStore.get(code)
    if (!link) throw new Error('fixture link missing')
    linkStore.set(code, { ...link, expiresAt: '2000-01-01T00:00:00.000Z' })

    const metadata = await generateMetadata({ params })
    expect(metadata.title).toEqual({ absolute: 'This link has expired — Adebayo Stores' })

    const element = await CheckoutPage({ params })
    const html = renderToStaticMarkup(element)
    expect(html).toMatch(/expired/i)
    expect(html).toMatch(/no money has moved/i)
  })

  it('renders the already-paid screen and states no money moved', async () => {
    const link = linkStore.get(code)
    if (!link) throw new Error('fixture link missing')
    linkStore.set(code, { ...link, isReusable: false, paymentCount: 1 })

    const metadata = await generateMetadata({ params })
    expect(metadata.title).toEqual({ absolute: 'This link has already been paid — Adebayo Stores' })

    const element = await CheckoutPage({ params })
    const html = renderToStaticMarkup(element)
    expect(html).toMatch(/already been paid/i)
    expect(html).toMatch(/no money has moved/i)
  })
})

describe('/l/[code] — 404', () => {
  it('calls notFound() for a malformed code', async () => {
    const params = Promise.resolve({ code: 'not-a-code' })
    await expect(CheckoutPage({ params })).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_HTTP_ERROR_FALLBACK;404') as unknown as string,
    })
  })

  it('calls notFound() for a well-formed but unknown code', async () => {
    const params = Promise.resolve({ code: 'zZzZzZzZ' })
    await expect(CheckoutPage({ params })).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_HTTP_ERROR_FALLBACK;404') as unknown as string,
    })
  })

  it('generateMetadata also calls notFound() rather than fabricating a title', async () => {
    const params = Promise.resolve({ code: 'zZzZzZzZ' })
    await expect(generateMetadata({ params })).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_HTTP_ERROR_FALLBACK;404') as unknown as string,
    })
  })
})
