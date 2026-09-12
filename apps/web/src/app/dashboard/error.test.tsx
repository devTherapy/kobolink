import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardError from './error'

/**
 * Next's `error.tsx` boundary is a plain client component with an
 * `{ error, retry, reset }` prop set — testable directly, same shape as
 * `app/l/[code]/error.test.tsx`.
 */
describe('DashboardError', () => {
  // `useEffect` logs the caught error to the console on every mount — real
  // and expected, but noisy in a passing test run.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names what went wrong and offers retry', () => {
    render(<DashboardError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)

    expect(screen.getByRole('heading', { name: /couldn.t load your dashboard/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('calls retry() when "Try again" is pressed, not reset()', async () => {
    const retry = vi.fn()
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<DashboardError error={new Error('boom')} retry={retry} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })

  it('falls back to reset() when retry is not provided', async () => {
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<DashboardError error={new Error('boom')} reset={reset} />)

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
    render(<DashboardError error={new Error('boom')} reset={undefined} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(reload).toHaveBeenCalledTimes(1)
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it('moves focus to the heading on mount', () => {
    render(<DashboardError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /couldn.t load your dashboard/i })).toHaveFocus()
  })

  it('marks the message region as an assertive alert', () => {
    render(<DashboardError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
