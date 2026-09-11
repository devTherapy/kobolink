import { buildAssetLinks, parseFingerprints, validateAndroidPackageName } from '@/lib/associations'

export const dynamic = 'force-dynamic'

function unavailable(error: string, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error, ...extra }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })
}

const MISSING_CONFIG_ERROR =
  'ANDROID_PACKAGE_NAME and at least one valid ANDROID_SHA256_FINGERPRINTS entry are required'

export function GET() {
  const packageName = process.env.ANDROID_PACKAGE_NAME
  const { valid: fingerprints, invalid } = parseFingerprints(process.env.ANDROID_SHA256_FINGERPRINTS)

  if (!packageName) {
    return unavailable(MISSING_CONFIG_ERROR)
  }

  const packageNameError = validateAndroidPackageName(packageName)
  if (packageNameError) {
    return unavailable(packageNameError)
  }

  // A malformed fingerprint is never silently dropped: shipping only the
  // entries that happen to be well-formed is exactly how a mistyped Play App
  // Signing fingerprint verifies on a developer's machine (the debug
  // fingerprint still works) and fails in production (the real one never
  // shipped).
  if (invalid.length > 0) {
    return unavailable('ANDROID_SHA256_FINGERPRINTS contains malformed entries', { invalid })
  }

  if (fingerprints.length === 0) {
    return unavailable(MISSING_CONFIG_ERROR)
  }

  return new Response(JSON.stringify(buildAssetLinks({ packageName, fingerprints })), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  })
}
