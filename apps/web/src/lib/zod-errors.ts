import type { ZodError } from 'zod'

/**
 * Turns a failed `safeParse`'s issues into the same `Record<string,
 * string[]>` shape `ApiError.fields` uses (`packages/contracts/src/errors.ts`)
 * — so a form's *local* validation and the API's `validation_failed.fields`
 * render through the exact same "error beside the field" code path instead
 * of two subtly different ones.
 *
 * Only the first path segment becomes the key: every request schema a form
 * in this app builds (`LoginRequestSchema`, `RegisterRequestSchema`, …) is a
 * flat object, so a nested path never arises in practice — keeping the whole
 * dotted path would produce keys like `"phone.0"` that no `<Field>` here is
 * ever named after.
 */
export function zodIssuesToFields(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_')
    const existing = fields[key]
    if (existing) {
      existing.push(issue.message)
    } else {
      fields[key] = [issue.message]
    }
  }
  return fields
}

/**
 * The first message per field — what a `<Field error={...}>` actually shows.
 * `ApiError.fields` can carry more than one message per field; a form has
 * exactly one error slot beside each input, so only the first is ever shown.
 */
export function firstFieldErrors(fields: Record<string, string[]>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, messages] of Object.entries(fields)) {
    const first = messages[0]
    if (first !== undefined) result[key] = first
  }
  return result
}

/** A human label for each field a login/register form's client-side schema can fail on. */
const FIELD_LABELS: Record<string, string> = {
  email: 'Email',
  password: 'Password',
  displayName: 'Full name',
  phone: 'Phone number',
}

/**
 * The subset of a Zod v4 issue this needs to read — deliberately not
 * importing `ZodIssue` itself, since the exact shape differs by issue
 * `code` (only `too_small` carries `minimum`) and this only ever reads two
 * fields off it.
 */
interface HumanizableIssue {
  code: string
  message: string
  minimum?: unknown
}

/**
 * Rewrites one Zod issue into copy a merchant filling in a form should
 * actually read, instead of Zod v4's schema-author-facing default (`"Too
 * small: expected string to have >=10 characters"`). Both `LoginForm` and
 * `RegisterForm` are `noValidate`, so this client-side message is the *only*
 * thing standing between an empty required field and that raw string — it
 * sits directly under copy like "At least 10 characters." on the primary
 * conversion screen, so it has to read as prose, not as a schema dump.
 *
 * Only handles the shapes this app's own request schemas can actually
 * produce (`too_small` on a length-bounded string, `invalid_format` on
 * email/phone); anything else falls back to the schema's own message rather
 * than guessing at copy for a case that isn't known to occur.
 */
export function humanizeFieldIssue(field: string, issue: HumanizableIssue): string {
  const label = FIELD_LABELS[field] ?? field

  if (issue.code === 'too_small') {
    const minimum = typeof issue.minimum === 'number' ? issue.minimum : undefined
    // `min(1)` (login's password, a required name) means "don't leave this
    // blank," not a length requirement worth stating as a number.
    if (minimum !== undefined && minimum > 1) {
      return `${label} must be at least ${minimum} characters.`
    }
    return `${label} is required.`
  }

  if (issue.code === 'invalid_format' || issue.code === 'invalid_string') {
    if (field === 'email') return 'Enter a valid email address.'
    if (field === 'phone') return 'Enter a valid Nigerian mobile number.'
  }

  return issue.message
}

/**
 * `firstFieldErrors(zodIssuesToFields(error))`, but routed through
 * `humanizeFieldIssue` first — the client-side equivalent of
 * `firstFieldErrors` for a form's own `safeParse` failures, as opposed to
 * the API's already-human `validation_failed.fields` messages (which need no
 * rewriting and keep using `firstFieldErrors` directly).
 */
export function humanFieldErrors(error: ZodError): Record<string, string> {
  const result: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_')
    if (key in result) continue
    result[key] = humanizeFieldIssue(key, issue)
  }
  return result
}
