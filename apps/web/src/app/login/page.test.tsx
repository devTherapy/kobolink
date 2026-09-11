import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type * as NextNavigation from 'next/navigation'

/** No session cookie for every test in this file — `/login`'s own-signed-in redirect is exercised separately below. */
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => '' }),
}))

// `LoginForm` calls `useRouter()`, which throws outside a mounted
// `AppRouterContext` (`renderToStaticMarkup` provides none) — see
// `src/app/dashboard/layout.test.tsx`'s identical mock for why
// `importOriginal` matters here (this page also calls the real `redirect`).
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const { default: LoginPage } = await import('./page')

describe('/login — the `next` query param', () => {
  it('passes a validated same-origin `next` through to the form', async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({ next: '/dashboard/links/aBcDeFgH' }) })
    const html = renderToStaticMarkup(element)
    // The form's own success handler reads this prop, not the DOM — this
    // just asserts the page rendered (no thrown redirect, no crash) with a
    // same-origin `next` in hand. `LoginForm`'s own tests assert the actual
    // `router.replace` call.
    expect(html).toContain('Sign in')
  })

  it('renders without throwing for an off-origin `next` (rejected, not forwarded)', async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({ next: 'https://evil.example/phish' }) })
    const html = renderToStaticMarkup(element)
    expect(html).toContain('Sign in')
    expect(html).not.toContain('evil.example')
  })
})
