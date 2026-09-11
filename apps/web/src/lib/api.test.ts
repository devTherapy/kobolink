import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { ApiRequestError, client } from './api'

/**
 * Finding 8: a non-2xx response is not guaranteed to be JSON — a proxy's
 * HTML error page, a server that isn't running yet. `request()` must not let
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
