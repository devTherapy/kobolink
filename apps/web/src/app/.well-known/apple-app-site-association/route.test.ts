import { IOS_BUNDLE_ID } from '@kobolink/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLACEHOLDER_TEAM_ID } from '@/lib/associations'
import { GET } from './route'

/**
 * "Served unredirected as `application/json`" is only partly a content-type
 * check — the load-bearing part is that the JSON is exactly what Apple's
 * CDN will cache for up to 24 hours with no way to invalidate it. So these
 * assert full response bodies with `toEqual` against a literal object, not
 * `toMatchObject`: a stray extra field or a wrong shape is exactly the kind
 * of thing `toMatchObject` would let through silently.
 */

// Deliberately not the .env.example placeholder — that value is its own
// rejection case below, so a "happy path" test using it would prove nothing.
const REAL_TEAM_ID = 'ZYXWV98765'
const APP_ID = `${REAL_TEAM_ID}.${IOS_BUNDLE_ID}`

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

  it('503s on the .env.example placeholder Team ID rather than serving it', async () => {
    // This is the scenario the shape check alone would miss: the placeholder
    // is shaped exactly like a real app ID, so copying .env.example without
    // editing it must still 503, not serve a 200 Apple's CDN then caches for
    // up to 24 hours with no way to invalidate it.
    vi.stubEnv('APPLE_APP_ID', `${PLACEHOLDER_TEAM_ID}.${IOS_BUNDLE_ID}`)

    const response = GET()

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/placeholder/i)
  })

  it('503s when APPLE_APP_ID is not shaped <TEAM_ID>.<bundle id>', () => {
    vi.stubEnv('APPLE_APP_ID', 'not-shaped-right')

    const response = GET()

    expect(response.status).toBe(503)
  })

  it('503s when the bundle id does not match the app this repo ships', () => {
    vi.stubEnv('APPLE_APP_ID', `${REAL_TEAM_ID}.com.example.other`)

    const response = GET()

    expect(response.status).toBe(503)
  })
})
