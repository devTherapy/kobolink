import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { exampleLink } from '@kobolink/contracts'
import { LinksTable } from './LinksTable'

describe('LinksTable', () => {
  it('renders one row per link: title, description, amount, status, payment count, created date', () => {
    render(<LinksTable links={[exampleLink()]} />)

    expect(screen.getByRole('columnheader', { name: 'Link' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Payments' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument()

    expect(screen.getByText('Ankara Two-Piece Set')).toBeInTheDocument()
    expect(screen.getByText('Size 12, ships within Lagos in 2 days.')).toBeInTheDocument()
    expect(screen.getByText('₦18,500')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2 Jun 2026')).toBeInTheDocument()
  })

  it('renders "Any amount" for an open-amount link rather than ₦0', () => {
    render(<LinksTable links={[exampleLink({ amountKobo: null })]} />)
    expect(screen.getByText('Any amount')).toBeInTheDocument()
  })

  it('badges a disabled link as Disabled, not Active', () => {
    render(<LinksTable links={[exampleLink({ status: 'disabled' })]} />)
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('badges an expired link as Expired even though its stored status is still active', () => {
    render(<LinksTable links={[exampleLink({ expiresAt: '2000-01-01T00:00:00.000Z' })]} />)
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  it('badges an already-paid single-use link as Paid', () => {
    render(<LinksTable links={[exampleLink({ isReusable: false, paymentCount: 1 })]} />)
    expect(screen.getByText('Paid')).toBeInTheDocument()
  })

  it('teaches the interface instead of showing a blank table for a merchant with no links yet', () => {
    render(<LinksTable links={[]} />)
    expect(screen.getByRole('heading', { name: 'No links yet' })).toBeInTheDocument()
    expect(
      screen.getByText('Once you create a payment link, it will show up here with its status and payment count.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Ankara Two-Piece Set')).not.toBeInTheDocument()
  })

  it('has no interactive rows yet — F5 owns link-detail navigation, not this feature', () => {
    render(<LinksTable links={[exampleLink()]} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  // `Table` is an auto-layout <table>: a `truncate` cell with nothing
  // bounding its width in the ancestor chain does not actually clip —
  // its minimum content width becomes the full, untruncated string, and
  // the column grows to fit it instead. `LinkDescriptionSchema` allows up
  // to 500 characters, so a realistic long description is not an edge
  // case this table can ignore. A full pixel-measurement/layout assertion
  // isn't practical in jsdom (no real layout engine), so this proves the
  // concrete thing that makes truncation effective: a bounded `max-w-*`
  // class on the wrapping element, plus the `truncate` class itself —
  // verified visually at 1024/1440 separately against compiled Tailwind.
  it('bounds the Link column width so a realistic long description cannot overflow the table', () => {
    const longDescription =
      'Custom tailoring for a two-piece Ankara set, including consultation, fabric sourcing from Balogun Market, ' +
      'fitting adjustments, and doorstep delivery anywhere within Lagos mainland or island, in production.'
    expect(longDescription.length).toBeGreaterThan(150)

    render(<LinksTable links={[exampleLink({ description: longDescription })]} />)

    const descriptionEl = screen.getByText(longDescription)
    expect(descriptionEl.className).toContain('truncate')

    const wrapper = descriptionEl.closest('div')
    expect(wrapper).not.toBeNull()
    // The specific value matters less than the fact that *something* in the
    // ancestor chain caps the width — that is what gives `truncate`'s
    // overflow-hidden/ellipsis a concrete size to clip against instead of
    // growing the column to the full string width.
    expect(wrapper?.className).toMatch(/max-w-/)
  })
})
