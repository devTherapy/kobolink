import { buildAssetLinks, parseFingerprints } from '@/lib/associations'

export const dynamic = 'force-dynamic'

export function GET() {
  const packageName = process.env.ANDROID_PACKAGE_NAME
  const fingerprints = parseFingerprints(process.env.ANDROID_SHA256_FINGERPRINTS)

  if (!packageName || fingerprints.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          'ANDROID_PACKAGE_NAME and at least one valid ANDROID_SHA256_FINGERPRINTS entry are required',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }

  return new Response(JSON.stringify(buildAssetLinks({ packageName, fingerprints })), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  })
}
