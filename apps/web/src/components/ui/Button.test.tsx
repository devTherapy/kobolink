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

  it('carries the primary variant\'s exact hover and active classes for their CSS states', () => {
    render(<Button>Hover me</Button>)
    const button = screen.getByRole('button', { name: 'Hover me' })
    expect(button.className).toMatch(/hover:bg-\(--color-brand-hover\)/)
    expect(button.className).toMatch(/active:brightness-90/)
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

  it('keeps the label in the a11y tree, reports busy, and blocks clicks while loading (loading state)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button status="loading" onClick={onClick}>
        Pay now
      </Button>,
    )

    // Not native `disabled`: a natively-disabled button can't hold focus, so
    // a click that puts the button into `status="loading"` mid-interaction
    // would drop focus to <body> for a keyboard user. `aria-disabled` +
    // `aria-busy` communicate the same "not currently actionable" state
    // without taking the element out of the focus order.
    const button = screen.getByRole('button', { name: 'Pay now' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('data-loading', 'true')
    expect(button).not.toBeDisabled()
    // `opacity-0`, not `visibility:hidden` — the label stays queryable by
    // role/name, proving it never left the accessibility tree.
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeInTheDocument()

    button.focus()
    expect(button).toHaveFocus()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })

  it('flags the error state with a described reason, not colour alone, without disabling the retry (error state)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button status="error" errorMessage="Payment failed — no charge was made" onClick={onClick}>
        Retry
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Retry' })
    expect(button).toHaveAttribute('data-error', 'true')
    expect(button).not.toBeDisabled()

    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent('Payment failed — no charge was made')

    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('gives status="error" a default accessible reason even when the caller passes none', () => {
    render(<Button status="error">Retry</Button>)
    const button = screen.getByRole('button', { name: 'Retry' })
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).not.toBe('')
  })

  it("uses the surface prop so the error ring's offset matches the page it sits on", () => {
    render(
      <Button status="error" surface="surface">
        Retry
      </Button>,
    )
    expect(screen.getByRole('button', { name: 'Retry' }).className).toMatch(/ring-offset-\(--color-surface\)/)
  })

  it('meets the 44px touch-target floor and has a touch-manipulation tap target at every size', () => {
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
      expect(button.className).toMatch(/touch-manipulation/)
    }
  })

  it('gives each variant a visually distinguishing class, not just a differently-labelled identical button', () => {
    const expectedByVariant = {
      primary: /bg-\(--color-brand\)/,
      secondary: /bg-\(--color-surface\)/,
      ghost: /bg-transparent/,
      danger: /bg-\(--color-danger\)/,
    } as const

    for (const variant of Object.keys(expectedByVariant) as (keyof typeof expectedByVariant)[]) {
      render(<Button variant={variant}>{variant}</Button>)
    }
    for (const [variant, expectedClass] of Object.entries(expectedByVariant)) {
      expect(screen.getByRole('button', { name: variant }).className).toMatch(expectedClass)
    }
  })
})
