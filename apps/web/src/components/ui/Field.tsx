import type { InputHTMLAttributes } from 'react'
import { useId, useState } from 'react'
import { formatNaira, parseNaira } from '@kobolink/contracts'
import { cn } from './cn'

interface FieldSharedProps {
  label: string
  hint?: string | undefined
  /** Rendered as the inline error, and wired to `aria-invalid`/`aria-describedby`. */
  error?: string | undefined
  required?: boolean | undefined
  disabled?: boolean | undefined
  /** Field-level loading — e.g. an async default being fetched. Disables input. */
  loading?: boolean | undefined
  id?: string | undefined
  name?: string | undefined
  placeholder?: string | undefined
  autoComplete?: InputHTMLAttributes<HTMLInputElement>['autoComplete']
}

export interface FieldTextProps extends FieldSharedProps {
  variant?: 'text'
  type?: 'text' | 'email' | 'tel' | undefined
  value: string
  onChange: (value: string) => void
}

export interface FieldAmountProps extends FieldSharedProps {
  variant: 'amount'
  /** Kobo, never naira — the field is the boundary where a human's typed
      naira string turns into the integer the rest of the app passes around. */
  valueKobo: number | null
  onChangeKobo: (kobo: number | null) => void
}

export type FieldProps = FieldTextProps | FieldAmountProps

/**
 * Seven states: default (base classes) · hover (`hover:border`) · focus
 * (`focus-visible:` ring, native to `<input>`) · active (`active:border`) ·
 * disabled (native `disabled`, also implied by `loading`) · loading
 * (`aria-busy` + `data-loading`, disables the input) · error (`aria-invalid`
 * + `aria-describedby` pointing at the message rendered beside the input).
 */
export function Field(props: FieldProps) {
  const autoId = useId()
  const id = props.id ?? autoId
  const hasError = Boolean(props.error)
  const showHint = Boolean(props.hint) && !hasError
  const hintId = showHint ? `${id}-hint` : undefined
  const errorId = hasError ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  const isDisabled = props.disabled === true || props.loading === true

  const inputClassName = cn(
    'h-11 w-full rounded-(--radius-input) border bg-(--color-surface) px-3 text-[14px] text-(--color-ink) outline-none transition-colors',
    'placeholder:text-(--color-ink-3)',
    'hover:border-(--color-ink-3)',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)',
    'active:border-(--color-brand)',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-(--color-border)',
    // Loading is a skeleton shaped like the content (§11), not just a dimmed
    // disabled field — a pulsing muted fill with the value's text hidden, so
    // it reads as "something is being fetched" rather than "locked". Scoped
    // to `data-loading`, not `:disabled`, so a plain disabled field (nothing
    // in flight) keeps its plain dimmed look.
    'data-loading:motion-safe:animate-pulse data-loading:border-(--color-border-soft) data-loading:bg-(--color-border-soft) data-loading:text-transparent data-loading:placeholder:text-transparent',
    hasError ? 'border-(--color-danger)' : 'border-(--color-border)',
  )

  return (
    <div className="flex flex-col gap-1.5" data-loading={props.loading === true || undefined}>
      <label htmlFor={id} className="text-[13px] font-medium text-(--color-ink-2)">
        {props.label}
        {props.required ? (
          <span aria-hidden="true" className="text-(--color-danger)">
            {' '}
            *
          </span>
        ) : null}
      </label>

      {props.variant === 'amount' ? (
        <AmountField
          id={id}
          name={props.name}
          placeholder={props.placeholder}
          valueKobo={props.valueKobo}
          onChangeKobo={props.onChangeKobo}
          disabled={isDisabled}
          required={props.required}
          hasError={hasError}
          describedBy={describedBy}
          loading={props.loading}
          className={inputClassName}
        />
      ) : (
        <input
          id={id}
          name={props.name}
          type={props.type ?? 'text'}
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value)
          }}
          placeholder={props.placeholder}
          disabled={isDisabled}
          required={props.required}
          autoComplete={props.autoComplete}
          // Emails, codes and usernames don't want the browser's spellcheck
          // squiggle; a free-text title or name field does.
          spellCheck={props.type === 'email' ? false : undefined}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          data-loading={props.loading === true || undefined}
          className={inputClassName}
        />
      )}

      {showHint ? (
        <p id={hintId} className="text-[13px] text-(--color-ink-3)">
          {props.hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} role="alert" className="text-[13px] text-(--color-danger)">
          {props.error}
        </p>
      ) : null}
    </div>
  )
}

interface AmountFieldProps {
  id: string
  name?: string | undefined
  placeholder?: string | undefined
  valueKobo: number | null
  onChangeKobo: (kobo: number | null) => void
  disabled: boolean
  required?: boolean | undefined
  hasError: boolean
  describedBy?: string | undefined
  loading?: boolean | undefined
  className: string
}

/**
 * Kobo in, kobo out. The input shows a naira string; `parseNaira` turns it
 * back into kobo on every keystroke (so the caller always has the payer's
 * latest intent, `null` while it's unparseable) and `formatNaira` re-renders
 * the canonical form on blur, matching the brief: "formats via contracts
 * parseNaira/formatNaira on blur, storing kobo."
 */
function AmountField({
  id,
  name,
  placeholder,
  valueKobo,
  onChangeKobo,
  disabled,
  required,
  hasError,
  describedBy,
  loading,
  className,
}: AmountFieldProps) {
  const [raw, setRaw] = useState(() => formatDisplay(valueKobo))
  // Resync the displayed text when the caller changes `valueKobo` from
  // outside (a form reset, a fetched default) — derived during render, not
  // in an Effect: https://react.dev/learn/you-might-not-need-an-effect,
  // the same "adjusting state when a prop changes" shape LinkSummary uses.
  const [syncedKobo, setSyncedKobo] = useState(valueKobo)
  if (valueKobo !== syncedKobo) {
    setSyncedKobo(valueKobo)
    setRaw(formatDisplay(valueKobo))
  }

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-(--color-ink-3)"
      >
        &#8358;
      </span>
      <input
        id={id}
        name={name}
        type="text"
        inputMode="decimal"
        value={raw}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        // A monetary amount is a code, not prose — no spellcheck squiggle.
        spellCheck={false}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        data-loading={loading === true || undefined}
        onChange={(event) => {
          const next = event.target.value
          setRaw(next)
          const parsed = parseNaira(next)
          setSyncedKobo(parsed)
          onChangeKobo(parsed)
        }}
        onBlur={() => {
          const parsed = parseNaira(raw)
          if (parsed !== null) setRaw(formatDisplay(parsed))
        }}
        className={cn(className, 'pl-7 tabular')}
      />
    </div>
  )
}

function formatDisplay(kobo: number | null): string {
  if (kobo === null) return ''
  return formatNaira(kobo).replace('₦', '')
}
