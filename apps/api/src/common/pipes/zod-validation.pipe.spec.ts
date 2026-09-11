import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ApiError } from '@kobolink/contracts'
import { ZodValidationPipe } from './zod-validation.pipe.js'

const BodySchema = z.object({
  title: z.string().min(1),
  amountKobo: z.int().min(1),
})

describe('ZodValidationPipe', () => {
  it('returns the parsed value on success, including defaults and transforms', () => {
    const pipe = new ZodValidationPipe(z.object({ limit: z.coerce.number().int().default(20) }))

    expect(pipe.transform({})).toEqual({ limit: 20 })
  })

  it('throws a BadRequestException carrying an ApiError with validation_failed', () => {
    const pipe = new ZodValidationPipe(BodySchema)

    expect(() => pipe.transform({ title: '', amountKobo: -1 })).toThrow(BadRequestException)
  })

  it('keys fields by the request path so a form can show the error beside the input', () => {
    const pipe = new ZodValidationPipe(BodySchema)

    try {
      pipe.transform({ title: '', amountKobo: -1 })
      expect.unreachable('expected transform to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException)
      const body = (error as BadRequestException).getResponse() as ApiError
      expect(body.code).toBe('validation_failed')
      expect(body.fields).toBeDefined()
      expect(Object.keys(body.fields ?? {})).toEqual(expect.arrayContaining(['title', 'amountKobo']))
    }
  })

  it('keys whole-object refinement issues under "_" rather than dropping them', () => {
    const schema = z
      .object({ a: z.string(), b: z.string() })
      .refine((value) => value.a !== value.b, { message: 'a and b must differ' })
    const pipe = new ZodValidationPipe(schema)

    try {
      pipe.transform({ a: 'x', b: 'x' })
      expect.unreachable('expected transform to throw')
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as ApiError
      expect(body.fields?._).toEqual(['a and b must differ'])
    }
  })
})
