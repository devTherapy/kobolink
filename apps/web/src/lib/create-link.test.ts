import { describe, expect, it, vi } from 'vitest'
import { exampleLink, type ApiError, type CreateLinkRequest } from '@kobolink/contracts'
import { ApiRequestError } from './api'
import { MAX_CONFLICT_RETRIES, createLinkWithRetry } from './create-link'

const REQUEST: CreateLinkRequest = {
  title: 'Ankara set',
  amountKobo: 1_850_000,
  isReusable: false,
  expiresAt: null,
}

function apiError(status: number, error: ApiError, transport = false) {
  return new ApiRequestError(status, error, transport)
}
const conflict = () => apiError(409, { code: 'conflict', message: 'Could not allocate a unique link code. Try again.' })

describe('createLinkWithRetry — a duplicate code retries invisibly', () => {
  it('returns the link from the first attempt without retrying when it succeeds', async () => {
    const link = exampleLink()
    const create = vi.fn().mockResolvedValue(link)

    await expect(createLinkWithRetry(REQUEST, create)).resolves.toBe(link)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('swallows a conflict and resubmits the same body, resolving with the later success', async () => {
    const link = exampleLink()
    const create = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce(link)

    await expect(createLinkWithRetry(REQUEST, create)).resolves.toBe(link)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenNthCalledWith(2, REQUEST)
  })

  it('gives up after the bounded number of retries and surfaces the last conflict', async () => {
    const create = vi.fn().mockRejectedValue(conflict())

    await expect(createLinkWithRetry(REQUEST, create)).rejects.toMatchObject({ error: { code: 'conflict' } })
    expect(create).toHaveBeenCalledTimes(1 + MAX_CONFLICT_RETRIES)
  })

  it.each([
    ['validation_failed', 400],
    ['unauthenticated', 401],
    ['rate_limited', 429],
    ['internal', 500],
  ] as const)('does not retry %s — only a collision is safe to resubmit', async (code, status) => {
    const create = vi.fn().mockRejectedValue(apiError(status, { code, message: 'nope' }))

    await expect(createLinkWithRetry(REQUEST, create)).rejects.toMatchObject({ error: { code } })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not retry a transport failure: the request may have created the link already', async () => {
    const create = vi.fn().mockRejectedValue(apiError(502, { code: 'internal', message: 'Bad Gateway' }, true))

    await expect(createLinkWithRetry(REQUEST, create)).rejects.toMatchObject({ transport: true })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
