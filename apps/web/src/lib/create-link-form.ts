import {
  CreateLinkRequestSchema,
  MAX_AMOUNT_KOBO,
  MIN_AMOUNT_KOBO,
  formatNaira,
  isValidAmountKobo,
  parseNaira,
  type CreateLinkRequest,
} from '@kobolink/contracts'
import { humanFieldErrors } from './zod-errors'

/** The form's inputs, as typed — everything is still a string here. */
export interface CreateLinkFormValues {
  title: string
  description: string
  /** Naira as the merchant typed it; blank means "the payer chooses". */
  amountText: string
  isReusable: boolean
  /** `YYYY-MM-DD` from `<input type="date">`; blank means "never expires". */
  expiresOn: string
}

/** Keys are the form's own fields, not the request's (`amountKobo` -> `amount`). */
export type CreateLinkFieldName = 'title' | 'description' | 'amount' | 'expiresOn'
export type CreateLinkFieldErrors = Partial<Record<CreateLinkFieldName, string>>

/** Top-to-bottom — the first invalid field in this order is the one focus lands on. */
export const CREATE_LINK_FIELD_ORDER: readonly CreateLinkFieldName[] = ['title', 'description', 'amount', 'expiresOn']

export type CreateLinkValidation =
  | { ok: true; request: CreateLinkRequest }
  | { ok: false; errors: CreateLinkFieldErrors }

/**
 * `ApiError.fields` is keyed by the *request's* names; the form's inputs are
 * named for what the merchant sees. Anything the form has no input to carry
 * an error (`isReusable` is a checkbox that cannot be invalid) maps to `null`.
 */
const REQUEST_FIELD_TO_FORM_FIELD: Record<string, CreateLinkFieldName | null> = {
  title: 'title',
  description: 'description',
  amountKobo: 'amount',
  expiresAt: 'expiresOn',
  isReusable: null,
}

export function formFieldErrorsFromApi(fields: Record<string, string[]>): CreateLinkFieldErrors {
  const errors: CreateLinkFieldErrors = {}
  for (const [requestField, messages] of Object.entries(fields)) {
    const formField = REQUEST_FIELD_TO_FORM_FIELD[requestField]
    const first = messages[0]
    if (formField && first !== undefined && errors[formField] === undefined) errors[formField] = first
  }
  return errors
}

/**
 * End of the chosen day in the merchant's own timezone. A date picker
 * answers "which day", and "expires on the 14th" means the link works
 * through the 14th — midnight at its start would kill it a day early.
 */
function endOfLocalDay(expiresOn: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresOn)
  if (!match) return null
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 0)
  // `new Date(2026, 1, 31)` silently rolls over to March; a typed-in
  // impossible date must be rejected, not quietly moved.
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null
  return date
}

/**
 * Today in the merchant's own timezone as `YYYY-MM-DD` — the `min` of the
 * expiry picker. Local parts, not `toISOString()`, which is UTC and would
 * name tomorrow (or yesterday) for a merchant near midnight; it matches
 * `endOfLocalDay`, which is what "today or a later date" is judged against.
 */
export function todayLocalDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${String(now.getFullYear()).padStart(4, '0')}-${month}-${day}`
}

function amountRangeMessage(): string {
  return `Enter an amount between ${formatNaira(MIN_AMOUNT_KOBO)} and ${formatNaira(MAX_AMOUNT_KOBO)}.`
}

/**
 * The one place the form's strings become a `CreateLinkRequest`. Amount goes
 * through `parseNaira` (`packages/contracts`) and nothing else — this file
 * never multiplies or divides by 100 — and the finished request is
 * round-tripped through `CreateLinkRequestSchema`, the same schema the API
 * enforces, so a field the form forgot to check still can't reach the wire in
 * a shape the server would reject. `now` is a parameter so the "must not be
 * in the past" rule is testable.
 */
export function validateCreateLink(values: CreateLinkFormValues, now: Date = new Date()): CreateLinkValidation {
  const errors: CreateLinkFieldErrors = {}

  let amountKobo: number | null = null
  const amountText = values.amountText.trim()
  if (amountText !== '') {
    const parsed = parseNaira(amountText)
    if (parsed === null) {
      errors.amount = 'Enter an amount like 18,500 or 18,500.50.'
    } else if (!isValidAmountKobo(parsed)) {
      errors.amount = amountRangeMessage()
    } else {
      amountKobo = parsed
    }
  }

  let expiresAt: string | null = null
  if (values.expiresOn !== '') {
    const end = endOfLocalDay(values.expiresOn)
    if (end === null) {
      errors.expiresOn = 'Enter a valid date.'
    } else if (end.getTime() <= now.getTime()) {
      errors.expiresOn = 'Pick today or a later date.'
    } else {
      expiresAt = end.toISOString()
    }
  }

  const description = values.description.trim()
  const parsedRequest = CreateLinkRequestSchema.safeParse({
    title: values.title,
    ...(description === '' ? {} : { description }),
    amountKobo,
    isReusable: values.isReusable,
    expiresAt,
  })
  if (!parsedRequest.success) {
    const fromSchema = humanFieldErrors(parsedRequest.error)
    if (fromSchema.title !== undefined) errors.title = fromSchema.title
    if (fromSchema.description !== undefined) errors.description = fromSchema.description
    // Amount/expiry were already described above in clearer words; these only
    // backstop a case the hand-written checks above somehow let through.
    if (fromSchema.amountKobo !== undefined) errors.amount ??= amountRangeMessage()
    if (fromSchema.expiresAt !== undefined) errors.expiresOn ??= 'Enter a valid date.'
  }

  if (!parsedRequest.success || Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, request: parsedRequest.data }
}
