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
