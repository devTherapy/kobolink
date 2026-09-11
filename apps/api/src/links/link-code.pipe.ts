import { Injectable, type PipeTransform } from '@nestjs/common'
import { LinkCodeSchema } from '@kobolink/contracts'
import { ApiErrorException } from '../common/errors/api-error.exception.js'

const NOT_FOUND_MESSAGE = 'Link not found.'

/**
 * `@Param('code', new LinkCodeParamPipe())` on every route that takes a link
 * code. A malformed code (wrong length, a character outside the
 * mistranscription-safe alphabet) must answer exactly like an unknown one —
 * `not_found` 404, never `validation_failed` 400 — so a stranger probing the
 * URL space cannot tell "no such code" apart from "not even a code-shaped
 * string", which is exactly the existence-disclosure `links.item(code)`'s
 * own contract doc rules out for a wrong-merchant link. `ZodValidationPipe`
 * is deliberately not reused here: it always throws `validation_failed`.
 */
@Injectable()
export class LinkCodeParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const result = LinkCodeSchema.safeParse(value)
    if (!result.success) {
      throw new ApiErrorException({ code: 'not_found', message: NOT_FOUND_MESSAGE })
    }
    return result.data
  }
}
