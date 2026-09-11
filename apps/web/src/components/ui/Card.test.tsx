import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card } from './Card'

describe('Card', () => {
  it('renders its children inside a bordered, shadowed surface', () => {
    render(<Card>Link summary</Card>)
    const card = screen.getByText('Link summary')
    expect(card.className).toMatch(/rounded-\(--radius-card\)/)
    expect(card.className).toMatch(/shadow-\(--shadow-card\)/)
  })

  it('renders as the requested semantic tag', () => {
    render(<Card as="article">Content</Card>)
    expect(screen.getByText('Content').tagName).toBe('ARTICLE')
  })

  it('omits padding when asked, for a Card that wraps something that pads itself', () => {
    render(<Card padding="none">Table goes here</Card>)
    expect(screen.getByText('Table goes here').className).not.toMatch(/\bp-4\b/)
  })
})
