import { buildAasa } from '@/lib/associations'

// Rendered per request so the Team ID comes from the environment, and cached
// hard at the edge afterwards — Apple's CDN fetches this at most daily.
export const dynamic = 'force-dynamic'

export function GET() {
  const appId = process.env.APPLE_APP_ID
  if (!appId) {
    // Better a loud 503 than a 200 carrying a placeholder Team ID, which would
    // be cached by Apple's CDN for up to 24 hours with no way to invalidate it.
    return new Response(
      JSON.stringify({ error: 'APPLE_APP_ID is not configured' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }

  return new Response(JSON.stringify(buildAasa({ appId })), {
    status: 200,
    headers: {
      // Not a documented Apple requirement any more, but some proxies will
      // guess application/octet-stream for an extensionless path.
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  })
}
