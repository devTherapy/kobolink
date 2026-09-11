import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type * as NextNavigation from 'next/navigation'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN } from '@/mocks/handlers'

/**
 * A mutable cookie header, same pattern as
 * `src/app/dashboard/layout.test.tsx` — lets a single mock module serve both
 * "signed out" (empty string, the default below) and "already signed in"
 * cases without needing `vi.resetModules()`/`vi.doMock()` gymnastics.
 */
let cookieHeader = ''
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => cookieHeader }),
}))

// `LoginForm` calls `useRouter()`, which throws outside a mounted
// `AppRouterContext` (`renderToStaticMarkup` provides none) — see
// `src/app/dashboard/layout.test.tsx`'s identical mock for why
// `importOriginal` matters here (this page also calls the real `redirect`).
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

/**
 * `LoginForm` never renders its `next` prop into the DOM — it only reads it
 * later, inside its own post-submit `router.replace(next ?? '/dashboard')`
 * (see `LoginForm.test.tsx` for that half). That made the old version of
 * `expect(html).not.toContain('evil.example')` pass whether or not
 * `login/page.tsx` actually called `sameOriginPath` before handing `next` to
 * the form — the string would never appear in the rendered HTML either way,
 * so that assertion could not fail for what it claimed to cover.
 *
 * Stubbing `LoginForm` down to a component that renders its `next` prop
 * verbatim turns that prop into something this test can actually assert on:
 * this is the real page → form seam the open-redirect guard has to survive,
 * and — unlike the old test — this one goes red if `sameOriginPath` is ever
 * removed from `login/page.tsx`.
 */
vi.mock('@/components/auth/LoginForm', () => ({
  LoginForm: ({ next }: { next: string | null }) => <div data-testid="next-prop">{next ?? ''}</div>,
}))

const { default: LoginPage } = await import('./page')

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

describe('/login — signed out — the `next` query param passed to the form', () => {
  it('passes a validated same-origin `next` through to the form', async () => {
    cookieHeader = ''
    const element = await LoginPage({ searchParams: Promise.resolve({ next: '/dashboard/links/aBcDeFgH' }) })
    const html = renderToStaticMarkup(element)
    expect(html).toContain('/dashboard/links/aBcDeFgH')
  })

  it('never threads an off-origin `next` through to the form (open-redirect guard)', async () => {
    cookieHeader = ''
    const element = await LoginPage({ searchParams: Promise.resolve({ next: 'https://evil.example/phish' }) })
    const html = renderToStaticMarkup(element)
    expect(html).not.toContain('evil.example')
    // Assert the prop actually landed as `null`, not merely that the
    // attacker's exact string is absent — a bug that let some *other*
    // off-origin value slip through unrejected would still pass a check
    // that only looked for this one string.
    expect(html).toContain('<div data-testid="next-prop"></div>')
  })

  it('a protocol-relative `next` (`//evil.example`) is rejected the same way', async () => {
    cookieHeader = ''
    const element = await LoginPage({ searchParams: Promise.resolve({ next: '//evil.example/phish' }) })
    const html = renderToStaticMarkup(element)
    expect(html).not.toContain('evil.example')
    expect(html).toContain('<div data-testid="next-prop"></div>')
  })
})

describe('/login — already signed in — the redirect destination', () => {
  it('redirects to the validated same-origin `next`', async () => {
    cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`
    const error = await catchThrown(
      LoginPage({ searchParams: Promise.resolve({ next: '/dashboard/links/aBcDeFgH' }) }),
    )
    expect(redirectTarget(error)).toBe('/dashboard/links/aBcDeFgH')
  })

  it('falls back to /dashboard when `next` is off-origin — never to the attacker URL', async () => {
    cookieHeader = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`
    const error = await catchThrown(LoginPage({ searchParams: Promise.resolve({ next: 'https://evil.example/phish' }) }))
    expect(redirectTarget(error)).toBe('/dashboard')
  })
})
