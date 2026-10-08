import { describe, expect, it } from 'vitest'
import { CreateLinkRequestSchema } from '@kobolink/contracts'
import { formFieldErrorsFromApi, todayLocalDate, validateCreateLink, type CreateLinkFormValues } from './create-link-form'

// Noon on 14 Oct 2026, local time — the "today" every date rule below is measured against.
const NOW = new Date(2026, 9, 14, 12, 0, 0)

const VALID: CreateLinkFormValues = {
  title: 'Ankara two-piece set',
  description: '',
  amountText: '18,500',
  isReusable: false,
  expiresOn: '',
}

function ok(values: Partial<CreateLinkFormValues>) {
  const result = validateCreateLink({ ...VALID, ...values }, NOW)
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`)
  return result.request
}

function errors(values: Partial<CreateLinkFormValues>) {
  const result = validateCreateLink({ ...VALID, ...values }, NOW)
  if (result.ok) throw new Error('expected validation to fail')
  return result.errors
}

describe('validateCreateLink — amount goes through parseNaira, in kobo', () => {
  it('turns naira text into integer kobo', () => {
    expect(ok({ amountText: '18,500' }).amountKobo).toBe(1_850_000)
    expect(ok({ amountText: '₦18,500.50' }).amountKobo).toBe(1_850_050)
  })

  it('reads a blank amount as "the payer chooses" (null), not as zero', () => {
    expect(ok({ amountText: '   ' }).amountKobo).toBeNull()
  })

  it('rejects unreadable text beside the amount field', () => {
    expect(errors({ amountText: 'abc' }).amount).toMatch(/enter an amount like/i)
    expect(errors({ amountText: '10.999' }).amount).toMatch(/enter an amount like/i)
  })

  it('rejects an amount outside the chargeable range, naming the bounds', () => {
    expect(errors({ amountText: '50' }).amount).toBe('Enter an amount between ₦100 and ₦10,000,000.')
    expect(errors({ amountText: '10,000,001' }).amount).toBe('Enter an amount between ₦100 and ₦10,000,000.')
  })
})

describe('validateCreateLink — title and description', () => {
  it('requires a title, in prose rather than a schema dump', () => {
    expect(errors({ title: '   ' }).title).toBe('Title is required.')
  })

  it('caps the title and description at the contract limits', () => {
    expect(errors({ title: 'x'.repeat(121) }).title).toBe('Title must be at most 120 characters.')
    expect(errors({ description: 'x'.repeat(501) }).description).toBe('Description must be at most 500 characters.')
  })

  it('omits a blank description from the request and trims a real one', () => {
    expect('description' in ok({ description: '   ' })).toBe(false)
    expect(ok({ description: '  Hand-sewn  ' }).description).toBe('Hand-sewn')
  })

  it('reports every invalid field at once, not just the first', () => {
    expect(Object.keys(errors({ title: '', amountText: 'abc' })).sort()).toEqual(['amount', 'title'])
  })
})

describe('validateCreateLink — expiry', () => {
  it('turns the chosen day into the end of that local day, as an instant', () => {
    const { expiresAt } = ok({ expiresOn: '2026-10-20' })
    expect(new Date(expiresAt ?? '').getTime()).toBe(new Date(2026, 9, 20, 23, 59, 59).getTime())
  })

  it('accepts today (the link works through the end of the day) but not yesterday', () => {
    expect(ok({ expiresOn: '2026-10-14' }).expiresAt).not.toBeNull()
    expect(errors({ expiresOn: '2026-10-13' }).expiresOn).toBe('Pick today or a later date.')
  })

  it('rejects an impossible date instead of rolling it into the next month', () => {
    expect(errors({ expiresOn: '2026-02-31' }).expiresOn).toBe('Enter a valid date.')
  })

  it('carries isReusable through untouched', () => {
    expect(ok({ isReusable: true }).isReusable).toBe(true)
  })
})

describe('validateCreateLink — what it returns is exactly a CreateLinkRequest', () => {
  it('round-trips through the contract schema unchanged', () => {
    const request = ok({ description: 'Hand-sewn', expiresOn: '2026-10-20', isReusable: true })
    expect(CreateLinkRequestSchema.parse(request)).toEqual(request)
  })
})

describe('formFieldErrorsFromApi — the API names request fields, the form names inputs', () => {
  it('maps amountKobo/expiresAt onto the amount and expiry inputs, first message only', () => {
    expect(
      formFieldErrorsFromApi({ title: ['Too short', 'ignored'], amountKobo: ['Too small'], expiresAt: ['Bad date'] }),
    ).toEqual({ title: 'Too short', amount: 'Too small', expiresOn: 'Bad date' })
  })

  it('drops a field the form has no input to show it beside', () => {
    expect(formFieldErrorsFromApi({ isReusable: ['nope'], mystery: ['nope'] })).toEqual({})
  })
})

describe('todayLocalDate', () => {
  it('is the local calendar day, zero-padded', () => {
    expect(todayLocalDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(todayLocalDate(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31')
  })
})
