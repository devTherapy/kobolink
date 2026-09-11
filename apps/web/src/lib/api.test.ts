import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { ApiRequestError, client } from './api'

/**
 * A non-2xx response is not guaranteed to be JSON at all — a proxy's HTML
 * error page, a server that isn't running yet. `request()` must not let
 * `JSON.parse` throw a raw `SyntaxError` before it gets a chance to fall
 * through to `transportError` and raise the typed `ApiRequestError` every
 * caller already handles.
 */
describe('api client: non-JSON error bodies', () => {
  it('surfaces a 502 HTML error page as a typed ApiRequestError, not a SyntaxError', async () => {
    server.use(
      http.get(API.dashboard.stats, () => new HttpResponse('<html><body>Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })),
    )

    await expect(client.dashboard.stats()).rejects.toBeInstanceOf(ApiRequestError)

    try {
      await client.dashboard.stats()
      expect.unreachable('client.dashboard.stats() should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError)
      const apiError = error as ApiRequestError
      expect(apiError.status).toBe(502)
      expect(apiError.error.code).toBe('internal')
    }
  })
})

/**
 * `ApiRequestError.transport` is what actually lets a caller (F6's result
 * screen, eventually) tell "we could not reach the API at all" from "the
 * API told us it failed" — the two cases the class's own doc comment
 * promises to distinguish.
 */
describe('ApiRequestError.transport', () => {
  it('is true when the response body is not a well-formed ApiError — the API never really answered', async () => {
    server.use(
      http.get(API.dashboard.stats, () => new HttpResponse('<html><body>Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })),
    )

    try {
      await client.dashboard.stats()
      expect.unreachable('client.dashboard.stats() should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError)
      expect((error as ApiRequestError).transport).toBe(true)
    }
  })

  it('is false when the API answered with a well-formed ApiError', async () => {
    server.use(
      http.get(API.dashboard.stats, () =>
        HttpResponse.json({ code: 'internal', message: 'Something went wrong.' }, { status: 500 }),
      ),
    )

    try {
      await client.dashboard.stats()
      expect.unreachable('client.dashboard.stats() should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError)
      expect((error as ApiRequestError).transport).toBe(false)
    }
  })
})

/**
 * `API.links.item(code)` etc. are plain template strings — `code` reaches
 * the URL path unencoded. Validating it against the same `LinkCodeSchema`
 * the server enforces means a malformed value is rejected here, as the
 * `not_found` the server would answer anyway, without spending a request.
 */
describe('api client: link codes are validated before they reach a URL path', () => {
  it('rejects a malformed code with a typed not_found error, synchronously enough to still be catchable', async () => {
    await expect(client.links.resolve('not a valid code')).rejects.toMatchObject({
      status: 404,
      transport: false,
      error: { code: 'not_found' },
    })
  })

  it('rejects a malformed code for links.get and links.payments too', async () => {
    await expect(client.links.get('short')).rejects.toMatchObject({ error: { code: 'not_found' } })
    await expect(client.links.payments('short')).rejects.toMatchObject({ error: { code: 'not_found' } })
  })
})
