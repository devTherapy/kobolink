import { act, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API, exampleUser } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { FakeEventSource } from '@/test/fake-event-source'
import { ConnectionStatus } from './ConnectionStatus'
import { DashboardStreamProvider } from './DashboardStreamProvider'

const navigation = vi.hoisted(() => ({ pathname: '/dashboard/links/aBcDeFgH' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => navigation.pathname,
}))

/** What `GET /api/auth/me` says when the stream fails: the failure's cause is learned from it. */
function sessionIs(answer: 'merchant' | 'customer' | 'expired' | 'unreachable'): void {
  server.use(
    http.get(API.auth.me, () => {
      if (answer === 'expired') return HttpResponse.json({ code: 'unauthenticated', message: 'Expired.' }, { status: 401 })
      if (answer === 'unreachable') return HttpResponse.error()
      return HttpResponse.json({ user: exampleUser({ role: answer }) })
    }),
  )
}

beforeEach(() => {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
  sessionIs('merchant')
  navigation.pathname = '/dashboard/links/aBcDeFgH'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderStatus() {
  return render(
    <DashboardStreamProvider>
      <ConnectionStatus />
    </DashboardStreamProvider>,
  )
}

/** Rendered text including the screen-reader-only part. */
function text(): string {
  return screen.getByRole('status').textContent ?? ''
}

describe('ConnectionStatus', () => {
  it('is a polite status region in every state, so a change is announced without stealing focus', () => {
    renderStatus()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByRole('status')).not.toHaveAttribute('aria-live', 'assertive')
  })

  it('says "Connecting" while the first connection opens', () => {
    renderStatus()
    expect(text()).toContain('Connecting')
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'connecting')
  })

  it('says "Live" once connected, and what that means for the figures', () => {
    renderStatus()
    act(() => FakeEventSource.latest.open())
    expect(text()).toContain('Live')
    expect(text()).toContain('Figures update as payments arrive.')
  })

  it('says "Reconnecting" and warns that the figures may be out of date — in words, not in a colour', () => {
    renderStatus()
    act(() => FakeEventSource.latest.open())
    act(() => FakeEventSource.latest.error())

    expect(text()).toContain('Reconnecting')
    expect(text()).toMatch(/figures may be out of date/i)
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'reconnecting')
  })

  it('says "Offline" when the browser has no network', () => {
    renderStatus()
    act(() => FakeEventSource.latest.open())
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    expect(text()).toContain('Offline')
    expect(text()).toMatch(/no connection/i)
  })

  it('draws a different shape for each state, hidden from assistive tech because the words already say it', () => {
    const { container } = renderStatus()
    const icon = () => container.querySelector('svg')

    const connecting = icon()?.innerHTML
    expect(icon()).toHaveAttribute('aria-hidden', 'true')

    act(() => FakeEventSource.latest.open())
    const live = icon()?.innerHTML
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    const offline = icon()?.innerHTML

    expect(new Set([connecting, live, offline]).size).toBe(3)
  })

  it('uses no payment colour: not green, amber or red', () => {
    const { container } = renderStatus()
    act(() => FakeEventSource.latest.open())
    expect(container.innerHTML).not.toMatch(/success|warning|danger|green|amber|red/)
  })

  it('turns the busy ring only for people who have not asked for less motion', () => {
    const { container } = renderStatus()
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin')
  })

  describe('when the session ends while the page is open', () => {
    async function expireSession() {
      sessionIs('expired')
      renderStatus()
      act(() => FakeEventSource.latest.open())
      act(() => FakeEventSource.latest.error())
      await waitFor(() => expect(screen.getByRole('status')).toHaveAttribute('data-status', 'signed-out'))
    }

    it('says "Signed out" — not "Reconnecting" forever — and that the figures may be out of date', async () => {
      await expireSession()
      expect(text()).toContain('Signed out')
      expect(text()).toMatch(/session has ended|session has expired/i)
      expect(text()).toMatch(/figures may be out of date/i)
      expect(text()).not.toContain('Reconnecting')
    })

    it('offers sign-in that brings the merchant back to this very page', async () => {
      await expireSession()
      const link = screen.getByRole('link', { name: /sign in/i })
      expect(link).toHaveAttribute('href', '/login?next=%2Fdashboard%2Flinks%2FaBcDeFgH')
    })

    it('encodes the page it returns to, so it rides in the query as one value', async () => {
      navigation.pathname = '/dashboard/links/a%20b%26next%3D'
      await expireSession()
      const href = screen.getByRole('link', { name: /sign in/i }).getAttribute('href') ?? ''
      expect(href).toBe(`/login?next=${encodeURIComponent('/dashboard/links/a%20b%26next%3D')}`)
      expect(new URL(href, 'http://kobolink.test').searchParams.get('next')).toBe('/dashboard/links/a%20b%26next%3D')
    })

    it('never sends the visitor anywhere but this app: a path that is not same-origin falls back to the dashboard', async () => {
      navigation.pathname = '//evil.example/steal'
      await expireSession()
      expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login?next=%2Fdashboard')
    })

    it('keeps the link out of the polite status region, so a screen reader hears the change and reaches the link by tabbing', async () => {
      await expireSession()
      expect(within(screen.getByRole('status')).queryByRole('link')).toBeNull()
      expect(screen.getByRole('status')).not.toHaveAttribute('aria-live', 'assertive')
    })

    it('does not take focus', async () => {
      await expireSession()
      expect(document.body).toHaveFocus()
    })

    it('gives the signed-out state its own shape and keeps payment colours out', async () => {
      const { container } = renderStatus()
      act(() => FakeEventSource.latest.open())
      const live = container.querySelector('svg')?.innerHTML
      sessionIs('expired')
      act(() => FakeEventSource.latest.error())
      await waitFor(() => expect(screen.getByRole('status')).toHaveAttribute('data-status', 'signed-out'))
      expect(container.querySelector('svg')?.innerHTML).not.toBe(live)
      expect(container.innerHTML).not.toMatch(/success|warning|danger|green|amber|red/)
    })

    it('does not leave a sign-in link behind once the stream is fine again', () => {
      renderStatus()
      act(() => FakeEventSource.latest.open())
      expect(screen.queryByRole('link')).toBeNull()
    })
  })

  describe('when the account is not a merchant (the stream answers 403)', () => {
    async function connectAsCustomer() {
      sessionIs('customer')
      renderStatus()
      act(() => FakeEventSource.latest.error())
      await waitFor(() => expect(screen.getByRole('status')).toHaveAttribute('data-status', 'stopped'))
    }

    it('says updates have stopped, instead of "Reconnecting… Updates paused" beside a 403 notice', async () => {
      await connectAsCustomer()
      expect(text()).toContain('Updates stopped')
      expect(text()).not.toContain('Reconnecting')
      expect(text()).not.toMatch(/paused/i)
    })

    it('offers no sign-in (it would change nothing) and opens no further connection', async () => {
      await connectAsCustomer()
      expect(screen.queryByRole('link')).toBeNull()
      const opened = FakeEventSource.instances.length
      await new Promise((resolve) => setTimeout(resolve, 1_300)) // past the first backoff
      expect(FakeEventSource.instances).toHaveLength(opened)
    })
  })

  it('an unreachable API is still just "Reconnecting" — only a definite answer ends the retries', async () => {
    sessionIs('unreachable')
    renderStatus()
    act(() => FakeEventSource.latest.open())
    act(() => FakeEventSource.latest.error())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'reconnecting')
  })
})
