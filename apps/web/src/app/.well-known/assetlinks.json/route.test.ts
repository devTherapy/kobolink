import { ANDROID_PACKAGE_NAME } from '@kobolink/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const FP_A = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const FP_B = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /.well-known/assetlinks.json', () => {
  it('returns the exact assetlinks document for configured env values', async () => {
    vi.stubEnv('ANDROID_PACKAGE_NAME', ANDROID_PACKAGE_NAME)
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', `${FP_A},${FP_B}`)

    const response = GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')

    const body: unknown = await response.json()
    expect(body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE_NAME,
          sha256_cert_fingerprints: [FP_A, FP_B],
        },
      },
    ])
  })

  it('uppercases a lowercase fingerprint rather than shipping it verbatim', async () => {
    vi.stubEnv('ANDROID_PACKAGE_NAME', ANDROID_PACKAGE_NAME)
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', FP_A.toLowerCase())

    const body = (await GET().json()) as { target: { sha256_cert_fingerprints: string[] } }[]

    expect(body[0]?.target.sha256_cert_fingerprints).toEqual([FP_A])
  })

  it('uses the handle_all_urls relation', async () => {
    vi.stubEnv('ANDROID_PACKAGE_NAME', ANDROID_PACKAGE_NAME)
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', FP_A)

    const body = (await GET().json()) as { relation: string[] }[]

    expect(body[0]?.relation).toEqual(['delegate_permission/common.handle_all_urls'])
  })

  it('503s with a JSON error body when ANDROID_PACKAGE_NAME is unconfigured', async () => {
    vi.stubEnv('ANDROID_PACKAGE_NAME', undefined)
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', FP_A)

    const response = GET()

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toEqual({
      error: 'ANDROID_PACKAGE_NAME and at least one valid ANDROID_SHA256_FINGERPRINTS entry are required',
    })
  })

  it('503s when ANDROID_PACKAGE_NAME does not match the package this repo ships', async () => {
    vi.stubEnv('ANDROID_PACKAGE_NAME', 'com.example.other')
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', FP_A)

    const response = GET()

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain(ANDROID_PACKAGE_NAME)
  })

  it('503s when every fingerprint is malformed rather than shipping an empty array', () => {
    vi.stubEnv('ANDROID_PACKAGE_NAME', ANDROID_PACKAGE_NAME)
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', 'not-a-fingerprint')

    const response = GET()

    expect(response.status).toBe(503)
  })

  it('503s and names the malformed entry when only one of several fingerprints is bad — never silently drops it', async () => {
    // §6.3's exact failure mode: a valid debug fingerprint plus a mistyped
    // Play App Signing fingerprint. Serving only the valid one as a 200
    // verifies on the developer's machine and fails in production, because
    // the real fingerprint never shipped.
    vi.stubEnv('ANDROID_PACKAGE_NAME', ANDROID_PACKAGE_NAME)
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', `${FP_A},not-a-fingerprint`)

    const response = GET()

    expect(response.status).toBe(503)
    const body: unknown = await response.json()
    expect(body).toEqual({
      error: 'ANDROID_SHA256_FINGERPRINTS contains malformed entries',
      invalid: ['NOT-A-FINGERPRINT'],
    })
  })

  it('503s when ANDROID_SHA256_FINGERPRINTS is unset', () => {
    vi.stubEnv('ANDROID_PACKAGE_NAME', ANDROID_PACKAGE_NAME)
    vi.stubEnv('ANDROID_SHA256_FINGERPRINTS', undefined)

    const response = GET()

    expect(response.status).toBe(503)
  })
})
