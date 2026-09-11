import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('renders the label and fires onClick by default (default state)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save link</Button>)

    const button = screen.getByRole('button', { name: 'Save link' })
    await user.click(button)

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('is reachable by keyboard and shows the focus-visible ring (focus state)', async () => {
    const user = userEvent.setup()
    render(<Button>Focus me</Button>)

    await user.tab()

    const button = screen.getByRole('button', { name: 'Focus me' })
    expect(button).toHaveFocus()
    expect(button.className).toMatch(/focus-visible:outline/)
  })

  it('carries hover and active classes for their CSS states', () => {
    render(<Button>Hover me</Button>)
    const button = screen.getByRole('button', { name: 'Hover me' })
    expect(button.className).toMatch(/hover:/)
    expect(button.className).toMatch(/active:/)
  })

  it('blocks clicks and reports disabled to assistive tech (disabled state)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Disabled
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Disabled' })
    expect(button).toBeDisabled()

    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps the label for width, sets aria-busy, and blocks clicks while loading (loading state)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button status="loading" onClick={onClick}>
        Pay now
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Pay now' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('data-loading', 'true')
    expect(button).toBeDisabled()
    expect(screen.getByText('Pay now')).toBeInTheDocument()

    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('flags the error state without disabling the retry (error state)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button status="error" onClick={onClick}>
        Retry
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Retry' })
    expect(button).toHaveAttribute('data-error', 'true')
    expect(button).not.toBeDisabled()

    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('meets the 44px touch-target floor at every size', () => {
    render(
      <>
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg">Large</Button>
      </>,
    )
    for (const name of ['Small', 'Medium', 'Large']) {
      const button = screen.getByRole('button', { name })
      expect(button.className).toMatch(/h-(11|12)/)
    }
  })

  it('renders every variant without throwing', () => {
    const variants = ['primary', 'secondary', 'ghost', 'danger'] as const
    for (const variant of variants) {
      render(<Button variant={variant}>{variant}</Button>)
    }
    for (const variant of variants) {
      expect(screen.getByRole('button', { name: variant })).toBeInTheDocument()
    }
  })
})
