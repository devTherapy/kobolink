/**
 * The two association documents that make a URL open a native app.
 *
 * They are built here as pure functions so they can be unit-tested without a
 * server, and served from Route Handlers rather than static files so that
 * (a) the Team ID and signing fingerprints come from the environment, and
 * (b) no host's "ignore dot-directories" rule can silently drop them from a
 *     deploy — the classic way /.well-known/* 404s in production while
 *     working perfectly in local dev.
 */

/** The path patterns the mobile apps are allowed to claim. */
export const CLAIMED_PATH = '/l/*'

export interface AasaOptions {
  /** "<TEAM_ID>.<bundle id>", e.g. ABCDE12345.com.folusayo.kobolink */
  appId: string
}

export function buildAasa({ appId }: AasaOptions) {
  return {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: [
            { '/': CLAIMED_PATH, comment: 'Payment link' },
            // Never let the app claim the association files themselves.
            { '/': '/.well-known/*', exclude: true, comment: 'Association files' },
          ],
        },
      ],
    },
  }
  // Note: this is the appIDs + components format (iOS 13+). Apple's TN3155
  // warns against mixing it with the legacy appID + paths array in one file,
  // so we deliberately emit only this shape.
}

export interface AssetLinksOptions {
  packageName: string
  /** UPPERCASE, colon-separated SHA-256 fingerprints. */
  fingerprints: string[]
}

export function buildAssetLinks({ packageName, fingerprints }: AssetLinksOptions) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]
}

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/

/**
 * Android's own troubleshooting docs list a lowercase fingerprint as a common
 * cause of silent verification failure, so we normalise and reject rather than
 * ship something that looks right and never verifies.
 */
export function parseFingerprints(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f) => FINGERPRINT.test(f))
}
