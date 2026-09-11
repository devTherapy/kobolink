import { ANDROID_PACKAGE_NAME, CLAIMED_PATH_PATTERN, IOS_BUNDLE_ID } from '@kobolink/contracts'

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

/**
 * The path pattern the mobile apps are allowed to claim — the single URL
 * contract in `packages/contracts`, not a re-declared literal.
 */
export const CLAIMED_PATH = CLAIMED_PATH_PATTERN

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

const APP_ID_SHAPE = /^([A-Z0-9]{10})\.(.+)$/

/**
 * The literal `APPLE_APP_ID` value documented in the repo's `.env.example`.
 * It is shaped exactly like a real app ID, so if it ever reached production
 * unreplaced a shape check alone would wave it through — and Apple's CDN
 * would then cache that placeholder Team ID for up to 24 hours with no way
 * to invalidate it. Rejected explicitly rather than merely "looks valid".
 */
export const PLACEHOLDER_TEAM_ID = 'ABCDE12345'

/**
 * Validates the `<TEAM_ID>.<bundle id>` shape Apple requires, rejects the
 * `.env.example` placeholder Team ID, and confirms the bundle id is the one
 * app this repo ships (`IOS_BUNDLE_ID` from `packages/contracts`) rather
 * than trusting whatever string the environment happens to hold. Returns
 * `null` when the app ID is safe to serve, or a human-readable reason.
 */
export function validateAppId(appId: string): string | null {
  const match = APP_ID_SHAPE.exec(appId)
  const teamId = match?.[1]
  const bundleId = match?.[2]

  if (!teamId || !bundleId) {
    return `APPLE_APP_ID must be shaped <TEAM_ID>.<bundle id>, e.g. ABCDE12345.${IOS_BUNDLE_ID}`
  }
  if (teamId === PLACEHOLDER_TEAM_ID) {
    return 'APPLE_APP_ID is still the placeholder Team ID from .env.example'
  }
  if (bundleId !== IOS_BUNDLE_ID) {
    return `APPLE_APP_ID's bundle id must be ${IOS_BUNDLE_ID}`
  }
  return null
}

/**
 * Confirms the environment's `ANDROID_PACKAGE_NAME` is the one package this
 * repo ships (`ANDROID_PACKAGE_NAME` from `packages/contracts`), rather than
 * trusting whatever string is configured. Returns `null` when it matches, or
 * a human-readable reason.
 */
export function validateAndroidPackageName(packageName: string): string | null {
  if (packageName !== ANDROID_PACKAGE_NAME) {
    return `ANDROID_PACKAGE_NAME must be ${ANDROID_PACKAGE_NAME}`
  }
  return null
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

export interface FingerprintParseResult {
  /** Normalised (uppercased, trimmed) entries that matched the SHA-256 shape. */
  valid: string[]
  /** Normalised entries that did not — named, not merely dropped, in the caller's error body. */
  invalid: string[]
}

/**
 * Android's own troubleshooting docs list a lowercase fingerprint as a common
 * cause of silent verification failure, so entries are uppercased before
 * validation rather than rejected for case alone.
 *
 * A malformed entry is reported in `invalid`, not silently dropped: §6.3's
 * exact failure mode is a debug fingerprint plus a mistyped Play App Signing
 * fingerprint, where dropping the bad one and serving the good one verifies
 * on the developer's machine and fails in production. The caller is
 * expected to treat a non-empty `invalid` as a configuration error, not a
 * partial success.
 */
export function parseFingerprints(raw: string | undefined): FingerprintParseResult {
  if (!raw) return { valid: [], invalid: [] }

  const valid: string[] = []
  const invalid: string[] = []

  for (const entry of raw.split(',')) {
    const candidate = entry.trim().toUpperCase()
    if (candidate === '') continue
    if (FINGERPRINT.test(candidate)) {
      valid.push(candidate)
    } else {
      invalid.push(candidate)
    }
  }

  return { valid, invalid }
}
