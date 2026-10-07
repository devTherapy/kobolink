import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatNaira,
  examplePayment,
  exampleLink,
  type DashboardEvent,
  type DashboardStats,
  type PaymentLink,
} from '@kobolink/contracts'
import { LiveDashboard } from '@/components/dashboard/LiveDashboard'
import { RECONNECT_BASE_MS } from '@/lib/dashboard-stream'
import { loadDashboardData } from '@/lib/dashboard'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN } from '@/mocks/handlers'
import { FakeEventSource } from '@/test/fake-event-source'
import { ConnectionStatus } from './ConnectionStatus'
import { DashboardStreamProvider, REFRESH_DEBOUNCE_MS } from './DashboardStreamProvider'

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

/** What `DashboardPage` would have fetched on the server — straight from the MSW handler set. */
async function serverSnapshot(): Promise<{ stats: DashboardStats; links: PaymentLink[] }> {
  const { stats, links } = await loadDashboardData(`${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`)
  return { stats, links: links.items }
}

/** A moment after the server snapshot, so the event is newer than what was rendered. */
function after(stats: DashboardStats, ms = 1_000): string {
  return new Date(Date.parse(stats.asOf) + ms).toISOString()
}

function paymentCompleted(snapshot: { stats: DashboardStats }, reference: string, amountKobo = 1_850_000, ms = 1_000): DashboardEvent {
  return {
    type: 'payment.completed',
    payment: examplePayment({ reference, amountKobo, payerName: 'Ngozi Okafor' }),
    stats: {
      ...snapshot.stats,
      totalCollectedKobo: snapshot.stats.totalCollectedKobo + amountKobo,
      paymentCount: snapshot.stats.paymentCount + 1,
      asOf: after(snapshot.stats, ms),
    },
  }
}

function Page({ stats, links }: { stats: DashboardStats; links: PaymentLink[] }) {
  return (
    <DashboardStreamProvider>
      <ConnectionStatus />
      <LiveDashboard stats={stats} links={links} />
    </DashboardStreamProvider>
  )
}

function stat(label: string): string {
  const term = screen.getByText(label, { selector: 'dt' })
  return term.nextElementSibling?.textContent ?? ''
}

describe('live dashboard', () => {
  beforeEach(() => {
    FakeEventSource.reset()
    router.refresh.mockReset()
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function renderLive() {
    const snapshot = await serverSnapshot()
    vi.useFakeTimers()
    const view = render(<Page {...snapshot} />)
    act(() => {
      FakeEventSource.latest.open()
    })
    return { snapshot, ...view }
  }

  it('opens one stream, and says so: Connecting, then Live', async () => {
    const snapshot = await serverSnapshot()
    vi.useFakeTimers()
    render(<Page {...snapshot} />)

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(screen.getByText('Connecting…')).toBeInTheDocument()

    act(() => {
      FakeEventSource.latest.open()
    })
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('Done when: a payment in another tab moves the numbers without a reload', async () => {
    const { snapshot } = await renderLive()
    expect(stat('Total collected')).toBe('₦55,500')
    expect(stat('Payments')).toBe('3')

    act(() => {
      FakeEventSource.latest.send(paymentCompleted(snapshot, 'kbl_NewPay2AbC'))
    })

    // Already on screen — the refresh below has not run, and no reload happened.
    expect(router.refresh).not.toHaveBeenCalled()
    expect(stat('Total collected')).toBe(formatNaira(5_550_000 + 1_850_000))
    expect(stat('Payments')).toBe('4')
  })

  it('says what arrived to a screen reader too', async () => {
    const { snapshot } = await renderLive()
    act(() => {
      FakeEventSource.latest.send(paymentCompleted(snapshot, 'kbl_NewPay2AbC'))
    })
    expect(screen.getByText('New payment received: ₦18,500 from Ngozi Okafor.')).toBeInTheDocument()
  })

  it('then asks the server for the real numbers — once, however many events arrive together', async () => {
    const { snapshot } = await renderLive()
    act(() => {
      FakeEventSource.latest.send(paymentCompleted(snapshot, 'kbl_NewPay2AbC', 1_850_000, 1_000))
      FakeEventSource.latest.send(paymentCompleted(snapshot, 'kbl_NewPay3AbC', 1_850_000, 1_100))
    })

    act(() => {
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS - 1)
    })
    expect(router.refresh).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it('counts a payment once, however many times it is delivered', async () => {
    const { snapshot } = await renderLive()
    const event = paymentCompleted(snapshot, 'kbl_NewPay2AbC')
    act(() => {
      FakeEventSource.latest.send(event)
      FakeEventSource.latest.send(event)
    })
    act(() => {
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS)
    })

    expect(stat('Payments')).toBe('4')
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it('shows a link created elsewhere at the top of the table', async () => {
    const { snapshot } = await renderLive()
    const created = exampleLink({ code: 'zZzZzZzZ', title: 'Brand New Link', paymentCount: 0, totalPaidKobo: 0 })
    act(() => {
      FakeEventSource.latest.send({
        type: 'link.created',
        link: created,
        stats: { ...snapshot.stats, activeLinks: snapshot.stats.activeLinks + 1, asOf: after(snapshot.stats) },
      })
    })

    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Brand New Link')
    expect(stat('Active links')).toBe('2')
  })

  it('yields to the server: a refresh that delivers newer props shows them, and the event they include is not added on top', async () => {
    const { snapshot, rerender } = await renderLive()
    act(() => {
      FakeEventSource.latest.send(paymentCompleted(snapshot, 'kbl_NewPay2AbC'))
    })
    expect(stat('Payments')).toBe('4')

    // router.refresh() landed: the server now says 4 payments, as of a moment after the event.
    const refreshed = {
      stats: { ...snapshot.stats, totalCollectedKobo: 7_400_000, paymentCount: 4, asOf: after(snapshot.stats, 2_000) },
      links: snapshot.links,
    }
    rerender(<Page {...refreshed} />)

    expect(stat('Payments')).toBe('4')
    expect(stat('Total collected')).toBe('₦74,000')
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  describe('a network blip', () => {
    it('Reconnecting is shown in words, the stream is retried, and when it returns the page re-reads the server', async () => {
      const { snapshot } = await renderLive()

      act(() => {
        FakeEventSource.latest.error()
      })
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
      expect(screen.getByText(/figures may be out of date/i)).toBeInTheDocument()
      expect(screen.queryByText('Live')).not.toBeInTheDocument()
      expect(router.refresh).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(RECONNECT_BASE_MS)
      })
      expect(FakeEventSource.instances).toHaveLength(2)
      act(() => {
        FakeEventSource.latest.open()
      })
      expect(screen.getByText('Live')).toBeInTheDocument()

      // Whatever was paid while disconnected never came down the stream: ask the server.
      act(() => {
        vi.advanceTimersByTime(0)
      })
      expect(router.refresh).toHaveBeenCalledTimes(1)

      // And the new connection delivers.
      act(() => {
        FakeEventSource.latest.send(paymentCompleted(snapshot, 'kbl_AfterBkpAb'))
      })
      expect(stat('Payments')).toBe('4')
    })

    it('goes Offline when the browser does, and reconnects when it is back', async () => {
      await renderLive()

      act(() => {
        window.dispatchEvent(new Event('offline'))
      })
      expect(screen.getByText('Offline')).toBeInTheDocument()
      expect(FakeEventSource.latest.closed).toBe(true)

      act(() => {
        window.dispatchEvent(new Event('online'))
      })
      expect(FakeEventSource.instances).toHaveLength(2)
      act(() => {
        FakeEventSource.latest.open()
      })
      expect(screen.getByText('Live')).toBeInTheDocument()
    })
  })

  it('unmounting closes the stream and cancels a pending refresh', async () => {
    const { snapshot, unmount } = await renderLive()
    const source = FakeEventSource.latest
    act(() => {
      source.send(paymentCompleted(snapshot, 'kbl_NewPay2AbC'))
    })

    unmount()
    expect(source.closed).toBe(true)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(router.refresh).not.toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('live dashboard without a stream', () => {
  it('renders exactly what the server rendered when there is no provider around it', async () => {
    const snapshot = await serverSnapshot()
    render(<LiveDashboard {...snapshot} />)
    expect(stat('Total collected')).toBe('₦55,500')
    expect(screen.getByText('Ankara Two-Piece Set')).toBeInTheDocument()
  })
})
