import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutError from './error'

/**
 * Item 2's own "done when": an API outage or 500 during SSR must render a
 * titled page that names what went wrong, states "No money has moved", and
 * offers a retry that actually re-fetches — not Next's blank "Application
 * error". Next's `error.tsx` boundary is itself a plain client component
 * with an `{ error, retry, reset }` prop set, so it is testable directly
 * without any Next test harness.
 */
describe('CheckoutError', () => {
  // `useEffect` logs the caught error to the console on every mount — real
  // and expected, but noisy in a passing test run.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names what went wrong, states no money has moved, and offers retry', () => {
    render(<CheckoutError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)

    expect(screen.getByRole('heading', { name: /couldn.t load this payment link/i })).toBeInTheDocument()
    expect(screen.getByText(/no money has moved/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('renders a <title> naming the failure, since error boundaries cannot export generateMetadata', () => {
    render(<CheckoutError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(document.title).toMatch(/couldn.t load this payment link/i)
  })

  it('calls retry() when "Try again" is pressed, not reset()', async () => {
    const retry = vi.fn()
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<CheckoutError error={new Error('boom')} retry={retry} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })

  it('falls back to reset() when retry is not provided', async () => {
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<CheckoutError error={new Error('boom')} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('falls back to window.location.reload() as a last resort when neither retry nor reset exist', async () => {
    const reload = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    })

    // @ts-expect-error — exercising the defensive branch a well-typed caller
    // (Next itself) never actually triggers.
    render(<CheckoutError error={new Error('boom')} reset={undefined} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(reload).toHaveBeenCalledTimes(1)
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it('moves focus to the heading on mount', () => {
    render(<CheckoutError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /couldn.t load this payment link/i })).toHaveFocus()
  })

  it('marks the message region as an assertive alert', () => {
    render(<CheckoutError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
