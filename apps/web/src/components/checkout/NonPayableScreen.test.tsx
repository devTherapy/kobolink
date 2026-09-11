import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { exampleLink, toPublicLink } from '@kobolink/contracts'
import { NonPayableScreen } from './NonPayableScreen'

const link = toPublicLink(exampleLink())

describe('NonPayableScreen', () => {
  it.each([
    ['disabled', /turned off/i],
    ['expired', /expired/i],
    ['already-paid', /already been paid/i],
  ] as const)('names what happened for "%s" and says no money moved', (state, headingPattern) => {
    render(<NonPayableScreen state={state} link={link} />)

    expect(screen.getByRole('heading', { name: headingPattern })).toBeInTheDocument()
    expect(screen.getByText(/no money has moved/i)).toBeInTheDocument()
    // The next step: every state offers a way forward, not just a dead end.
    expect(screen.getByRole('link', { name: 'Go to Kobolink' })).toBeInTheDocument()
  })

  it('names the merchant so the payer knows who to ask', () => {
    render(<NonPayableScreen state="disabled" link={link} />)
    expect(screen.getAllByText('Adebayo Stores').length).toBeGreaterThan(0)
  })

  it('renders neutral copy for a null state instead of fabricating a merchant action', () => {
    render(<NonPayableScreen state={null} link={link} />)

    expect(screen.getByRole('heading', { name: 'This link cannot be paid right now' })).toBeInTheDocument()
    expect(screen.queryByText(/turned off/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/already been (paid|used)/i)).not.toBeInTheDocument()
    expect(screen.getByText(/no money has moved/i)).toBeInTheDocument()
  })

  it('exposes the container as a status region', () => {
    render(<NonPayableScreen state="disabled" link={link} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('moves focus to the heading when autoFocus is set (the PayForm swap case)', () => {
    render(<NonPayableScreen state="disabled" link={link} headingLevel="h2" autoFocus />)
    expect(screen.getByRole('heading', { name: /turned off/i })).toHaveFocus()
  })

  it('does not steal focus on the initial page-load render (autoFocus unset)', () => {
    render(<NonPayableScreen state="disabled" link={link} />)
    expect(screen.getByRole('heading', { name: /turned off/i })).not.toHaveFocus()
  })
})
