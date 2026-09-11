import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Field } from './Field'

interface TextFieldOverrides {
  hint?: string | undefined
  error?: string | undefined
  required?: boolean | undefined
  disabled?: boolean | undefined
  loading?: boolean | undefined
}

function TextField({ hint, error, required, disabled, loading }: TextFieldOverrides = {}) {
  const [value, setValue] = useState('')
  return (
    <Field
      label="Title"
      value={value}
      onChange={setValue}
      hint={hint}
      error={error}
      required={required}
      disabled={disabled}
      loading={loading}
    />
  )
}

function AmountFieldHarness(props: { initialKobo?: number | null } = {}) {
  const [kobo, setKobo] = useState<number | null>(props.initialKobo ?? null)
  return <Field variant="amount" label="Amount" valueKobo={kobo} onChangeKobo={setKobo} />
}

describe('Field', () => {
  it('renders a labelled text input the caller can type into (default state)', async () => {
    const user = userEvent.setup()
    render(<TextField />)

    const input = screen.getByLabelText('Title')
    await user.type(input, 'Ankara set')

    expect(input).toHaveValue('Ankara set')
  })

  it('is reachable by keyboard and shows the focus-visible ring (focus state)', async () => {
    const user = userEvent.setup()
    render(<TextField />)

    await user.tab()

    const input = screen.getByLabelText('Title')
    expect(input).toHaveFocus()
    expect(input.className).toMatch(/focus-visible:outline/)
  })

  it('carries hover and active classes for their CSS states', () => {
    render(<TextField />)
    const input = screen.getByLabelText('Title')
    expect(input.className).toMatch(/hover:/)
    expect(input.className).toMatch(/active:/)
  })

  it('blocks typing and reports disabled (disabled state)', async () => {
    const user = userEvent.setup()
    render(<TextField disabled />)

    const input = screen.getByLabelText('Title')
    expect(input).toBeDisabled()

    await user.type(input, 'x')
    expect(input).toHaveValue('')
  })

  it('blocks typing and reports busy while loading (loading state)', async () => {
    const user = userEvent.setup()
    render(<TextField loading />)

    const input = screen.getByLabelText('Title')
    expect(input).toBeDisabled()
    expect(input).toHaveAttribute('data-loading', 'true')

    await user.type(input, 'x')
    expect(input).toHaveValue('')
  })

  it('gives loading a skeleton-shaped look distinct from plain disabled', () => {
    render(<TextField disabled />)
    // Only `data-loading` (not `:disabled`) drives the skeleton look, so a
    // merely-disabled field — nothing in flight — never gets it.
    expect(screen.getByLabelText('Title')).not.toHaveAttribute('data-loading')

    render(<TextField loading />)
    const loading = screen.getAllByLabelText('Title').at(-1)
    expect(loading).toHaveAttribute('data-loading', 'true')
    // Skeleton-shaped, not just dimmed: a pulsing muted fill with the value
    // hidden, wired via CSS off that attribute.
    expect(loading?.className).toMatch(/data-loading:.*animate-pulse/)
    expect(loading?.className).toMatch(/data-loading:text-transparent/)
  })

  it('wires aria-invalid and aria-describedby to the inline error (error state)', () => {
    render(<TextField error="Title is required" />)

    const input = screen.getByLabelText('Title')
    expect(input).toHaveAttribute('aria-invalid', 'true')

    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent('Title is required')
    expect(describedBy).toContain(error.id)
  })

  it('prefers the error over the hint when both are given, so aria-describedby never dangles', () => {
    render(<TextField hint="Shown to the payer" error="Title is required" />)

    expect(screen.queryByText('Shown to the payer')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Title is required')
  })

  it('marks a required field for assistive tech without a second boolean prop for styling', () => {
    render(<TextField required />)
    expect(screen.getByLabelText('Title', { exact: false })).toBeRequired()
  })
})

describe('Field (amount variant)', () => {
  it('uses inputMode="decimal" and starts blank when no value is set', () => {
    render(<AmountFieldHarness />)
    const input = screen.getByLabelText('Amount')
    expect(input).toHaveAttribute('inputMode', 'decimal')
    expect(input).toHaveValue('')
  })

  it('reports kobo on every keystroke via onChangeKobo', async () => {
    const user = userEvent.setup()
    const onChangeKobo = vi.fn()

    // A real controlled round trip: the parent echoes `valueKobo` back, the
    // same shape `AmountFieldHarness` uses. A prop that never changes (the
    // component's job is to follow it) isn't a meaningful way to exercise
    // "every keystroke reports kobo".
    function Harness() {
      const [kobo, setKobo] = useState<number | null>(null)
      return (
        <Field
          variant="amount"
          label="Amount"
          valueKobo={kobo}
          onChangeKobo={(next) => {
            onChangeKobo(next)
            setKobo(next)
          }}
        />
      )
    }
    render(<Harness />)

    await user.type(screen.getByLabelText('Amount'), '18500')

    expect(onChangeKobo).toHaveBeenLastCalledWith(1_850_000)
  })

  it('reformats through formatNaira on blur, without the currency symbol baked into the value', async () => {
    const user = userEvent.setup()
    render(<AmountFieldHarness />)

    const input = screen.getByLabelText('Amount')
    await user.type(input, '18500')
    await user.tab()

    expect(input).toHaveValue('18,500')
  })

  it('keeps the raw text on blur when it cannot be parsed, and reports null', async () => {
    const user = userEvent.setup()
    const onChangeKobo = vi.fn()
    render(<Field variant="amount" label="Amount" valueKobo={null} onChangeKobo={onChangeKobo} />)

    const input = screen.getByLabelText('Amount')
    await user.type(input, 'abc')
    await user.tab()

    expect(input).toHaveValue('abc')
    expect(onChangeKobo).toHaveBeenLastCalledWith(null)
  })

  it('resyncs the displayed text when valueKobo changes from outside the field', () => {
    const onChangeKobo = vi.fn()
    const { rerender } = render(
      <Field variant="amount" label="Amount" valueKobo={1_850_000} onChangeKobo={onChangeKobo} />,
    )
    expect(screen.getByLabelText('Amount')).toHaveValue('18,500')

    rerender(<Field variant="amount" label="Amount" valueKobo={null} onChangeKobo={onChangeKobo} />)
    expect(screen.getByLabelText('Amount')).toHaveValue('')
  })
})
