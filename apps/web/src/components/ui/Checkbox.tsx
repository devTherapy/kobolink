import { useId } from 'react'
import { cn } from './cn'

export interface CheckboxProps {
  label: string
  hint?: string | undefined
  checked: boolean
  onChange: (checked: boolean) => void
  /** Rendered as the inline error, and wired to `aria-invalid`/`aria-describedby`. */
  error?: string | undefined
  disabled?: boolean | undefined
  /** In flight — blocks changes the same way `disabled` does, and says so via `aria-busy`. */
  loading?: boolean | undefined
  id?: string | undefined
  name?: string | undefined
}

// A white tick on the brand fill. Drawn as a background so the box stays one
// native `<input>`: real checkbox semantics, real keyboard behaviour (Space),
// real form participation — only the paint is ours.
const TICK =
  "checked:bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.5 8.5l3 3 6-7'/%3E%3C/svg%3E\")] checked:bg-center checked:bg-no-repeat"

/**
 * Seven states: default (a 20px box on `--color-ink-3`, the same 3:1
 * non-text-contrast border `Field` uses) · hover (`hover:border`, only while
 * neither invalid nor disabled — same cascade reasoning as `Field`'s
 * `hoverActive`) · focus (`focus-visible:` ring, the global token) · active
 * (`active:` darkens the border) · disabled (native `disabled`, also implied
 * by `loading`) · loading (`aria-busy`; the box is inert and dimmed) · error
 * (`aria-invalid` + `aria-describedby` at the message beside it). Checked is
 * where the accent is spent: selection, never decoration.
 *
 * The whole row is the `<label>`, at least 44px tall, so the hit area is the
 * label text and its padding, not just the 20px box.
 */
export function Checkbox({ label, hint, checked, onChange, error, disabled, loading, id, name }: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const hasError = Boolean(error)
  const isLoading = loading === true
  const isDisabled = disabled === true || isLoading
  const hintId = hint ? `${inputId}-hint` : undefined
  const errorId = hasError ? `${inputId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  const hoverActive = !hasError && !isDisabled

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={inputId}
        className={cn(
          'flex min-h-11 items-start gap-3 py-2.5',
          isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        )}
      >
        <input
          id={inputId}
          name={name}
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked)
          }}
          disabled={isDisabled}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          aria-busy={isLoading || undefined}
          className={cn(
            'mt-px h-5 w-5 shrink-0 appearance-none rounded-[5px] border bg-(--color-surface) transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand)',
            hasError ? 'border-(--color-danger)' : 'border-(--color-ink-3)',
            hoverActive && 'hover:border-(--color-ink-2) active:border-(--color-brand)',
            'checked:border-(--color-brand) checked:bg-(--color-brand)',
            hoverActive && 'checked:hover:border-(--color-brand-hover) checked:hover:bg-(--color-brand-hover)',
            TICK,
          )}
        />
        <span className="text-[14px] font-medium text-(--color-ink)">{label}</span>
      </label>
      {/* Outside the `<label>` on purpose: inside it, the hint would be
          folded into the checkbox's accessible *name* as well as being its
          description. `pl-8` lines it up under the label text (20px box +
          12px gap). */}
      {hint ? (
        <p id={hintId} className="-mt-1.5 pl-8 text-[13px] text-(--color-ink-3)">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} role="alert" className="pl-8 text-[13px] text-(--color-danger)">
          {error}
        </p>
      ) : null}
    </div>
  )
}
