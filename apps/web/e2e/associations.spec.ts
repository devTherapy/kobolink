import { expect, test } from '@playwright/test'

/**
 * The deep-link contract, tested against a real running server.
 *
 * These run without Firestore: the association handlers read only the
 * environment. They are the cheapest possible guard on the thing most likely
 * to break silently in production.
 *
 * Not wired into CI yet — no `playwright.config.ts` and no `test:e2e` script
 * in this workspace's `package.json`. F9 owns wiring Playwright in; this file
 * only needs to sit here typechecked and ready for that PR to pick up.
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
    const response = await request.get('/.well-known/apple-app-site-association', {
      maxRedirects: 0,
    })
    expect(response.status(), 'a redirect here fails Apple validation outright').toBe(200)
    expect(response.headers()['content-type']).toContain('application/json')

    const body = (await response.json()) as AasaBody
    const detail = body.applinks.details[0]
    expect(detail?.appIDs).toContain('ABCDE12345.com.folusayo.kobolink')
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
    expect(entry?.target.package_name).toBe('com.folusayo.kobolink')
    expect(entry?.target.sha256_cert_fingerprints.length).toBeGreaterThan(0)
    for (const fingerprint of entry?.target.sha256_cert_fingerprints ?? []) {
      expect(fingerprint, 'lowercase fingerprints fail verification silently').toMatch(
        /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
      )
    }
  })
})
