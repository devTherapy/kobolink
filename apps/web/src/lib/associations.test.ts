import { ANDROID_PACKAGE_NAME, IOS_BUNDLE_ID } from '@kobolink/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildAasa,
  buildAssetLinks,
  parseFingerprints,
  validateAndroidPackageName,
  validateAppId,
  CLAIMED_PATH,
  PLACEHOLDER_TEAM_ID,
} from '@/lib/associations'

const FP_A = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const FP_B = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'
const REAL_TEAM_ID = 'ZYXWV98765'

describe('buildAasa', () => {
  const aasa = buildAasa({ appId: `${REAL_TEAM_ID}.${IOS_BUNDLE_ID}` })

  it('claims the payment-link path', () => {
    const components = aasa.applinks.details[0]?.components ?? []
    expect(components.some((c) => c['/'] === CLAIMED_PATH && !('exclude' in c))).toBe(true)
  })

  it('never lets the app claim the association files themselves', () => {
    const excluded = aasa.applinks.details[0]?.components.find((c) => c['/'] === '/.well-known/*')
    expect(excluded).toMatchObject({ exclude: true })
  })

  it('emits the components format only — TN3155 forbids mixing it with legacy paths', () => {
    const detail = aasa.applinks.details[0] as Record<string, unknown>
    expect(detail).toHaveProperty('appIDs')
    expect(detail).not.toHaveProperty('appID')
    expect(detail).not.toHaveProperty('paths')
  })

  it('serialises to JSON Apple will accept', () => {
    expect(() => {
      JSON.parse(JSON.stringify(aasa))
    }).not.toThrow()
  })
})

describe('parseFingerprints', () => {
  it('uppercases — a lowercase fingerprint verifies locally and fails in production', () => {
    expect(parseFingerprints(FP_A.toLowerCase())).toEqual({ valid: [FP_A], invalid: [] })
  })

  it('accepts a comma-separated pair, which is the debug + Play App Signing case', () => {
    expect(parseFingerprints(`${FP_A}, ${FP_B}`)).toEqual({ valid: [FP_A, FP_B], invalid: [] })
  })

  it('names anything malformed as invalid rather than silently dropping it', () => {
    // §6.3's exact failure mode: a debug fingerprint plus a mistyped Play App
    // Signing fingerprint. Silently dropping the bad one and shipping only
    // the good one verifies on the developer's machine and fails in
    // production — so a malformed entry is reported, never just discarded.
    expect(parseFingerprints('nope')).toEqual({ valid: [], invalid: ['NOPE'] })
    expect(parseFingerprints('AA:BB:CC')).toEqual({ valid: [], invalid: ['AA:BB:CC'] })
    expect(parseFingerprints(undefined)).toEqual({ valid: [], invalid: [] })
    expect(parseFingerprints(`${FP_A},garbage`)).toEqual({ valid: [FP_A], invalid: ['GARBAGE'] })
  })
})

describe('buildAssetLinks', () => {
  it('uses the handle_all_urls relation and both fingerprints', () => {
    const [entry] = buildAssetLinks({ packageName: ANDROID_PACKAGE_NAME, fingerprints: [FP_A, FP_B] })
    expect(entry?.relation).toEqual(['delegate_permission/common.handle_all_urls'])
    expect(entry?.target.namespace).toBe('android_app')
    expect(entry?.target.package_name).toBe(ANDROID_PACKAGE_NAME)
    expect(entry?.target.sha256_cert_fingerprints).toHaveLength(2)
  })
})

describe('validateAppId', () => {
  it('accepts a correctly shaped app id for our bundle', () => {
    expect(validateAppId(`${REAL_TEAM_ID}.${IOS_BUNDLE_ID}`)).toBeNull()
  })

  it('rejects anything not shaped <TEAM_ID>.<bundle id>', () => {
    expect(validateAppId('not-shaped-right')).not.toBeNull()
    expect(validateAppId('short.com.folusayo.kobolink')).not.toBeNull()
    expect(validateAppId('')).not.toBeNull()
  })

  it('rejects the .env.example placeholder Team ID even though it is shaped correctly', () => {
    const error = validateAppId(`${PLACEHOLDER_TEAM_ID}.${IOS_BUNDLE_ID}`)
    expect(error).not.toBeNull()
    expect(error).toMatch(/placeholder/i)
  })

  it('rejects a bundle id that is not the one app this repo ships', () => {
    expect(validateAppId(`${REAL_TEAM_ID}.com.example.other`)).not.toBeNull()
  })
})

describe('validateAndroidPackageName', () => {
  it('accepts the one package this repo ships', () => {
    expect(validateAndroidPackageName(ANDROID_PACKAGE_NAME)).toBeNull()
  })

  it('rejects anything else', () => {
    expect(validateAndroidPackageName('com.example.other')).not.toBeNull()
  })
})
