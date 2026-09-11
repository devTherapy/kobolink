import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('block: announces busy status', () => {
    render(<Skeleton shape="block" aria-label="Loading card" />)
    const status = screen.getByRole('status', { name: 'Loading card' })
    expect(status).toHaveAttribute('aria-busy', 'true')
  })

  it('line: announces busy status and defaults to full width', () => {
    render(<Skeleton shape="line" aria-label="Loading title" />)
    const status = screen.getByRole('status', { name: 'Loading title' })
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveStyle({ width: '100%' })
  })

  it('respects prefers-reduced-motion via motion-safe:, never a bare animate-pulse', () => {
    render(<Skeleton shape="line" />)
    const status = screen.getByRole('status')
    expect(status.className).toMatch(/motion-safe:animate-pulse/)
    expect(status.className).not.toMatch(/(?<!motion-safe:)animate-pulse/)
  })

  it('table-row: renders one placeholder cell per column, hidden from assistive tech', () => {
    render(
      <table>
        <tbody>
          <Skeleton shape="table-row" columns={3} />
        </tbody>
      </table>,
    )
    const row = document.querySelector('tr')
    expect(row).toHaveAttribute('aria-hidden', 'true')
    expect(row?.querySelectorAll('td')).toHaveLength(3)
  })
})
