import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { API, exampleLink, examplePayment } from '@kobolink/contracts'
import { MOCK_SESSION_COOKIE_NAME, MOCK_SESSION_TOKEN } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { paymentsByCode } from '@/mocks/state'
import { ApiRequestError } from './api'
import { LinkDetailUnavailableError, loadLinkDetail } from './link-detail'
import { describeStatusFailure } from './link-status'

const VALID_COOKIE = `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_TOKEN}`

/** `redirect()` throws a tagged error; this stands in for it so a test can see where it pointed. */
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`)
  },
}))

describe('loadLinkDetail', () => {
  it('loads the link and its first page of payments together', async () => {
    const data = await loadLinkDetail('aBcDeFgH', VALID_COOKIE)

    expect(data.found).toBe(true)
    if (!data.found) return
    expect(data.data.link).toMatchObject({ code: 'aBcDeFgH', title: 'Ankara Two-Piece Set' })
    expect(data.data.payments.items).toHaveLength(3)
    expect(data.data.payments.nextCursor).toBeNull()
  })

  it('carries the cursor of a longer list through untouched', async () => {
    server.use(
      http.get(API.links.payments(':code'), () =>
        HttpResponse.json({ items: [examplePayment()], nextCursor: 'cur_next' }),
      ),
    )

    const data = await loadLinkDetail('aBcDeFgH', VALID_COOKIE)

    expect(data.found && data.data.payments.nextCursor).toBe('cur_next')
  })

  it('forwards the session cookie to both requests', async () => {
    const seen: (string | null)[] = []
    server.use(
      http.get(API.links.item(':code'), ({ request }) => {
        seen.push(request.headers.get('cookie'))
        return HttpResponse.json(exampleLink())
      }),
      http.get(API.links.payments(':code'), ({ request }) => {
        seen.push(request.headers.get('cookie'))
        return HttpResponse.json({ items: [], nextCursor: null })
      }),
    )

    await loadLinkDetail('aBcDeFgH', VALID_COOKIE)

    expect(seen).toEqual([VALID_COOKIE, VALID_COOKIE])
  })

  it('answers { found: false } for a link the API 404s — another merchant\'s looks exactly like a missing one', async () => {
    server.use(
      http.get(API.links.item(':code'), () =>
        HttpResponse.json({ code: 'not_found', message: 'Link not found.' }, { status: 404 }),
      ),
      http.get(API.links.payments(':code'), () =>
        HttpResponse.json({ code: 'not_found', message: 'Link not found.' }, { status: 404 }),
      ),
    )

    await expect(loadLinkDetail('aBcDeFgH', VALID_COOKIE)).resolves.toEqual({ found: false })
  })

  it('answers { found: false } for a malformed code without spending a request', async () => {
    let requests = 0
    server.use(
      http.get(API.links.item(':code'), () => {
        requests += 1
        return HttpResponse.json(exampleLink())
      }),
    )

    await expect(loadLinkDetail('not a code', VALID_COOKIE)).resolves.toEqual({ found: false })
    expect(requests).toBe(0)
  })

  it('treats a 404 from either endpoint alone as not found', async () => {
    paymentsByCode.delete('aBcDeFgH')
    server.use(
      http.get(API.links.payments(':code'), () =>
        HttpResponse.json({ code: 'not_found', message: 'Link not found.' }, { status: 404 }),
      ),
    )

    await expect(loadLinkDetail('aBcDeFgH', VALID_COOKIE)).resolves.toEqual({ found: false })
  })

  it('maps a 5xx to LinkDetailUnavailableError — "we do not know", not "it does not exist"', async () => {
    server.use(
      http.get(API.links.item(':code'), () => HttpResponse.json({ code: 'internal', message: 'boom' }, { status: 500 })),
    )

    await expect(loadLinkDetail('aBcDeFgH', VALID_COOKIE)).rejects.toThrow(LinkDetailUnavailableError)
  })

  it('maps a dropped connection to LinkDetailUnavailableError and keeps the cause', async () => {
    server.use(http.get(API.links.item(':code'), () => HttpResponse.error()))

    const error = await loadLinkDetail('aBcDeFgH', VALID_COOKIE).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LinkDetailUnavailableError)
    expect((error as LinkDetailUnavailableError).cause).toBeDefined()
  })

  it('sends a session that expired mid-request to login, and back to this link afterwards', async () => {
    server.use(
      http.get(API.links.item(':code'), () =>
        HttpResponse.json({ code: 'unauthenticated', message: 'Sign in.' }, { status: 401 }),
      ),
    )

    await expect(loadLinkDetail('aBcDeFgH', VALID_COOKIE)).rejects.toThrow(
      'NEXT_REDIRECT:/login?next=%2Fdashboard%2Flinks%2FaBcDeFgH',
    )
  })
})

describe('describeStatusFailure', () => {
  const api = (code: ApiRequestError['error']['code'], status: number) =>
    new ApiRequestError(status, { code, message: 'x' })

  it('says what was attempted, what the link really is, and that no payments were affected', () => {
    const off = describeStatusFailure(api('internal', 500), 'disabled')
    expect(off).toMatch(/couldn't turn off this link/i)
    expect(off).toMatch(/still accepting payments/i)
    expect(off).toMatch(/no payments were affected/i)

    const on = describeStatusFailure(api('internal', 500), 'active')
    expect(on).toMatch(/couldn't turn on this link/i)
    expect(on).toMatch(/still turned off/i)
  })

  it('gives a dropped connection the same plain answer as a 5xx', () => {
    expect(describeStatusFailure(new TypeError('fetch failed'), 'disabled')).toMatch(/couldn't turn off this link/i)
  })

  it.each([
    ['unauthenticated', 401, /session has expired/i],
    ['not_found', 404, /no longer exists/i],
    ['forbidden', 403, /isn't allowed/i],
    ['rate_limited', 429, /too many changes/i],
  ] as const)('names a %s answer in its own words', (code, status, expected) => {
    expect(describeStatusFailure(api(code, status), 'disabled')).toMatch(expected)
  })
})
