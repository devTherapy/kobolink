import { describe, expect, it } from 'vitest'
import { buildAasa, buildAssetLinks, parseFingerprints, CLAIMED_PATH } from '@/lib/associations'

const FP_A = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const FP_B = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'

describe('buildAasa', () => {
  const aasa = buildAasa({ appId: 'ABCDE12345.com.folusayo.kobolink' })

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
    expect(() => JSON.parse(JSON.stringify(aasa))).not.toThrow()
  })
})

describe('parseFingerprints', () => {
  it('uppercases — a lowercase fingerprint verifies locally and fails in production', () => {
    expect(parseFingerprints(FP_A.toLowerCase())).toEqual([FP_A])
  })

  it('accepts a comma-separated pair, which is the debug + Play App Signing case', () => {
    expect(parseFingerprints(`${FP_A}, ${FP_B}`)).toEqual([FP_A, FP_B])
  })

  it('drops anything malformed rather than shipping it', () => {
    expect(parseFingerprints('nope')).toEqual([])
    expect(parseFingerprints('AA:BB:CC')).toEqual([])
    expect(parseFingerprints(undefined)).toEqual([])
    expect(parseFingerprints(`${FP_A},garbage`)).toEqual([FP_A])
  })
})

describe('buildAssetLinks', () => {
  it('uses the handle_all_urls relation and both fingerprints', () => {
    const [entry] = buildAssetLinks({ packageName: 'com.folusayo.kobolink', fingerprints: [FP_A, FP_B] })
    expect(entry?.relation).toEqual(['delegate_permission/common.handle_all_urls'])
    expect(entry?.target.namespace).toBe('android_app')
    expect(entry?.target.package_name).toBe('com.folusayo.kobolink')
    expect(entry?.target.sha256_cert_fingerprints).toHaveLength(2)
  })
})
