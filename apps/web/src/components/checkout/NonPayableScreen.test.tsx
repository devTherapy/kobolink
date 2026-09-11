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
})
