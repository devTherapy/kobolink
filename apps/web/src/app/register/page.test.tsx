import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type * as NextNavigation from 'next/navigation'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN } from '@/mocks/handlers'

/**
 * `/register` mirrors `/login`'s server shell exactly — same
 * `sameOriginPath(rawNext)` call, same already-signed-in redirect — but
 * previously had no test at all for either. See `login/page.test.tsx` for
 * why the mutable `cookieHeader` and the `RegisterForm` stub are shaped this
 * way: this is the same page → form seam, just for the sibling route.
 */
let cookieHeader = ''
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => cookieHeader }),
}))

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/components/auth/RegisterForm', () => ({
  RegisterForm: ({ next }: { next: string | null }) => <div data-testid="next-prop">{next ?? ''}</div>,
}))

const { default: RegisterPage } = await import('./page')

/** "NEXT_REDIRECT;<type>;<url>;<statusCode>;" — see `next/dist/client/components/redirect.js`. */
function redirectTarget(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const digest = (error as Error & { digest?: unknown }).digest
  if (typeof digest !== 'string') return null
  return digest.split(';')[2] ?? null
}

async function catchThrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('/register — signed out — the `next` query param passed to the form', () => {
  it('passes a validated same-origin `next` through to the form', async () => {
    cookieHeader = ''
    const element = await RegisterPage({ searchParams: Promise.resolve({ next: '/dashboard/links/aBcDeFgH' }) })
    const html = renderToStaticMarkup(element)
    expect(html).toContain('/dashboard/links/aBcDeFgH')
  })

  it('never threads an off-origin `next` through to the form (open-redirect guard)', async () => {
    cookieHeader = ''
    const element = await RegisterPage({ searchParams: Promise.resolve({ next: 'https://evil.example/phish' }) })
    const html = renderToStaticMarkup(element)
    expect(html).not.toContain('evil.example')
    expect(html).toContain('<div data-testid="next-prop"></div>')
  })

  it('a protocol-relative `next` (`//evil.example`) is rejected the same way', async () => {
    cookieHeader = ''
    const element = await RegisterPage({ searchParams: Promise.resolve({ next: '//evil.example/phish' }) })
    const html = renderToStaticMarkup(element)
    expect(html).not.toContain('evil.example')
    expect(html).toContain('<div data-testid="next-prop"></div>')
  })
})

describe('/register — already signed in — the redirect destination', () => {
  it('redirects to the validated same-origin `next`', async () => {
    cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`
    const error = await catchThrown(
      RegisterPage({ searchParams: Promise.resolve({ next: '/dashboard/links/aBcDeFgH' }) }),
    )
    expect(redirectTarget(error)).toBe('/dashboard/links/aBcDeFgH')
  })

  it('falls back to /dashboard when `next` is off-origin — never to the attacker URL', async () => {
    cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`
    const error = await catchThrown(
      RegisterPage({ searchParams: Promise.resolve({ next: 'https://evil.example/phish' }) }),
    )
    expect(redirectTarget(error)).toBe('/dashboard')
  })
})
