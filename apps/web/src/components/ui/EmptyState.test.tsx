import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders a title that teaches what is missing, as an h2 by default', () => {
    render(<EmptyState title="No links yet" body="Create your first payment link to get started." />)

    const heading = screen.getByRole('heading', { name: 'No links yet', level: 2 })
    expect(heading).toBeInTheDocument()
    expect(screen.getByText('Create your first payment link to get started.')).toBeInTheDocument()
  })

  it('fits a deeper outline via the as prop, for a caller nesting it under its own heading', () => {
    render(<EmptyState as="h3" title="No links yet" />)
    expect(screen.getByRole('heading', { name: 'No links yet', level: 3 })).toBeInTheDocument()
  })

  it('renders a composed action that keeps its own full state set', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <EmptyState
        title="No links yet"
        action={<Button onClick={onClick}>Create a link</Button>}
      />,
    )

    const action = screen.getByRole('button', { name: 'Create a link' })
    await user.click(action)

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('omits the icon wrapper when no icon is given', () => {
    render(<EmptyState title="No links yet" />)
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument()
  })

  it('keeps the icon badge neutral, never brand-tinted decoration', () => {
    render(<EmptyState title="No links yet" icon={<span>icon</span>} />)
    const badge = document.querySelector('[aria-hidden="true"]')
    expect(badge?.className).not.toMatch(/color-brand/)
    expect(badge?.className).toMatch(/color-border-soft/)
  })
})
