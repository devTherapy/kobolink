import type { InputHTMLAttributes } from 'react'
import { useId, useState } from 'react'
import { formatNaira, parseNaira } from '@kobolink/contracts'
import { cn } from './cn'
import { Skeleton } from './Skeleton'

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
 * Seven states: default (base classes, border at `--color-ink-3` — a plain
 * `--color-border` reads at ~1.2:1 against the field's white fill, far under
 * the 3:1 WCAG non-text-contrast floor for a control boundary) · hover
 * (`hover:border`, only while the field is neither invalid nor disabled —
 * see the note on `hoverActive` below) · focus (`focus-visible:` ring,
 * native to `<input>`) · active (`active:border`, same guard as hover) ·
 * disabled (native `disabled`, also implied by `loading`) · loading
 * (`aria-busy` on the real input, plus a visible `Skeleton` line drawn over
 * the hidden value — not a transparent-on-transparent fill, which read as a
 * blank rectangle) · error (`aria-invalid` + `aria-describedby` pointing at
 * the message rendered beside the input).
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
  const isLoading = props.loading === true
  // Hover/active only apply to a field that isn't already showing a stronger
  // state — otherwise `hover:border-ink-3`/`active:border-brand` win the
  // cascade over the error's `border-danger` the instant the pointer enters
  // the field (both are single-class selectors of equal specificity, and
  // Tailwind emits pseudo-class variants after plain utilities, so the
  // variant wins on source order). Omitting the classes entirely when they
  // don't apply removes the cascade fight rather than trying to out-rank it.
  const hoverActive = !hasError && !isDisabled

  const inputClassName = cn(
    'h-11 w-full rounded-(--radius-input) border bg-(--color-surface) px-3 text-[14px] text-(--color-ink) outline-none transition-colors',
    'placeholder:text-(--color-ink-3)',
    hoverActive && 'hover:border-(--color-ink-2)',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)',
    hoverActive && 'active:border-(--color-brand)',
    'disabled:cursor-not-allowed disabled:opacity-50',
    // Loading hides the (possibly stale) value/placeholder text so it
    // doesn't show through under the `Skeleton` line drawn on top (below);
    // the border just steps down to the muted token, no fill swap.
    'data-loading:border-(--color-border-soft) data-loading:text-transparent data-loading:placeholder:text-transparent',
    hasError ? 'border-(--color-danger)' : 'border-(--color-ink-3)',
  )

  return (
    <div className="flex flex-col gap-1.5" data-loading={isLoading || undefined}>
      <label htmlFor={id} className="text-[13px] font-medium text-(--color-ink-2)">
        {props.label}
        {props.required ? (
          <span aria-hidden="true" className="text-(--color-danger)">
            {' '}
            *
          </span>
        ) : null}
      </label>

      <div className="relative">
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
            autoComplete={props.autoComplete}
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
            aria-busy={isLoading || undefined}
            data-loading={isLoading || undefined}
            className={inputClassName}
          />
        )}

        {isLoading ? (
          <Skeleton
            shape="line"
            width="50%"
            aria-label={`Loading ${props.label}…`}
            // `left-7` only for the amount variant, to clear its ₦ prefix
            // (itself at `left-3`); the text variant's input starts at the
            // same `px-3` every other text field uses, so the overlay
            // matches that, not the currency layout.
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-y-1/2',
              props.variant === 'amount' ? 'left-7' : 'left-3',
            )}
          />
        ) : null}
      </div>

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
  autoComplete?: InputHTMLAttributes<HTMLInputElement>['autoComplete']
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
  autoComplete,
  className,
}: AmountFieldProps) {
  const [raw, setRaw] = useState(() => formatDisplay(valueKobo))
  // Tracks the last `valueKobo` this field has already reconciled with —
  // every prop value it has seen and decided not to act on, including
  // `null`. Two different caller shapes both have to work:
  //
  //  - A caller that *echoes* every emission straight back (state = exactly
  //    what `onChangeKobo` last passed, including `null` mid-typing "10.").
  //  - A caller that only commits *parseable* amounts (validates on submit,
  //    so an intermediate `onChangeKobo(null)` never reaches its own state,
  //    and `valueKobo` keeps reflecting the last value it *did* accept).
  //
  // Comparing only against "the last prop seen" breaks the first shape
  // (typing "10." synchronously updates this field's own local state before
  // the echo arrives, so the echoed prop looks "new" and gets reformatted —
  // wiping the "10." the payer just typed). Comparing only against "the
  // last value emitted, but never on null" breaks the second shape (the
  // reviewed-and-reverted round 1 attempt): an echoing caller's legitimate
  // `null` then looks like a stale baseline never caught up to, and forces
  // the same wipe from the other direction.
  //
  // The fix that satisfies both: resync `raw` only when the incoming
  // `valueKobo` is a value we have neither already reconciled with *nor*
  // is what the field's own current text would produce right now. That
  // second check is what makes an echo safe regardless of whether the
  // caller's state update lands before or after this component re-renders.
  const [reconciledKobo, setReconciledKobo] = useState(valueKobo)
  if (valueKobo !== reconciledKobo) {
    if (valueKobo === parseNaira(raw)) {
      // Either an echo of what we just emitted, or the prop has simply
      // caught up to what `raw` already represents — nothing to reformat,
      // just stop treating this prop value as unreconciled.
      setReconciledKobo(valueKobo)
    } else {
      // A value this field did not just produce and that doesn't match its
      // current text — a form reset, a fetched default, or similar.
      setReconciledKobo(valueKobo)
      setRaw(formatDisplay(valueKobo))
    }
  }

  return (
    <>
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
        autoComplete={autoComplete}
        // A monetary amount is a code, not prose — no spellcheck squiggle.
        spellCheck={false}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        aria-busy={loading === true || undefined}
        data-loading={loading === true || undefined}
        onChange={(event) => {
          const next = event.target.value
          setRaw(next)
          // Deliberately doesn't touch `reconciledKobo` here — the
          // render-time check above is the only writer, so it can tell an
          // echo of *this* emission apart from a prop that changed for an
          // unrelated reason, no matter which order the caller's own
          // re-render lands relative to this one.
          onChangeKobo(parseNaira(next))
        }}
        onBlur={() => {
          const parsed = parseNaira(raw)
          if (parsed !== null) setRaw(formatDisplay(parsed))
        }}
        className={cn(className, 'pl-7 tabular')}
      />
    </>
  )
}

function formatDisplay(kobo: number | null): string {
  if (kobo === null) return ''
  return formatNaira(kobo).replace('₦', '')
}
