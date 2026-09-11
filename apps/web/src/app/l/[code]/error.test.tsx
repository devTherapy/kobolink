import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import CheckoutError from './error'

/**
 * Item 2's own "done when": an API outage or 500 during SSR must render a
 * titled page that names what went wrong, states "No money has moved", and
 * offers retry — not Next's blank "Application error". Next's `error.tsx`
 * boundary is itself a plain client component with an `{ error, reset }`
 * prop pair, so it is testable directly without any Next test harness.
 */
describe('CheckoutError', () => {
  it('names what went wrong, states no money has moved, and offers retry', () => {
    const reset = vi.fn()
    render(<CheckoutError error={new Error('boom')} reset={reset} />)

    expect(screen.getByRole('heading', { name: /couldn.t load this payment link/i })).toBeInTheDocument()
    expect(screen.getByText(/no money has moved/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('calls reset() when "Try again" is pressed', async () => {
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<CheckoutError error={new Error('boom')} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('moves focus to the heading on mount', () => {
    render(<CheckoutError error={new Error('boom')} reset={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /couldn.t load this payment link/i })).toHaveFocus()
  })

  it('marks the message region as an assertive alert', () => {
    render(<CheckoutError error={new Error('boom')} reset={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
