import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common'
import type { ApiError } from '@kobolink/contracts'
import type { ZodType } from 'zod'

/**
 * Parses `value` against `schema` and returns the parsed (transformed,
 * defaulted) result. On failure throws a `BadRequestException` whose body is
 * already an `ApiError` with `code: 'validation_failed'` and `fields` keyed
 * by the request field — `HttpExceptionFilter` recognises that shape and
 * forwards it untouched, so a form can show the error beside the input.
 *
 * Usage: `@Body(new ZodValidationPipe(CreateLinkRequestSchema)) body: CreateLinkRequest`.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value)
    if (result.success) {
      return result.data
    }

    const fields: Record<string, string[]> = {}
    for (const issue of result.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : '_'
      fields[key] = [...(fields[key] ?? []), issue.message]
    }

    const body: ApiError = {
      code: 'validation_failed',
      message: 'Validation failed.',
      fields,
    }
    throw new BadRequestException(body)
  }
}
