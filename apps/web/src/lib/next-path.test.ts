import { describe, expect, it } from 'vitest'
import { sameOriginPath } from './next-path'

describe('sameOriginPath', () => {
  it('accepts a plain same-origin path', () => {
    expect(sameOriginPath('/dashboard')).toBe('/dashboard')
  })

  it('accepts a same-origin path with query and hash', () => {
    expect(sameOriginPath('/dashboard/links/aBcDeFgH?tab=payments#top')).toBe(
      '/dashboard/links/aBcDeFgH?tab=payments#top',
    )
  })

  it('rejects null, undefined and the empty string', () => {
    expect(sameOriginPath(null)).toBeNull()
    expect(sameOriginPath(undefined)).toBeNull()
    expect(sameOriginPath('')).toBeNull()
  })

  it('rejects an absolute off-origin URL', () => {
    expect(sameOriginPath('https://evil.example/phish')).toBeNull()
  })

  it('rejects a protocol-relative URL (the //evil.example open-redirect shape)', () => {
    expect(sameOriginPath('//evil.example')).toBeNull()
    expect(sameOriginPath('//evil.example/dashboard')).toBeNull()
  })

  it('rejects a backslash-prefixed value some browsers normalise like //', () => {
    expect(sameOriginPath('/\\evil.example')).toBeNull()
  })

  it('rejects a value that does not start with a single slash', () => {
    expect(sameOriginPath('dashboard')).toBeNull()
    expect(sameOriginPath('javascript:alert(1)')).toBeNull()
  })
})
