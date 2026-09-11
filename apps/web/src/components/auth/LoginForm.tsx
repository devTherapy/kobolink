'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LoginRequestSchema } from '@kobolink/contracts'
import { ApiRequestError, client } from '@/lib/api'
import { firstFieldErrors, humanFieldErrors } from '@/lib/zod-errors'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

type FieldErrors = Partial<Record<'email' | 'password', string>>
type Status = 'idle' | 'loading' | 'error'

/**
 * `/login`'s one `"use client"` island — the server page around it only
 * renders the static shell and heading, matching F6's server/client split
 * (`PayForm`'s own doc comment explains why that boundary matters; the same
 * reasoning applies here even though a login page has no Open Graph stakes
 * of its own: `AuthShell` and this form's static markup still ship for free
 * with no client JS required to *see* the form, only to submit it).
 */
export function LoginForm({ next }: { next: string | null }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')

  function validate(): { email: string; password: string } | null {
    const result = LoginRequestSchema.safeParse({ email, password, client: 'web' })
    if (!result.success) {
      // Zod's own default messages are schema-author copy ("Too small:
      // expected string to have >=1 characters"), not something to show a
      // merchant on a `noValidate` form where this is the only guard before
      // submission — `humanFieldErrors` rewrites them into actual prose.
      setFieldErrors(humanFieldErrors(result.error))
      return null
    }
    setFieldErrors({})
    return { email: result.data.email, password: result.data.password }
  }

  async function submit(values: { email: string; password: string }) {
    setStatus('loading')
    setFormError(null)
    try {
      await client.auth.login({ ...values, client: 'web' })
      router.replace(next ?? '/dashboard')
      // Deliberately no `setStatus('idle')` on the success path: the
      // component is about to be unmounted by the navigation above, and
      // resetting state it will never render again is pure waste —
      // `rerender-defer-reads` in spirit, just applied to a status flag
      // instead of a subscription.
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
        case 'unauthenticated':
          // README: one message for both "wrong password" and "unknown
          // user" — shown beside the password field, never split into two
          // different stories that would tell an attacker which one it was.
          setFieldErrors((current) => ({ ...current, password: error.error.message }))
          return
        case 'rate_limited': {
          const retryWindow =
            error.retryAfterSeconds !== null
              ? ` Try again in ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? '' : 's'}.`
              : ' Please wait a moment before trying again.'
          setFormError(`${error.error.message}${retryWindow}`)
          return
        }
        case 'forbidden':
        case 'not_found':
        case 'conflict':
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
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        error={fieldErrors.password}
        disabled={status === 'loading'}
        required
        autoComplete="current-password"
      />

      <Button
        type="submit"
        status={status === 'loading' ? 'loading' : status === 'error' ? 'error' : 'idle'}
        // Deliberately not `formError` itself: that same text is already
        // visible in the `role="alert"` banner above, in the accessibility
        // tree already — repeating it verbatim here would just be the same
        // string exposed twice under two different accessible-text APIs
        // (`getByText`-style queries match both), announced twice by a
        // screen reader reading the button. "See message above" points
        // there instead of duplicating it.
        errorMessage={formError ? 'Sign in failed. See the message above.' : 'Sign in failed.'}
        className="mt-1 w-full"
      >
        Sign in
      </Button>

      <p className="text-center text-[13px] text-(--color-ink-2)">
        New to Kobolink?{' '}
        <Link href="/register" className="font-medium text-(--color-brand) hover:text-(--color-brand-hover)">
          Create an account
        </Link>
      </p>
    </form>
  )
}
