import { describe, expect, it } from 'vitest'
import { API, LINK_DOMAIN, linkSchemeUrl, linkUrl, parseLinkCode } from '../src/index.js'

describe('linkUrl', () => {
  it('builds the shared URL on the production host by default', () => {
    expect(linkUrl('aBcDeFgH')).toBe(`https://${LINK_DOMAIN}/l/aBcDeFgH`)
    expect(linkUrl('aBcDeFgH', 'http://localhost:3000')).toBe('http://localhost:3000/l/aBcDeFgH')
  })

  it('builds the custom-scheme form for iOS development', () => {
    expect(linkSchemeUrl('aBcDeFgH')).toBe('kobolink://l/aBcDeFgH')
  })
})

describe('parseLinkCode', () => {
  it.each([
    'https://pay.folusayo.com/l/aBcDeFgH',
    'https://pay.folusayo.com/l/aBcDeFgH/',
    'https://pay.folusayo.com/l/aBcDeFgH?utm=whatsapp#x',
    'http://localhost:3000/l/aBcDeFgH',
    '/l/aBcDeFgH',
    '/l/aBcDeFgH?x=1',
    'kobolink://l/aBcDeFgH',
  ])('extracts the code from %s', (input) => {
    expect(parseLinkCode(input)).toBe('aBcDeFgH')
  })

  it.each([
    'https://pay.folusayo.com/dashboard',
    'https://pay.folusayo.com/.well-known/apple-app-site-association',
    'https://pay.folusayo.com/l/',
    'https://pay.folusayo.com/l/abcdefg0',
    'https://pay.folusayo.com/l/aBcDeFgH/extra',
    'https://pay.folusayo.com/links/aBcDeFgH',
    'kobolink://dashboard',
    '',
    'not a url',
  ])('returns null for %s', (input) => {
    expect(parseLinkCode(input)).toBeNull()
  })
})

describe('API paths', () => {
  it('keeps the public resolution and the merchant view on different paths', () => {
    expect(API.links.resolve('aBcDeFgH')).not.toBe(API.links.item('aBcDeFgH'))
    expect(API.links.resolve('aBcDeFgH')).toMatch(/^\/api\/links\/aBcDeFgH\/public$/)
  })

  it('serves everything under /api so one hostname can front both services', () => {
    const flat = JSON.stringify(API, (_k, v: unknown) => (typeof v === 'function' ? (v as (c: string) => string)('X') : v))
    for (const path of flat.match(/"\/[^"]+"/g) ?? []) expect(path).toMatch(/^"\/api\//)
  })
})
