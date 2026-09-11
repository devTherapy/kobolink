// F9 wires this in. This file is intentionally excluded from
// apps/web/tsconfig.json's project (see its "exclude": [..., "e2e"] entry)
// and from ESLint (see eslint.config.mjs's "e2e/**" ignore), because
// @playwright/test is not a dependency of this workspace — adding it here
// would make every `npm ci` (CI included) resolve and install the full
// Playwright package for a suite that does not run yet. Once F9 adds the
// dependency, a playwright.config.ts, and a test:e2e script, remove both
// exclusions; this spec should typecheck and run unchanged.
import { ANDROID_PACKAGE_NAME } from '@kobolink/contracts'
import { expect, test } from '@playwright/test'

/**
 * The deep-link contract, tested against a real running server.
 *
 * These run without Firestore: the association handlers read only the
 * environment. They are the cheapest possible guard on the thing most likely
 * to break silently in production.
 *
 * `EXPECTED_APP_ID` is the same env var `scripts/smoke-associations.sh`
 * (`npm run smoke`) reads — set it to whatever `APPLE_APP_ID` the server
 * under test was started with. There is no safe placeholder default: an app
 * ID is environment-specific, and a hardcoded fallback here would drift from
 * whatever the server actually serves the moment someone changes it.
 */

interface AasaBody {
  applinks: {
    details: {
      appIDs: string[]
      components: { '/': string; exclude?: boolean }[]
    }[]
  }
}

interface AssetLinksEntry {
  relation: string[]
  target: { package_name: string; sha256_cert_fingerprints: string[] }
}

test.describe('association files', () => {
  test('AASA is served as JSON, unredirected, claiming the right app and path', async ({ request }) => {
    const expectedAppId = process.env.EXPECTED_APP_ID
    test.skip(!expectedAppId, 'set EXPECTED_APP_ID to the APPLE_APP_ID the server under test was started with')

    const response = await request.get('/.well-known/apple-app-site-association', {
      maxRedirects: 0,
    })
    expect(response.status(), 'a redirect here fails Apple validation outright').toBe(200)
    expect(response.headers()['content-type']).toContain('application/json')

    const body = (await response.json()) as AasaBody
    const detail = body.applinks.details[0]
    expect(detail?.appIDs).toContain(expectedAppId)
    expect(detail?.components).toContainEqual(
      expect.objectContaining({ '/': '/l/*' }),
    )
    expect(detail?.components).toContainEqual(
      expect.objectContaining({ '/': '/.well-known/*', exclude: true }),
    )
    // TN3155: mixing the legacy `paths` array with `components` is undefined.
    expect(detail).not.toHaveProperty('paths')
  })

  test('assetlinks.json names the package with an uppercase fingerprint', async ({ request }) => {
    const response = await request.get('/.well-known/assetlinks.json', { maxRedirects: 0 })
    expect(response.status()).toBe(200)

    const [entry] = (await response.json()) as AssetLinksEntry[]
    expect(entry?.relation).toEqual(['delegate_permission/common.handle_all_urls'])
    expect(entry?.target.package_name).toBe(ANDROID_PACKAGE_NAME)
    expect(entry?.target.sha256_cert_fingerprints.length).toBeGreaterThan(0)
    for (const fingerprint of entry?.target.sha256_cert_fingerprints ?? []) {
      expect(fingerprint, 'lowercase fingerprints fail verification silently').toMatch(
        /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
      )
    }
  })
})
