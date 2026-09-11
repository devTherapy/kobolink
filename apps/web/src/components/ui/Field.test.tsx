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

  it('carries the exact hover and active border classes for their CSS states', () => {
    render(<TextField />)
    const input = screen.getByLabelText('Title')
    expect(input.className).toMatch(/hover:border-\(--color-ink-2\)/)
    expect(input.className).toMatch(/active:border-\(--color-brand\)/)
  })

  it('blocks typing and reports disabled (disabled state)', async () => {
    const user = userEvent.setup()
    render(<TextField disabled />)

    const input = screen.getByLabelText('Title')
    expect(input).toBeDisabled()

    await user.type(input, 'x')
    expect(input).toHaveValue('')
  })

  it('blocks typing and reports busy while loading, on the input itself (loading state)', async () => {
    const user = userEvent.setup()
    render(<TextField loading />)

    const input = screen.getByLabelText('Title')
    expect(input).toBeDisabled()
    expect(input).toHaveAttribute('data-loading', 'true')
    expect(input).toHaveAttribute('aria-busy', 'true')

    await user.type(input, 'x')
    expect(input).toHaveValue('')
  })

  it('gives loading a visible skeleton shape distinct from plain disabled, not a transparent-on-transparent fill', () => {
    render(<TextField disabled />)
    // Only `data-loading` (not `:disabled`) drives the skeleton look, so a
    // merely-disabled field — nothing in flight — never gets it.
    expect(screen.getByLabelText('Title')).not.toHaveAttribute('data-loading')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    render(<TextField loading />)
    const loading = screen.getAllByLabelText('Title').at(-1)
    expect(loading).toHaveAttribute('data-loading', 'true')
    // The input's own (possibly stale) text is hidden…
    expect(loading?.className).toMatch(/data-loading:text-transparent/)
    // …but a real, visible, pulsing skeleton line is drawn over it — not a
    // fill-on-fill trick that reads as a blank rectangle.
    const skeleton = screen.getByRole('status')
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
    expect(skeleton.className).toMatch(/animate-pulse/)
    expect(skeleton.className).toMatch(/color-skeleton-fill/)
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

  it('never emits hover/active classes alongside the error border, so pointer states cannot cover it (error state)', () => {
    // jsdom doesn't apply `:hover`/`:active` pseudo-classes, so the cascade
    // itself can't be exercised here — Tailwind emits variant utilities
    // after plain ones, so `hover:border-ink-2`/`active:border-brand` would
    // outrank a same-specificity `border-danger` the instant the pointer
    // entered the field. The fix is to never emit those classes at all on
    // an invalid field, which this asserts directly on the class list.
    render(<TextField error="Title is required" />)
    const invalid = screen.getByLabelText('Title', { exact: false })
    expect(invalid.className).toMatch(/border-\(--color-danger\)/)
    expect(invalid.className).not.toMatch(/hover:border/)
    expect(invalid.className).not.toMatch(/active:border/)

    // A valid field keeps both, proving this is error-gated, not removed
    // outright.
    render(<TextField />)
    const valid = screen.getAllByLabelText('Title', { exact: false }).at(-1)!
    expect(valid.className).toMatch(/hover:border/)
    expect(valid.className).toMatch(/active:border/)
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

  it('does not wipe an unparseable intermediate value ("10.") when the parent ignores null commits', async () => {
    const user = userEvent.setup()

    // A caller that only commits *validated* amounts — e.g. validating on
    // submit, not every keystroke — never updates its own state (and so
    // never changes the `valueKobo` prop) on an intermediate `null`.
    function IgnoresNullHarness() {
      const [kobo, setKobo] = useState<number | null>(null)
      return (
        <Field
          variant="amount"
          label="Amount"
          valueKobo={kobo}
          onChangeKobo={(next) => {
            if (next !== null) setKobo(next)
          }}
        />
      )
    }
    render(<IgnoresNullHarness />)

    const input = screen.getByLabelText('Amount')
    await user.type(input, '10.')

    // "10" committed (kobo=1000); the trailing "." doesn't parse, so the
    // parent's state — and the `valueKobo` prop it echoes back — never
    // moves past 1000. The field must not "correct" its own live text back
    // to "10.00" just because the prop didn't follow the latest keystroke.
    expect(input).toHaveValue('10.')
  })

  // A caller that echoes *every* emission straight back into its own state,
  // including `null` — the shape the kit's own `field-examples.tsx` and a
  // plain `useState` round-trip both use, and the shape round 1's fix
  // (resync-baseline-skips-null) broke: an echoed `null` looked like a
  // stale, unreconciled baseline and forced a reformat mid-typing.
  function EchoingHarness() {
    const [kobo, setKobo] = useState<number | null>(null)
    return <Field variant="amount" label="Amount" valueKobo={kobo} onChangeKobo={setKobo} />
  }

  it('does not wipe "10." when the parent echoes every commit, including null', async () => {
    const user = userEvent.setup()
    render(<EchoingHarness />)
    await user.type(screen.getByLabelText('Amount'), '10.')
    expect(screen.getByLabelText('Amount')).toHaveValue('10.')
  })

  it('keeps a fully-typed "10.50" intact through an echoing parent', async () => {
    const user = userEvent.setup()
    render(<EchoingHarness />)
    await user.type(screen.getByLabelText('Amount'), '10.50')
    expect(screen.getByLabelText('Amount')).toHaveValue('10.50')
  })

  it('keeps an invalid "5x" on screen through an echoing parent, erroring only on blur', async () => {
    const user = userEvent.setup()
    render(<EchoingHarness />)
    const input = screen.getByLabelText('Amount')
    await user.type(input, '5x')
    expect(input).toHaveValue('5x')

    // onBlur only reformats a *parseable* value (see the handler below) —
    // "5x" stays exactly as typed, which is what lets a caller show a
    // validation error beside it.
    await user.tab()
    expect(input).toHaveValue('5x')
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
