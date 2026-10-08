import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './Switch'

describe('Switch — the seven states', () => {
  it('default: a labelled switch whose aria-checked mirrors `checked`', () => {
    const { rerender } = render(
      <Switch checked={false} onCheckedChange={vi.fn()}>
        Accepting payments
      </Switch>,
    )
    const toggle = screen.getByRole('switch', { name: 'Accepting payments' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    rerender(
      <Switch checked onCheckedChange={vi.fn()}>
        Accepting payments
      </Switch>,
    )
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('asks for the opposite value on click — it never flips itself', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <Switch checked onCheckedChange={onCheckedChange}>
        Accepting payments
      </Switch>,
    )

    await user.click(screen.getByRole('switch'))

    expect(onCheckedChange).toHaveBeenCalledWith(false)
    // Controlled: with no owner updating `checked`, it stays where it was.
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('focus: reachable by Tab, and Space and Enter both toggle it', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <Switch checked={false} onCheckedChange={onCheckedChange}>
        Accepting payments
      </Switch>,
    )

    await user.tab()
    expect(screen.getByRole('switch')).toHaveFocus()
    expect(screen.getByRole('switch').className).toMatch(/focus-visible:outline-2/)

    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(onCheckedChange).toHaveBeenCalledTimes(2)
  })

  it('hover and active: styled off real pseudo-classes, not extra props', () => {
    render(
      <Switch checked onCheckedChange={vi.fn()}>
        Accepting payments
      </Switch>,
    )
    const track = screen.getByRole('switch').firstElementChild as HTMLElement
    expect(track.className).toMatch(/group-hover:/)
    expect((track.firstElementChild as HTMLElement).className).toMatch(/group-active:/)
  })

  it('disabled: native disabled — no click reaches the owner, and it leaves the tab order', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <Switch checked onCheckedChange={onCheckedChange} disabled>
        Accepting payments
      </Switch>,
    )

    expect(screen.getByRole('switch')).toBeDisabled()
    await user.click(screen.getByRole('switch'))
    await user.tab()
    expect(onCheckedChange).not.toHaveBeenCalled()
    expect(screen.getByRole('switch')).not.toHaveFocus()
  })

  it('loading: busy and aria-disabled but still focusable, and a click is swallowed', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <Switch checked onCheckedChange={onCheckedChange} status="loading">
        Accepting payments
      </Switch>,
    )
    const toggle = screen.getByRole('switch')

    expect(toggle).toHaveAttribute('aria-busy', 'true')
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(toggle).not.toBeDisabled()

    await user.tab()
    expect(toggle).toHaveFocus()
    await user.keyboard(' ')
    await user.click(toggle)
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it('error: marks itself with data-error and keeps the owner-supplied description', () => {
    render(
      <>
        <Switch checked onCheckedChange={vi.fn()} status="error" aria-describedby="why">
          Accepting payments
        </Switch>
        <p id="why">We could not turn this link off.</p>
      </>,
    )
    const toggle = screen.getByRole('switch')

    expect(toggle).toHaveAttribute('data-error', 'true')
    expect(toggle).toHaveAccessibleDescription('We could not turn this link off.')
    // An errored switch is still operable: the point is to try again.
    expect(toggle).not.toBeDisabled()
  })
})
