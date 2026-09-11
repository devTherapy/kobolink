'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RegisterRequestSchema, type RegisterRequest } from '@kobolink/contracts'
import { ApiRequestError, client } from '@/lib/api'
import { firstFieldErrors, humanFieldErrors } from '@/lib/zod-errors'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

type FieldErrors = Partial<Record<'email' | 'password' | 'displayName' | 'phone', string>>
type Status = 'idle' | 'loading' | 'error'

/** `/register`'s `"use client"` island — see `LoginForm`'s doc comment for the split this mirrors. */
export function RegisterForm({ next }: { next: string | null }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [phone, setPhone] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')

  function validate(): RegisterRequest | null {
    // Phone is optional (DESIGN-SPEC §4, `RegisterRequestSchema.phone` is
    // `PhoneSchema.optional()`) — an empty field must parse as "not
    // supplied", never as an invalid phone number.
    const result = RegisterRequestSchema.safeParse({
      email,
      password,
      displayName,
      phone: phone.trim().length > 0 ? phone : undefined,
      role: 'merchant',
      client: 'web',
    })
    if (!result.success) {
      // See `LoginForm`'s identical call: this form is `noValidate` too, so
      // `humanFieldErrors` is what stands between an empty/short field and
      // Zod's raw schema-author message.
      setFieldErrors(humanFieldErrors(result.error))
      return null
    }
    setFieldErrors({})
    return result.data
  }

  async function submit(values: RegisterRequest) {
    setStatus('loading')
    setFormError(null)
    try {
      await client.auth.register(values)
      router.replace(next ?? '/dashboard')
    } catch (error) {
      setStatus('error')
      if (!(error instanceof ApiRequestError) || error.transport) {
        setFormError("Could not reach Kobolink's servers. Check your connection and try again.")
        return
      }

      switch (error.error.code) {
        case 'validation_failed':
          if (error.error.fields) {
            setFieldErrors(firstFieldErrors(error.error.fields))
          } else {
            setFormError(error.error.message)
          }
          return
        case 'conflict':
          // The real API's `conflict` (email OR phone already registered)
          // carries no `fields` — pinning it to the email input regardless
          // would mislabel a phone conflict as an email problem. Only pin
          // it to a field when the response actually names one; otherwise
          // show it as a form-level error, since it could be either.
          {
            const conflictEmail = error.error.fields?.email?.[0]
            const conflictPhone = error.error.fields?.phone?.[0]
            if (conflictEmail !== undefined) {
              setFieldErrors((current) => ({ ...current, email: conflictEmail }))
            } else if (conflictPhone !== undefined) {
              setFieldErrors((current) => ({ ...current, phone: conflictPhone }))
            } else {
              setFormError(error.error.message)
            }
          }
          return
        case 'rate_limited': {
          const retryWindow =
            error.retryAfterSeconds !== null
              ? ` Try again in ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? '' : 's'}.`
              : ' Please wait a moment before trying again.'
          setFormError(`${error.error.message}${retryWindow}`)
          return
        }
        case 'unauthenticated':
        case 'forbidden':
        case 'not_found':
        case 'idempotency_mismatch':
        case 'link_not_payable':
        case 'amount_mismatch':
        case 'insufficient_funds':
        case 'internal':
          setFormError(error.error.message)
          return
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'loading') return
    const values = validate()
    if (!values) return
    void submit(values)
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {formError ? (
        <p role="alert" className="rounded-(--radius-input) bg-(--color-danger-tint) p-3 text-[13px] text-(--color-danger)">
          {formError}
        </p>
      ) : null}

      <Field
        label="Full name"
        value={displayName}
        onChange={setDisplayName}
        error={fieldErrors.displayName}
        disabled={status === 'loading'}
        required
        autoComplete="name"
        placeholder="Ngozi Okafor"
      />

      <Field
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        error={fieldErrors.email}
        disabled={status === 'loading'}
        required
        autoComplete="email"
        placeholder="ngozi@example.com"
      />

      <Field
        label="Phone"
        type="tel"
        value={phone}
        onChange={setPhone}
        error={fieldErrors.phone}
        disabled={status === 'loading'}
        hint="Optional. Nigerian mobile number."
        autoComplete="tel"
        placeholder="0803 123 4567"
      />

      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        error={fieldErrors.password}
        disabled={status === 'loading'}
        required
        hint="At least 10 characters."
        autoComplete="new-password"
      />

      <Button
        type="submit"
        status={status === 'loading' ? 'loading' : status === 'error' ? 'error' : 'idle'}
        // See `LoginForm`'s identical choice: never repeat `formError`
        // verbatim here — it is already visible in the alert banner above.
        errorMessage={formError ? 'Registration failed. See the message above.' : 'Registration failed.'}
        className="mt-1 w-full"
      >
        Create account
      </Button>

      <p className="text-center text-[13px] text-(--color-ink-2)">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-(--color-brand) hover:text-(--color-brand-hover)">
          Sign in
        </Link>
      </p>
    </form>
  )
}
