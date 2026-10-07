'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import type { PaymentLink } from '@kobolink/contracts'
import { ApiRequestError } from '@/lib/api'
import { createLinkWithRetry } from '@/lib/create-link'
import {
  CREATE_LINK_FIELD_ORDER,
  formFieldErrorsFromApi,
  validateCreateLink,
  type CreateLinkFieldErrors,
  type CreateLinkFieldName,
} from '@/lib/create-link-form'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Field } from '@/components/ui/Field'

type Status = 'idle' | 'loading' | 'error'

/** What the merchant is told when the API answered with a failure we have no better words for. */
const NOT_CREATED = 'No link was created.'

interface FormError {
  message: string
  /** Offer the sign-in page as the next step — only for an expired session. */
  signIn?: boolean
}

/**
 * Stable ids so a failed submit can move focus to the first invalid field.
 * Only one create form is ever mounted (the drawer is modal and closing it
 * unmounts the form), so a fixed id cannot collide.
 */
const FIELD_ID: Record<CreateLinkFieldName, string> = {
  title: 'create-link-title',
  description: 'create-link-description',
  amount: 'create-link-amount',
  expiresOn: 'create-link-expires-on',
}

interface CreateLinkFormProps {
  onCreated: (link: PaymentLink) => void
  onCancel: () => void
  /**
   * Tells the drawer's owner a request is in flight, so Esc and Close can be
   * refused until it settles — closing mid-request would orphan the result.
   */
  onPendingChange: (pending: boolean) => void
}

/**
 * The drawer's one `"use client"` form (F4). Validation is `validateCreateLink`
 * — contracts' `CreateLinkRequestSchema` plus `parseNaira` — run on submit,
 * rendered through the same `<Field error>` slot the API's own
 * `validation_failed.fields` use, so a client-side and a server-side
 * rejection look identical: a message beside the input, focus moved to it.
 *
 * The amount is read from the DOM on submit, not from `Field`'s kobo callback,
 * because that callback reports `null` both for "left blank" (the payer
 * chooses) and "typed something unreadable" — the two cases need different
 * answers, and only the raw text tells them apart.
 *
 * A code collision (`conflict`) is retried by `createLinkWithRetry` without
 * this component ever hearing about it; only when those retries are spent
 * does `conflict` arrive here, as a plain "nothing was created, try again".
 */
export function CreateLinkForm({ onCreated, onCancel, onPendingChange }: CreateLinkFormProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [amountKobo, setAmountKobo] = useState<number | null>(null)
  const [isReusable, setIsReusable] = useState(false)
  const [expiresOn, setExpiresOn] = useState('')
  const [fieldErrors, setFieldErrors] = useState<CreateLinkFieldErrors>({})
  const [formError, setFormError] = useState<FormError | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const isLoading = status === 'loading'
  const bannerRef = useRef<HTMLParagraphElement>(null)
  // Set when a render should end with focus on the first invalid field; read
  // (and cleared) by the effect below. Focus has to wait for the render
  // because a *server-side* field error arrives while every input is still
  // disabled by `loading` — and `.focus()` on a disabled input silently does
  // nothing. (Caught by "puts a server-side validation_failed message beside
  // the field it names": focus stayed on the submit button.)
  const focusFirstInvalidRef = useRef(false)

  useEffect(() => {
    if (!focusFirstInvalidRef.current) return
    focusFirstInvalidRef.current = false
    const first = CREATE_LINK_FIELD_ORDER.find((name) => fieldErrors[name] !== undefined)
    if (first) document.getElementById(FIELD_ID[first])?.focus()
  }, [fieldErrors])

  // After a failed submit the fields were just re-enabled, and focus was
  // dropped to `<body>` while they were disabled; put it on the banner that
  // says what happened (it is also `role="alert"`, so this is announced
  // either way — the focus move is for the keyboard user's position).
  useEffect(() => {
    if (formError) bannerRef.current?.focus()
  }, [formError])

  /** Editing a field retires its own error — the merchant is already fixing it. */
  function edited<T>(name: CreateLinkFieldName, set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setFieldErrors((current) => {
        if (current[name] === undefined) return current
        const { [name]: _fixed, ...rest } = current
        return rest
      })
    }
  }

  function showFieldErrors(errors: CreateLinkFieldErrors) {
    focusFirstInvalidRef.current = true
    setFieldErrors(errors)
  }

  function describeFailure(error: unknown): FormError | null {
    if (!(error instanceof ApiRequestError) || error.transport) {
      // The request may have reached the server before the connection died,
      // so unlike every other failure here we cannot promise nothing was
      // created — and must not, or a retry looks like it is safe.
      return {
        message:
          "Could not reach Kobolink's servers. Check your connection and try again. If the link appears in your list, it was created.",
      }
    }

    const { code, message, fields } = error.error
    if (code === 'validation_failed') {
      const mapped = fields ? formFieldErrorsFromApi(fields) : {}
      if (Object.keys(mapped).length > 0) {
        showFieldErrors(mapped)
        return null
      }
      return { message: `${message} ${NOT_CREATED}` }
    }
    if (code === 'unauthenticated') {
      return { message: `Your session has expired, so ${NOT_CREATED.toLowerCase()}`, signIn: true }
    }
    if (code === 'rate_limited') {
      const wait =
        error.retryAfterSeconds !== null
          ? `Try again in ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? '' : 's'}.`
          : 'Please wait a moment before trying again.'
      return { message: `Too many requests. ${wait} ${NOT_CREATED}` }
    }
    if (code === 'conflict') {
      return { message: `We could not generate a unique link code. ${NOT_CREATED} Try again.` }
    }
    return { message: `${message} ${NOT_CREATED}` }
  }

  async function submit(request: Parameters<typeof createLinkWithRetry>[0]) {
    setStatus('loading')
    setFormError(null)
    onPendingChange(true)
    try {
      const link = await createLinkWithRetry(request)
      onCreated(link)
      // No `setStatus('idle')`: the owner closes the drawer, unmounting this
      // form; resetting state it will never render again is pure waste.
    } catch (error) {
      onPendingChange(false)
      setStatus('error')
      setFormError(describeFailure(error))
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isLoading) return
    const form = event.currentTarget

    const amountText = new FormData(form).get('amount')
    const result = validateCreateLink({
      title,
      description,
      amountText: typeof amountText === 'string' ? amountText : '',
      isReusable,
      expiresOn,
    })
    if (!result.ok) {
      setStatus('idle')
      setFormError(null)
      showFieldErrors(result.errors)
      return
    }
    setFieldErrors({})
    // The inputs are about to be disabled, and a disabled element cannot keep
    // focus — Enter pressed in a field would strand it on `<body>`. Park it on
    // the submit button, which stays focusable while loading.
    form.querySelector<HTMLElement>('button[type="submit"]')?.focus()
    void submit(result.request)
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4">
        {formError ? (
          <p
            ref={bannerRef}
            tabIndex={-1}
            role="alert"
            className="rounded-(--radius-input) bg-(--color-danger-tint) p-3 text-[13px] text-(--color-danger)"
          >
            {formError.message}
            {formError.signIn ? (
              <>
                {' '}
                <Link href="/login?next=%2Fdashboard" className="font-medium underline">
                  Sign in again
                </Link>
              </>
            ) : null}
          </p>
        ) : null}

        <Field
          id={FIELD_ID.title}
          name="title"
          label="Title"
          value={title}
          onChange={edited('title', setTitle)}
          error={fieldErrors.title}
          disabled={isLoading}
          required
          autoComplete="off"
          placeholder="Ankara two-piece set"
          hint="What the payer sees at the top of checkout."
        />

        <Field
          id={FIELD_ID.description}
          name="description"
          label="Description"
          value={description}
          onChange={edited('description', setDescription)}
          error={fieldErrors.description}
          disabled={isLoading}
          autoComplete="off"
          hint="Optional. A line of detail under the title."
        />

        <Field
          id={FIELD_ID.amount}
          name="amount"
          variant="amount"
          label="Amount"
          valueKobo={amountKobo}
          onChangeKobo={edited('amount', setAmountKobo)}
          error={fieldErrors.amount}
          disabled={isLoading}
          autoComplete="off"
          placeholder="18,500"
          hint="Leave empty to let the payer choose the amount."
        />

        <Checkbox
          name="isReusable"
          label="Reusable"
          hint="Anyone can pay this link more than once. Otherwise it closes after its first payment."
          checked={isReusable}
          onChange={setIsReusable}
          loading={isLoading}
        />

        <Field
          id={FIELD_ID.expiresOn}
          name="expiresOn"
          type="date"
          label="Expires on"
          value={expiresOn}
          onChange={edited('expiresOn', setExpiresOn)}
          error={fieldErrors.expiresOn}
          disabled={isLoading}
          hint="Optional. The link works through the end of this day."
        />
      </div>

      <div className="flex gap-3 border-t border-(--color-border) px-4 py-3 sm:justify-end">
        <Button variant="secondary" surface="surface" disabled={isLoading} onClick={onCancel} className="flex-1 sm:flex-none">
          Cancel
        </Button>
        <Button
          type="submit"
          surface="surface"
          status={status}
          errorMessage={formError ? 'Creating the link failed. See the message above.' : 'Creating the link failed.'}
          className="flex-1 sm:flex-none"
        >
          Create link
        </Button>
      </div>
    </form>
  )
}
