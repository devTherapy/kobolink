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
})
