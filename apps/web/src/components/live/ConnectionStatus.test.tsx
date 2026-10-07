import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource } from '@/test/fake-event-source'
import { ConnectionStatus } from './ConnectionStatus'
import { DashboardStreamProvider } from './DashboardStreamProvider'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

beforeEach(() => {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
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
})
