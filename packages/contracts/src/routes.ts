/**
 * The URL contract, in one place, so that the web app, the API and both mobile
 * apps parse and build the same paths.
 */
import { CODE_LENGTH, isValidLinkCode } from './code.js'

/** Production hostname. Locally the same paths are served from localhost. */
export const LINK_DOMAIN = 'pay.folusayo.com' as const
export const IOS_BUNDLE_ID = 'com.folusayo.kobolink' as const
export const ANDROID_PACKAGE_NAME = 'com.folusayo.kobolink' as const
/** Dev-time stand-in for universal links on iOS; needs no entitlement. */
export const IOS_URL_SCHEME = 'kobolink' as const

/** The only path prefix the mobile apps claim. */
export const LINK_PATH_PREFIX = '/l/' as const
export const CLAIMED_PATH_PATTERN = '/l/*' as const

/** HTTP paths, relative to the shared origin. `:code` and `:reference` are the parameters. */
export const API = {
  health: '/api/health',
  auth: {
    register: '/api/auth/register',
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    me: '/api/auth/me',
  },
  links: {
    collection: '/api/links',
    /** Authenticated merchant view. */
    item: (code: string) => `/api/links/${code}`,
    status: (code: string) => `/api/links/${code}/status`,
    payments: (code: string) => `/api/links/${code}/payments`,
    /** Public, unauthenticated resolution for the checkout page and the apps. */
    resolve: (code: string) => `/api/links/${code}/public`,
  },
  checkout: {
    initialize: '/api/checkout/initialize',
    verify: '/api/checkout/verify',
  },
  dashboard: {
    stats: '/api/dashboard/stats',
    stream: '/api/stream/dashboard',
  },
  wallet: {
    me: '/api/wallet',
    transactions: '/api/wallet/transactions',
    transfer: '/api/wallet/transfer',
    topup: '/api/wallet/topup',
  },
} as const

/** The public checkout URL a merchant shares. */
export function linkUrl(code: string, origin = `https://${LINK_DOMAIN}`): string {
  return `${origin}${LINK_PATH_PREFIX}${code}`
}

/** The custom-scheme form used on iOS before universal links are entitled. */
export function linkSchemeUrl(code: string): string {
  return `${IOS_URL_SCHEME}:/${LINK_PATH_PREFIX}${code}`
}

/**
 * Extract the link code from anything a deep link can hand us:
 * `https://pay.folusayo.com/l/aBcDeFgH`, `/l/aBcDeFgH?x=1`, `kobolink://l/aBcDeFgH`.
 * Returns null for anything that is not exactly a valid code at that path.
 */
export function parseLinkCode(input: string): string | null {
  let path: string
  try {
    const url = new URL(input)
    // kobolink://l/CODE parses with host "l" and pathname "/CODE".
    path = url.protocol === `${IOS_URL_SCHEME}:` ? `/${url.host}${url.pathname}` : url.pathname
  } catch {
    path = input.split(/[?#]/, 1)[0] ?? ''
  }
  if (!path.startsWith(LINK_PATH_PREFIX)) return null
  const rest = path.slice(LINK_PATH_PREFIX.length).replace(/\/+$/, '')
  if (rest.length !== CODE_LENGTH || !isValidLinkCode(rest)) return null
  return rest
}
