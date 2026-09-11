'use client'

import { useEffect, useId, useRef, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import {
  AmountKoboSchema,
  DisplayNameSchema,
  EmailSchema,
  MAX_AMOUNT_KOBO,
  MIN_AMOUNT_KOBO,
  formatNaira,
  parseNaira,
  type Payment,
  type PublicLink,
  type PublicLinkState,
} from '@kobolink/contracts'
import { ApiRequestError, client } from '@/lib/api'
import type { NonPayableState } from '@/lib/checkout'
import { CheckoutCard } from './CheckoutCard'
import { PayButton } from './PayButton'
import { NonPayableScreen } from './NonPayableScreen'
import { AlertTriangleIcon, CheckCircleIcon, WifiOffIcon, XCircleIcon } from './icons'

/**
 * The checkout's one `"use client"` island (§4.3's "React lesson"). Everything
 * that does not need to react to a click — merchant name, title, description,
 * the fixed amount — is rendered by the server page around this component so
 * the OG-critical HTML and the bulk of the page's content ship with zero
 * client JS. This component owns exactly: the amount field (only when the
 * link has no fixed price), the payer's name and email, the Pay button, and
 * everything that can happen after it is pressed.
 */

type FieldErrors = Partial<Record<'amount' | 'payerName' | 'payerEmail', string>>

type Phase =
  | { kind: 'form' }
  | { kind: 'submitting' }
  | { kind: 'verifying' }
  | { kind: 'success'; payment: Payment }
  | { kind: 'failed'; payment: Payment }
  /** A `verify`-time `ApiError` with `moneyMoved: false` — a real failure,
   *  but one only ever known through an error body, not a `Payment`, so
   *  there is no `payment.reference`/`payment.amountKobo` to show. */
  | { kind: 'attempt-failed'; message: string }
  | { kind: 'not-payable'; state: NonPayableState | null }
  /** `amount_mismatch` on a fixed-amount link: the merchant changed the
   *  price after this page rendered. `amountKobo` is the freshly re-fetched
   *  price when that re-fetch succeeded, `null` when it also failed — either
   *  way the only safe next step is a reload, never a blind resubmit. */
  | { kind: 'price-changed'; amountKobo: number | null }
  /** `reference` is set once `initialize` has succeeded — that is exactly
   *  when a "check status" retry (re-verify, never re-initialize) is safe
   *  and meaningful instead of "start over". `detail` overrides the default
   *  "connection dropped" copy for the non-transport case: a `verify`-time
   *  `ApiError` whose `moneyMoved` was not explicitly `false` lands here
   *  too — we cannot rule out the payment having gone through, so it gets
   *  exactly the same "do not pay again until you have checked" treatment
   *  as an actual dropped connection, never a re-armed Pay button. */
  | { kind: 'transport'; reference: string | null; detail?: string }

function randomKey(): string {
  // `IdempotencyKeySchema` allows `[A-Za-z0-9_-]{16,128}` — a UUID's hyphens
  // are already inside that alphabet, so there is nothing to strip.
  return crypto.randomUUID()
}

function isNonPayableState(state: PublicLinkState | undefined): state is NonPayableState {
  return state === 'disabled' || state === 'expired' || state === 'already-paid'
}

export function PayForm({ link }: { link: PublicLink }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [amountInput, setAmountInput] = useState('')
  const [payerName, setPayerName] = useState('')
  const [payerEmail, setPayerEmail] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const referenceRef = useRef<string | null>(null)

  const amountId = useId()
  const nameId = useId()
  const emailId = useId()

  const isBusy = phase.kind === 'submitting' || phase.kind === 'verifying'

  async function runVerify(reference: string) {
    referenceRef.current = reference
    setPhase({ kind: 'verifying' })
    try {
      const { payment } = await client.checkout.verify({ reference }, randomKey())
      setPhase(payment.status === 'success' ? { kind: 'success', payment } : { kind: 'failed', payment })
    } catch (error) {
      if (error instanceof ApiRequestError && !error.transport) {
        if (error.error.code === 'link_not_payable') {
          const state = isNonPayableState(error.error.state) ? error.error.state : null
          setPhase({ kind: 'not-payable', state })
          return
        }
        if (error.error.moneyMoved === false) {
          // Known for certain: this attempt moved no money. Safe to let the
          // payer start a fresh attempt instead of forcing a status check
          // on a reference that is already decided.
          setPhase({ kind: 'attempt-failed', message: error.error.message })
          return
        }
        // `moneyMoved` is `true`, or — defensively — not sent at all: either
        // way this is not a case where we can rule out the payment having
        // gone through. Once a reference exists, that uncertainty always
        // lands here, never back on an armed Pay button.
        setPhase({ kind: 'transport', reference, detail: error.error.message })
        return
      }
      // A thrown non-ApiRequestError (the request never reached the network
      // at all) and an ApiRequestError with `transport: true` (the API
      // answered with something that was not a real response) both mean the
      // same thing here: we genuinely do not know the outcome.
      setPhase({ kind: 'transport', reference })
    }
  }

  async function submitAttempt(amountKobo: number, name: string, email: string) {
    setPhase({ kind: 'submitting' })
    setFormError(null)
    try {
      const response = await client.checkout.initialize(
        { code: link.code, amountKobo, payerName: name, payerEmail: email },
        randomKey(),
      )
      await runVerify(response.reference)
    } catch (error) {
      if (error instanceof ApiRequestError && !error.transport) {
        switch (error.error.code) {
          case 'link_not_payable': {
            const state = isNonPayableState(error.error.state) ? error.error.state : null
            setPhase({ kind: 'not-payable', state })
            return
          }
          case 'amount_mismatch':
            if (link.amountKobo === null) {
              // A open-amount link: the payer's own typed amount was
              // rejected, not a moved goalpost — plain field validation, no
              // reload needed.
              setFieldErrors((current) => ({ ...current, amount: error.error.message }))
              setPhase({ kind: 'form' })
              return
            }
            // A fixed-amount link only fails `amount_mismatch` when the
            // merchant changed the price after this page rendered — the
            // header above and this form's own Pay button both still show
            // the stale price, and resubmitting fails identically. Read the
            // link again so the next screen can tell the payer the *current*
            // price instead of repeating a submit that cannot succeed.
            await reportPriceChanged()
            return
          // Every other `ErrorCode` this endpoint can plausibly answer
          // (malformed input, a missing/replayed Idempotency-Key, an
          // internal error) renders as one banner — listed explicitly
          // rather than behind a `default` so a new `ErrorCode` added to
          // the contract fails this file's lint instead of silently
          // falling through unconsidered.
          case 'validation_failed':
          case 'unauthenticated':
          case 'forbidden':
          case 'not_found':
          case 'conflict':
          case 'rate_limited':
          case 'idempotency_mismatch':
          case 'insufficient_funds':
          case 'internal': {
            // `checkout.initialize` never posts anything — only `verify`
            // does — so nothing here should ever have moved money. Still
            // read `moneyMoved` defensively rather than asserting that from
            // the endpoint's shape alone: the reassurance is only added
            // when the server didn't say the opposite.
            const reassurance = error.error.moneyMoved === true ? '' : ' No money has moved.'
            setFormError(`${error.error.message}${reassurance}`)
            setPhase({ kind: 'form' })
            return
          }
        }
      }
      setPhase({ kind: 'transport', reference: null })
    }
  }

  async function reportPriceChanged() {
    try {
      const resolution = await client.links.resolve(link.code)
      if (resolution.state === 'payable') {
        setPhase({ kind: 'price-changed', amountKobo: resolution.link.amountKobo })
        return
      }
      // The link stopped being payable entirely between page load and this
      // submit (disabled, expired, or — a single-use link — paid by someone
      // else) rather than merely repricing. "The price changed, reload" is
      // the wrong story for that; the non-payable screen is the true one.
      const state = isNonPayableState(resolution.state) ? resolution.state : null
      setPhase({ kind: 'not-payable', state })
    } catch {
      // Best-effort — the "Reload" next step is still a safe way out even
      // when this second read also fails, so `amountKobo: null` here just
      // means "we don't know the new price, but you should reload".
      setPhase({ kind: 'price-changed', amountKobo: null })
    }
  }

  function validate(): { amountKobo: number; name: string; email: string } | null {
    const errors: FieldErrors = {}
    let amountKobo: number | null = null

    if (link.amountKobo !== null) {
      amountKobo = link.amountKobo
    } else {
      const parsed = parseNaira(amountInput)
      if (parsed === null || !AmountKoboSchema.safeParse(parsed).success) {
        errors.amount = `Enter an amount between ${formatNaira(MIN_AMOUNT_KOBO)} and ${formatNaira(MAX_AMOUNT_KOBO)}.`
      } else {
        amountKobo = parsed
      }
    }

    const nameResult = DisplayNameSchema.safeParse(payerName.trim())
    if (!nameResult.success) errors.payerName = 'Enter your name.'

    const emailResult = EmailSchema.safeParse(payerEmail)
    if (!emailResult.success) errors.payerEmail = 'Enter a valid email address.'

    setFieldErrors(errors)
    if (Object.keys(errors).length > 0 || amountKobo === null || !nameResult.success || !emailResult.success) {
      return null
    }
    return { amountKobo, name: nameResult.data, email: emailResult.data }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isBusy) return
    const values = validate()
    if (!values) return
    void submitAttempt(values.amountKobo, values.name, values.email)
  }

  function handleTryAgain() {
    setFormError(null)
    setPhase({ kind: 'form' })
  }

  function handleCheckStatus() {
    const reference = referenceRef.current
    if (!reference) return
    void runVerify(reference)
  }

  function handleReload() {
    window.location.reload()
  }

  if (phase.kind === 'not-payable') {
    // `headingLevel="h2"`: the page's real `<h1>` (the link title) is still
    // visible in the server-rendered header above this component.
    // `autoFocus`: unlike the same screen's initial-page-load render, this
    // one is always the result of a client-side transition.
    return <NonPayableScreen state={phase.state} link={link} headingLevel="h2" autoFocus />
  }

  if (phase.kind === 'success') {
    return <SuccessResult payment={phase.payment} link={link} />
  }

  if (phase.kind === 'failed') {
    return (
      <FailedResult
        message={phase.payment.failureReason ?? 'The payment could not be completed.'}
        onRetry={handleTryAgain}
      />
    )
  }

  if (phase.kind === 'attempt-failed') {
    return <FailedResult message={phase.message} onRetry={handleTryAgain} />
  }

  if (phase.kind === 'price-changed') {
    return <PriceChangedResult amountKobo={phase.amountKobo} merchantName={link.merchantName} onReload={handleReload} />
  }

  if (phase.kind === 'transport') {
    return (
      <TransportResult
        reference={phase.reference}
        onCheckStatus={handleCheckStatus}
        onTryAgain={handleTryAgain}
        {...(phase.detail !== undefined ? { detail: phase.detail } : {})}
      />
    )
  }

  if (phase.kind === 'verifying') {
    return <VerifyingSkeleton />
  }

  return (
    <CheckoutCard>
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {formError ? (
          <p role="alert" className="rounded-(--radius-input) bg-(--color-danger-tint) p-3 text-[13px] text-(--color-danger)">
            {formError}
          </p>
        ) : null}

        {link.amountKobo === null ? (
          <Field
            id={amountId}
            label="Amount"
            error={fieldErrors.amount}
            loading={isBusy}
            inputProps={{
              inputMode: 'decimal',
              autoComplete: 'off',
              placeholder: '₦0.00',
              value: amountInput,
              disabled: isBusy,
              onChange: (event) => setAmountInput(event.target.value),
            }}
          />
        ) : null}

        <Field
          id={nameId}
          label="Your name"
          error={fieldErrors.payerName}
          loading={isBusy}
          inputProps={{
            type: 'text',
            autoComplete: 'name',
            placeholder: 'Ngozi Okafor',
            value: payerName,
            disabled: isBusy,
            onChange: (event) => setPayerName(event.target.value),
          }}
        />

        <Field
          id={emailId}
          label="Email"
          error={fieldErrors.payerEmail}
          loading={isBusy}
          inputProps={{
            type: 'email',
            autoComplete: 'email',
            placeholder: 'ngozi@example.com',
            value: payerEmail,
            disabled: isBusy,
            onChange: (event) => setPayerEmail(event.target.value),
          }}
        />

        <PayButton type="submit" state={phase.kind === 'submitting' ? 'loading' : 'default'} loadingLabel="Starting…">
          {link.amountKobo !== null ? `Pay ${formatNaira(link.amountKobo)}` : 'Pay'}
        </PayButton>
      </form>
    </CheckoutCard>
  )
}

interface FieldProps {
  id: string
  label: string
  error?: string | undefined
  /** True while an in-flight submit/verify makes this field temporarily
   *  uneditable — distinct from a hard `disabled` field: the visual and
   *  `aria-busy="true"` both say "busy right now", not "unavailable". */
  loading?: boolean
  inputProps: InputHTMLAttributes<HTMLInputElement>
}

/**
 * The checkout's one input primitive. Errors render beside (directly under)
 * the field they belong to, tied to it with `aria-describedby` — never
 * collected into a summary at the top, which is the pattern the brief's
 * "errors beside the field" rules out.
 *
 * All seven states: `default` and `focus-visible` (outline) were always
 * here; `disabled` (via the native attribute) too. `hover` and `active` are
 * Tailwind pseudo-classes layered on top, scoped with `enabled:` so a
 * disabled/loading field cannot show a hover treatment it cannot act on.
 * `loading` is the seventh — see `FieldProps.loading`.
 */
function Field({ id, label, error, loading = false, inputProps }: FieldProps) {
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium text-(--color-ink-2)">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-busy={loading || undefined}
        className={`min-h-11 rounded-(--radius-input) border bg-(--color-surface) px-3 text-[14px] text-(--color-ink) outline-none transition-colors placeholder:text-(--color-ink-3) enabled:hover:border-(--color-ink-3) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand) enabled:active:border-(--color-brand) disabled:cursor-not-allowed disabled:bg-(--color-border-soft) disabled:text-(--color-ink-3) ${
          loading ? 'animate-pulse cursor-wait' : ''
        } ${error ? 'border-(--color-danger)' : 'border-(--color-border)'}`}
        {...inputProps}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-[13px] text-(--color-danger)">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** A content-shaped skeleton for the wait between "initialized" and "verified" — never a bare spinner. */
function VerifyingSkeleton() {
  return (
    <CheckoutCard>
      <div role="status" aria-label="Confirming your payment" className="flex animate-pulse flex-col items-center gap-3 py-2 text-center">
        <div className="h-8 w-8 rounded-full bg-(--color-border-soft)" />
        <div className="h-3 w-2/3 rounded bg-(--color-border-soft)" />
        <div className="h-5 w-1/2 rounded bg-(--color-border-soft)" />
        <div className="h-3 w-1/3 rounded bg-(--color-border-soft)" />
        <p className="mt-1 text-[13px] text-(--color-ink-2)">Confirming your payment…</p>
      </div>
    </CheckoutCard>
  )
}

/**
 * Every result screen below is always the product of a client-side
 * transition — `PayForm` never mounts directly into one of these phases —
 * so an unconditional focus-on-mount is correct for all of them: move a
 * screen-reader (and keyboard) user's focus to the heading that just
 * appeared, exactly once, right when it appears.
 */
function useResultHeadingFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return ref
}

function SuccessResult({ payment, link }: { payment: Payment; link: PublicLink }) {
  const headingRef = useResultHeadingFocus<HTMLHeadingElement>()
  return (
    <CheckoutCard>
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center">
        <CheckCircleIcon className="text-(--color-success)" width={32} height={32} />
        <h2 ref={headingRef} tabIndex={-1} className="text-[23px] font-semibold text-(--color-ink) outline-none">
          Payment successful
        </h2>
        <p className="tabular text-[26px] font-semibold text-(--color-ink)">{formatNaira(payment.amountKobo)}</p>
        <p className="text-[14px] text-(--color-ink-2)">to {link.merchantName}</p>
        <p className="rounded-(--radius-input) bg-(--color-success-tint) px-3 py-2 text-[13px] font-medium text-(--color-success)">
          Money moved. Your payment was successful.
        </p>
        <p className="font-mono tabular text-[13px] text-(--color-ink-3)">Reference {payment.reference}</p>
      </div>
    </CheckoutCard>
  )
}

function FailedResult({ message, onRetry }: { message: string; onRetry: () => void }) {
  const headingRef = useResultHeadingFocus<HTMLHeadingElement>()
  return (
    <CheckoutCard>
      {/* `role="alert"` (assertive), not `status`: this is a definite,
          money-relevant outcome — at least as attention-worthy as the plain
          inline validation banner above the form, which already uses
          `role="alert"`. */}
      <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-3 text-center">
        <XCircleIcon className="text-(--color-danger)" width={32} height={32} />
        <h2 ref={headingRef} tabIndex={-1} className="text-[23px] font-semibold text-(--color-ink) outline-none">
          Payment failed
        </h2>
        <p className="text-[14px] text-(--color-ink-2)">{message}</p>
        <p className="rounded-(--radius-input) bg-(--color-danger-tint) px-3 py-2 text-[13px] font-medium text-(--color-danger)">
          No money moved.
        </p>
        <PayButton state="error" type="button" onClick={onRetry}>
          Try again
        </PayButton>
      </div>
    </CheckoutCard>
  )
}

function PriceChangedResult({
  amountKobo,
  merchantName,
  onReload,
}: {
  amountKobo: number | null
  merchantName: string
  onReload: () => void
}) {
  const headingRef = useResultHeadingFocus<HTMLHeadingElement>()
  return (
    <CheckoutCard>
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center">
        <AlertTriangleIcon className="text-(--color-warning)" width={32} height={32} />
        <h2 ref={headingRef} tabIndex={-1} className="text-[23px] font-semibold text-(--color-ink) outline-none">
          The price has changed
        </h2>
        <p className="text-[14px] text-(--color-ink-2)">
          {amountKobo !== null
            ? `${merchantName} updated this link — it now costs ${formatNaira(amountKobo)}.`
            : `${merchantName} updated the price for this link.`}
        </p>
        <p className="rounded-(--radius-input) bg-(--color-warning-tint) px-3 py-2 text-[13px] font-medium text-(--color-warning)">
          No money moved. Reload to see the current price before paying.
        </p>
        <PayButton state="warning" type="button" onClick={onReload}>
          Reload
        </PayButton>
      </div>
    </CheckoutCard>
  )
}

function TransportResult({
  reference,
  detail,
  onCheckStatus,
  onTryAgain,
}: {
  /** Set once `initialize` has succeeded. When present, shown the same way
   *  `SuccessResult` shows one — a payer with an uncertain payment needs a
   *  reference to quote to the merchant every bit as much as one who knows
   *  it succeeded. */
  reference: string | null
  /** Overrides the default "connection dropped" body copy for the
   *  non-transport case — a `verify`-time `ApiError` we could not rule out
   *  as having moved money (see `Phase`'s own `'transport'` doc comment). */
  detail?: string
  onCheckStatus: () => void
  onTryAgain: () => void
}) {
  const headingRef = useResultHeadingFocus<HTMLHeadingElement>()
  return (
    <CheckoutCard>
      {/* `role="alert"` (assertive): the `reference` branch is telling a
          payer their money's status is *unknown* — at least as urgent as a
          confirmed failure, never less. */}
      <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-3 text-center">
        <WifiOffIcon className="text-(--color-warning)" width={32} height={32} />
        <h2 ref={headingRef} tabIndex={-1} className="text-[23px] font-semibold text-(--color-ink) outline-none">
          We couldn&apos;t confirm this payment
        </h2>
        {reference !== null ? (
          <>
            <p className="text-[14px] text-(--color-ink-2)">
              {detail ??
                'The connection dropped before we heard back. It may or may not have gone through — check its status before trying again.'}
            </p>
            <p className="rounded-(--radius-input) bg-(--color-warning-tint) px-3 py-2 text-[13px] font-medium text-(--color-warning)">
              Money may or may not have moved. Do not pay again until you have checked.
            </p>
            <p className="font-mono tabular text-[13px] text-(--color-ink-3)">Reference {reference}</p>
            <PayButton state="warning" type="button" onClick={onCheckStatus}>
              Check status
            </PayButton>
          </>
        ) : (
          <>
            <p className="text-[14px] text-(--color-ink-2)">
              The connection dropped before checkout could start. Nothing was charged.
            </p>
            <p className="rounded-(--radius-input) bg-(--color-warning-tint) px-3 py-2 text-[13px] font-medium text-(--color-warning)">
              No money has moved.
            </p>
            <PayButton state="warning" type="button" onClick={onTryAgain}>
              Try again
            </PayButton>
          </>
        )}
      </div>
    </CheckoutCard>
  )
}
