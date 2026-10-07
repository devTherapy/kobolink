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

/**
 * Next hands every page a `searchParams` promise, and a repeated key arrives
 * as `string[]` (F2's login/register pages 500'd on exactly that for `?next=`,
 * fixed in #41). `/l/[code]` is public and reads no query value at all — it
 * does not even declare `searchParams` — so a query string cannot reach it.
 * These tests pin that: the same OG title and the same payer form render
 * whatever the query looks like, so adding a `searchParams` read later has to
 * keep them green rather than reintroduce the crash.
 */
describe('/l/[code] — a query string never changes the render', () => {
  const code = 'aBcDeFgH'
  const params = Promise.resolve({ code })
  type Props = Parameters<typeof CheckoutPage>[0]
  const queries: Record<string, Record<string, string | string[] | undefined>> = {
    'a repeated unknown key': { x: ['1', '2'] },
    'a repeated amount': { amount: ['1', '2'] },
    'a repeated and an empty next': { next: ['', '/dashboard', ''] },
    'an empty next': { next: '' },
    'keys named like Object.prototype members': { __proto__: '1', constructor: ['a', 'b'], toString: '' },
  }

  it.each(Object.entries(queries))('serves the normal page and OG title for %s', async (_name, query) => {
    const props = { params, searchParams: Promise.resolve(query) } as unknown as Props

    const metadata = await generateMetadata(props)
    expect(metadata.title).toEqual({ absolute: 'Pay ₦18,500 to Adebayo Stores' })
    expect(metadata.openGraph).toMatchObject({ title: 'Pay ₦18,500 to Adebayo Stores' })

    const html = renderToStaticMarkup(await CheckoutPage(props))
    expect(html).toContain('Adebayo Stores')
    expect(html).toContain('₦18,500')
    expect(html).toContain('Your name')
    expect(html).not.toMatch(/link not found/i)
  })

  it('leaves a link that does not exist on the 404 state when a key is repeated', async () => {
    const props = {
      params: Promise.resolve({ code: 'zZzZzZzZ' }),
      searchParams: Promise.resolve({ x: ['1', '2'] }),
    } as unknown as Props
    await expect(CheckoutPage(props)).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_HTTP_ERROR_FALLBACK;404') as unknown as string,
    })
  })
})

/**
 * The `code` param is the other input a stranger controls. Whatever shape it
 * takes — empty, enormous, percent-encoded, padded, or not a string at all —
 * it must land on the existing not-found state, never a 500.
 */
describe('/l/[code] — hostile code params land on the not-found state', () => {
  const notFound = { digest: expect.stringContaining('NEXT_HTTP_ERROR_FALLBACK;404') as unknown as string }
  const hostile: Record<string, unknown> = {
    empty: '',
    'one character short': 'aBcDeFg',
    'one character long': 'aBcDeFgHi',
    'enormous (100k characters)': 'a'.repeat(100_000),
    'still percent-encoded': 'aBcDeFg%48',
    'a literal percent sign': '%',
    'a malformed percent sequence': '%E0%A4%A',
    'padded with whitespace': ' aBcDeFgH ',
    'a NUL byte': 'aBcDeF\u0000H',
    'an excluded look-alike character (0)': '0BcDeFgH',
    'a path traversal': '../../etc',
    'a repeated-segment array': ['aBcDeFgH', 'aBcDeFgH'],
  }

  it.each(Object.entries(hostile))('calls notFound() for %s', async (_name, value) => {
    const params = Promise.resolve({ code: value as string })
    await expect(CheckoutPage({ params })).rejects.toMatchObject(notFound)
    await expect(generateMetadata({ params })).rejects.toMatchObject(notFound)
  })
})
