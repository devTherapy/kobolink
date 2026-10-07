import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Checkbox } from './Checkbox'

function Controlled({ onChange }: { onChange?: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(false)
  return (
    <Checkbox
      label="Reusable"
      hint="Anyone can pay more than once."
      checked={checked}
      onChange={(next) => {
        onChange?.(next)
        setChecked(next)
      }}
    />
  )
}

describe('Checkbox — default / focus / active', () => {
  it('toggles with a click on the label text, not just the 20px box', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    await user.click(screen.getByText('Reusable'))

    expect(screen.getByRole('checkbox', { name: 'Reusable' })).toBeChecked()
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('toggles with Space once reached by Tab, and shows a focus-visible ring class', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    await user.tab()
    const box = screen.getByRole('checkbox')
    expect(box).toHaveFocus()
    expect(box.className).toContain('focus-visible:outline-2')

    await user.keyboard(' ')
    expect(box).toBeChecked()
  })

  it('keeps the hint out of the accessible name but in the description', () => {
    render(<Checkbox label="Reusable" hint="Anyone can pay more than once." checked={false} onChange={vi.fn()} />)
    const box = screen.getByRole('checkbox', { name: 'Reusable' })
    expect(box).toHaveAccessibleDescription('Anyone can pay more than once.')
  })
})

describe('Checkbox — hover and active styles', () => {
  it('declares hover and active border styles while interactive', () => {
    render(<Checkbox label="Reusable" checked={false} onChange={vi.fn()} />)
    const { className } = screen.getByRole('checkbox')
    expect(className).toContain('hover:border-(--color-ink-2)')
    expect(className).toContain('active:border-(--color-brand)')
  })

  it('drops hover/active when invalid or disabled so they cannot out-rank the error border', () => {
    const { rerender } = render(<Checkbox label="Reusable" checked={false} onChange={vi.fn()} error="Required" />)
    expect(screen.getByRole('checkbox').className).not.toContain('hover:border')
    rerender(<Checkbox label="Reusable" checked={false} onChange={vi.fn()} disabled />)
    expect(screen.getByRole('checkbox').className).not.toContain('hover:border')
  })
})

describe('Checkbox — disabled / loading', () => {
  it('does not toggle when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Checkbox label="Reusable" checked={false} onChange={onChange} disabled />)

    await user.click(screen.getByText('Reusable'))

    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is disabled and aria-busy while loading', () => {
    render(<Checkbox label="Reusable" checked onChange={vi.fn()} loading />)
    const box = screen.getByRole('checkbox')
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute('aria-busy', 'true')
  })
})

describe('Checkbox — error', () => {
  it('shows the message beside the box, wired to aria-invalid and aria-describedby', () => {
    render(<Checkbox label="Reusable" checked={false} onChange={vi.fn()} error="Choose one." />)
    const box = screen.getByRole('checkbox')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(box).toHaveAccessibleDescription('Choose one.')
    expect(screen.getByRole('alert')).toHaveTextContent('Choose one.')
  })
})
