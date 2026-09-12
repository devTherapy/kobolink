import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { exampleStats } from '@kobolink/contracts'
import { StatStrip } from './StatStrip'

describe('StatStrip', () => {
  it('renders the three stats from DashboardStats, money formatted via formatNaira', () => {
    render(<StatStrip stats={exampleStats()} />)

    expect(screen.getByText('Total collected')).toBeInTheDocument()
    // Never a raw `₦${kobo}` template — 5_550_000 kobo is ₦55,500, not ₦5,550,000.
    expect(screen.getByText('₦55,500')).toBeInTheDocument()

    expect(screen.getByText('Payments')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()

    expect(screen.getByText('Active links')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('renders as a definition list — three dt/dd pairs, one per stat', () => {
    render(<StatStrip stats={exampleStats({ totalCollectedKobo: 0, paymentCount: 0, activeLinks: 0 })} />)
    const terms = document.querySelectorAll('dt')
    const values = document.querySelectorAll('dd')
    expect(terms).toHaveLength(3)
    expect(values).toHaveLength(3)
  })

  it('marks every value tabular so the numbers align', () => {
    render(<StatStrip stats={exampleStats()} />)
    for (const dd of document.querySelectorAll('dd')) {
      expect(dd.className).toMatch(/tabular/)
    }
  })
})
