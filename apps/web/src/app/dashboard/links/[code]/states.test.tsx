import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinkDetailError from './error'
import LinkDetailLoading from './loading'
import LinkNotFound from './not-found'

describe('link detail — loading', () => {
  it('is a skeleton shaped like the page, not a spinner', () => {
    render(<LinkDetailLoading />)

    // The QR placeholder, the URL row, the status switch, and the payments table's real headers.
    expect(screen.getByRole('status', { name: 'Loading QR code' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading link URL' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading status switch' })).toBeInTheDocument()
    for (const header of ['Payer', 'Amount', 'Status', 'Date']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true')
    expect(document.querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(4)
  })
})

describe('link detail — not found', () => {
  it('says the link is missing or not theirs, that nothing changed, and offers the way back', () => {
    render(<LinkNotFound />)

    expect(screen.getByRole('heading', { level: 1, name: /couldn.t find that link/i })).toBeInTheDocument()
    expect(screen.getByText(/isn.t on your account/i)).toBeInTheDocument()
    expect(screen.getByText(/nothing has been changed/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to all links' })).toHaveAttribute('href', '/dashboard')
  })
})

describe('link detail — error', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names what failed, says nothing was lost and no money moved, and offers both next steps', () => {
    render(<LinkDetailError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)

    expect(screen.getByRole('heading', { name: /couldn.t load this link/i })).toBeInTheDocument()
    expect(screen.getByText(/no money\s+has moved/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to all links' })).toHaveAttribute('href', '/dashboard')
  })

  it('moves focus to the heading so the failure is announced and keyboard users start there', () => {
    render(<LinkDetailError error={new Error('boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /couldn.t load this link/i })).toHaveFocus()
  })

  it('retries with retry(), not reset(), which would re-render the failed tree without refetching', async () => {
    const retry = vi.fn()
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<LinkDetailError error={new Error('boom')} retry={retry} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(retry).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })

  it('falls back to reset() when there is no retry()', async () => {
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<LinkDetailError error={new Error('boom')} reset={reset} />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(reset).toHaveBeenCalledTimes(1)
  })
})
