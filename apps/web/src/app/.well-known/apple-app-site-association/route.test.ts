import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

/**
 * "Served unredirected as `application/json`" is only partly a content-type
 * check — the load-bearing part is that the JSON is exactly what Apple's
 * CDN will cache for up to 24 hours with no way to invalidate it. So these
 * assert full response bodies with `toEqual` against a literal object, not
 * `toMatchObject`: a stray extra field or a wrong shape is exactly the kind
 * of thing `toMatchObject` would let through silently.
 */

const APP_ID = 'ABCDE12345.com.folusayo.kobolink'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /.well-known/apple-app-site-association', () => {
  it('returns the exact AASA document for a configured APPLE_APP_ID', async () => {
    vi.stubEnv('APPLE_APP_ID', APP_ID)

    const response = GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')

    const body: unknown = await response.json()
    expect(body).toEqual({
      applinks: {
        details: [
          {
            appIDs: [APP_ID],
            components: [
              { '/': '/l/*', comment: 'Payment link' },
              { '/': '/.well-known/*', exclude: true, comment: 'Association files' },
            ],
          },
        ],
      },
    })
  })

  it('uses appIDs + components only — TN3155 forbids mixing in the legacy appID/paths shape', async () => {
    vi.stubEnv('APPLE_APP_ID', APP_ID)

    const body = (await GET().json()) as { applinks: { details: Record<string, unknown>[] } }
    const detail = body.applinks.details[0]

    expect(detail).toHaveProperty('appIDs')
    expect(detail).not.toHaveProperty('appID')
    expect(detail).not.toHaveProperty('paths')
  })

  it('excludes /.well-known/* so the app can never claim the association files themselves', async () => {
    vi.stubEnv('APPLE_APP_ID', APP_ID)

    const body = (await GET().json()) as {
      applinks: { details: { components: { '/': string; exclude?: boolean }[] }[] }
    }
    const excluded = body.applinks.details[0]?.components.find((c) => c['/'] === '/.well-known/*')

    expect(excluded).toEqual({ '/': '/.well-known/*', exclude: true, comment: 'Association files' })
  })

  it('503s with a JSON error body when APPLE_APP_ID is unconfigured — never a 200 carrying a placeholder', async () => {
    vi.stubEnv('APPLE_APP_ID', undefined)

    const response = GET()

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toEqual({ error: 'APPLE_APP_ID is not configured' })
  })

  it('503s rather than serving an empty-string Team ID', () => {
    vi.stubEnv('APPLE_APP_ID', '')

    const response = GET()

    expect(response.status).toBe(503)
  })
})
