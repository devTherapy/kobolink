import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GlobalError from './error'

/**
 * The root error boundary — the safety net for any route that does not have
 * its own more specific `error.tsx` (see `app/l/[code]/error.tsx` for the
 * checkout route's). Deliberately generic copy: this boundary can be reached
 * from routes that never move money at all, so unlike the checkout one it
 * makes no claim about payments.
 */
describe('GlobalError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders a titled page with a retry action instead of a blank error page', () => {
    render(<GlobalError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('renders a <title>, since error boundaries cannot export generateMetadata', () => {
    render(<GlobalError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(document.title).toMatch(/something went wrong/i)
  })

  it('calls retry() when "Try again" is pressed, not reset()', async () => {
    const retry = vi.fn()
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<GlobalError error={new Error('boom')} retry={retry} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })

  it('falls back to reset() when retry is not provided', async () => {
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<GlobalError error={new Error('boom')} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
