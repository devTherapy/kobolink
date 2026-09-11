'use client'

import { useId, useRef, useState, type FormEvent, type InputHTMLAttributes } from 'react'
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
import { CheckCircleIcon, WifiOffIcon, XCircleIcon } from './icons'

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
  | { kind: 'not-payable'; state: NonPayableState }
  /** `reference` is set once `initialize` has succeeded — that is exactly
   *  when a "check status" retry (re-verify, never re-initialize) is safe
   *  and meaningful instead of "start over". */
  | { kind: 'transport'; reference: string | null }

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
        setFormError(error.error.message)
        setPhase({ kind: 'form' })
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
            const state = isNonPayableState(error.error.state) ? error.error.state : 'disabled'
            setPhase({ kind: 'not-payable', state })
            return
          }
          case 'amount_mismatch':
            // A fixed-amount link renders no amount field to put this
            // beside — that only happens if the merchant changed the price
            // between page load and submit, so it is a banner instead.
            if (link.amountKobo === null) {
              setFieldErrors((current) => ({ ...current, amount: error.error.message }))
            } else {
              setFormError(error.error.message)
            }
            setPhase({ kind: 'form' })
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
          case 'internal':
            setFormError(error.error.message)
            setPhase({ kind: 'form' })
            return
        }
      }
      setPhase({ kind: 'transport', reference: null })
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

  if (phase.kind === 'not-payable') {
    // `headingLevel="h2"`: the page's real `<h1>` (the link title) is still
    // visible in the server-rendered header above this component.
    return <NonPayableScreen state={phase.state} link={link} headingLevel="h2" />
  }

  if (phase.kind === 'success') {
    return <SuccessResult payment={phase.payment} link={link} />
  }

  if (phase.kind === 'failed') {
    return <FailedResult payment={phase.payment} onRetry={handleTryAgain} />
  }

  if (phase.kind === 'transport') {
    return (
      <TransportResult
        hasReference={phase.reference !== null}
        onCheckStatus={handleCheckStatus}
        onTryAgain={handleTryAgain}
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
  inputProps: InputHTMLAttributes<HTMLInputElement>
}

/**
 * The checkout's one input primitive. Errors render beside (directly under)
 * the field they belong to, tied to it with `aria-describedby` — never
 * collected into a summary at the top, which is the pattern the brief's
 * "errors beside the field" rules out.
 */
function Field({ id, label, error, inputProps }: FieldProps) {
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
        className={`min-h-11 rounded-(--radius-input) border bg-(--color-surface) px-3 text-[14px] text-(--color-ink) outline-none placeholder:text-(--color-ink-3) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-brand) disabled:bg-(--color-border-soft) disabled:text-(--color-ink-3) ${
          error ? 'border-(--color-danger)' : 'border-(--color-border)'
        }`}
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

function SuccessResult({ payment, link }: { payment: Payment; link: PublicLink }) {
  return (
    <CheckoutCard>
      <div className="flex flex-col items-center gap-3 text-center">
        <CheckCircleIcon className="text-(--color-success)" width={32} height={32} />
        <h2 className="text-[23px] font-semibold text-(--color-ink)">Payment successful</h2>
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

function FailedResult({ payment, onRetry }: { payment: Payment; onRetry: () => void }) {
  return (
    <CheckoutCard>
      <div className="flex flex-col items-center gap-3 text-center">
        <XCircleIcon className="text-(--color-danger)" width={32} height={32} />
        <h2 className="text-[23px] font-semibold text-(--color-ink)">Payment failed</h2>
        <p className="text-[14px] text-(--color-ink-2)">{payment.failureReason ?? 'The payment could not be completed.'}</p>
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

function TransportResult({
  hasReference,
  onCheckStatus,
  onTryAgain,
}: {
  hasReference: boolean
  onCheckStatus: () => void
  onTryAgain: () => void
}) {
  return (
    <CheckoutCard>
      <div className="flex flex-col items-center gap-3 text-center">
        <WifiOffIcon className="text-(--color-warning)" width={32} height={32} />
        <h2 className="text-[23px] font-semibold text-(--color-ink)">We couldn&apos;t confirm this payment</h2>
        {hasReference ? (
          <>
            <p className="text-[14px] text-(--color-ink-2)">
              The connection dropped before we heard back. It may or may not have gone through — check its status
              before trying again.
            </p>
            <p className="rounded-(--radius-input) bg-(--color-warning-tint) px-3 py-2 text-[13px] font-medium text-(--color-warning)">
              Money may or may not have moved. Do not pay again until you have checked.
            </p>
            <PayButton state="error" type="button" onClick={onCheckStatus}>
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
            <PayButton state="error" type="button" onClick={onTryAgain}>
              Try again
            </PayButton>
          </>
        )}
      </div>
    </CheckoutCard>
  )
}

