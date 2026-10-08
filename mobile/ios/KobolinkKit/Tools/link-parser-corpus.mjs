// The corpus and its classification: runs an ORACLE (packages/contracts' `parseLinkCode`, passed in)
// over a large, deterministic set of link shapes and returns the table the Swift tests read.
//
// This module takes the oracle as an argument and imports nothing from contracts, so the same code
// runs from the CLI (generate-link-parser-cases.mjs, against dist/) and from the contracts vitest
// suite (packages/contracts/tests/ios-oracle-table.test.ts, against src/), which fails when the
// committed table drifts from contracts. Deterministic: same oracle, same bytes.
//
// Each row is [input, oracle, expected, reason?]:
//   oracle    what contracts' parseLinkCode returns (a code, or null)
//   expected  what the Swift LinkCodeParser must return. Equal to `oracle` except where the app is
//             deliberately STRICTER, which `reason` names. The app is never more permissive.
//   reason    "scheme"     contracts reads url.pathname for any scheme (ftp://x/l/CODE); the app takes
//                          https and kobolink only.
//             "host"       contracts accepts any host; the app only accepts pay.folusayo.com.
//             "port"       a port other than 443 is another origin, not the verified link host.
//             "host-alias" the host reaches pay.folusayo.com only through percent-decoding or IDNA
//                          mapping (pay%2Efolusayo.com); the app takes the literal name.
//
// Nothing here edits contracts. The Swift parser is hand-written to this behaviour and the table is
// what proves it agrees.

// ---- deterministic PRNG -----------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// ---- axes -------------------------------------------------------------------------------------
const C = 'aBcDeFgH'

const prefixes = ['', '', '', ' ', '  ', '\t', '\n', '\r\n', '\u0000', '\u0001', '\u001f', ' \u001f', '\u00a0', '\u2028', '\ufeff', 'x', '\\', '/']
const suffixes = [
  '', '', '', '?', '?x=1', '?q=a b', '?q=a%20b', '#', '#frag', '#frag ment', '?x#y', '?#', '#?', '/', '//', ' ', '  ', '\t',
  '\n', '\r\n', ' \n ', '\u0000', '\u001f', '%20', '%23', '%3F', '%2F', '/?q=a b', '/#f', '/extra', `?/l/${C}`, `#/l/${C}`, '?\\',
]
const codes = [
  C, C, C, 'abcdefgh', '23456789', 'zzzzzzzz', 'ZZZZZZZZ', 'abcdefg0', 'abcdefgO', 'abcdefg1', 'abcdefgI', 'abcdefgl', 'aBcDeFg',
  'aBcDeFgHx', '', 'aBcDeFg%48', 'aBcDeFg%2F', 'aBcDeFg%23', 'aBcDeFg%3F', 'aBcDeFgH%20', 'aBcDeFg%2f', '%61BcDeFgH',
  'aBcDeFg\u00e9', 'aBcDeFg\ud83d\ude00', 'aBcDeFg\u0000', 'aBcDeFg ', 'aBcDeFg\t', 'aBcDeF\tgH', 'aBcDeF\ngH', 'aBcDeF\rgH',
  'aBcDeF gH', 'aBcDeFgH\n', 'ａBcDeFgH', 'aBcDeFg.', 'aBcDe.gH', 'a/cDeFgH', 'aBcDeFg\\',
]
const pathTemplates = [
  '/l/{C}', '/l/{C}', '/l/{C}', '/l/{C}/', '/l/{C}//', '/l/{C}///', '//l/{C}', '///l/{C}', '/l//{C}', '/l///{C}', '/l/./{C}',
  '/l/../l/{C}', '/x/../l/{C}', '/x/./l/{C}', '/l/{C}/.', '/l/{C}/..', '/l/{C}/./', '/l/{C}/../', '/./l/{C}', '/../l/{C}',
  '/l/%2e/{C}', '/l/%2E/{C}', '/l/.%2e/{C}', '/l/%2e%2E/l/{C}', '/x/%2e%2e/l/{C}', '/x/.%2E/l/{C}', '/x/%2E./l/{C}',
  '/l/{C}/%2e', '/l/{C}/%2e%2e', '/l/{C}/extra', '/l/{C}/extra/..', '/l/', '/l', '/', '', '/L/{C}', '/ l/{C}', '/l /{C}',
  '/l/ {C}', '/l/{C} ', '\\l\\{C}', '/l\\{C}', '\\l/{C}', '\\\\l/{C}', '/l/{C}\\', '/l/{C}\\\\', '/l\\.\\{C}', '/links/{C}',
  '/dashboard', '/.well-known/apple-app-site-association', '/l/{C}/l/{C}', '/%6C/{C}', '/l%2F{C}', 'l/{C}', './l/{C}',
  '../l/{C}', '/l/{C}%00', '/l/\u0000{C}', '/l/{C}\u0000', '/l/...', '/l/{C}/...', '/l/%2e%2e/{C}', '/l/{C}/..%2e/',
  '/l/{C}/%2E%2E/{C}', '/l/{C}/x/../..', '/l/x/../{C}', '/L/../l/{C}', '/l/{C}\\..', '/l/{C}/\\', '/l/{C}\\/', '/l/\\{C}',
]
const httpsHosts = [
  'pay.folusayo.com', 'pay.folusayo.com', 'pay.folusayo.com', 'PAY.FOLUSAYO.COM', 'Pay.Folusayo.com', 'pay.folusayo.com.',
  'pay.folusayo.com:', 'pay.folusayo.com:443', 'pay.folusayo.com:0443', 'pay.folusayo.com:80', 'pay.folusayo.com:8443',
  'pay.folusayo.com:65535', 'pay.folusayo.com:65536', 'pay.folusayo.com:abc', 'pay.folusayo.com:-1', 'pay.folusayo.com:443:443',
  'pay.folusayo.com:00000000443', 'user@pay.folusayo.com', 'user:pw@pay.folusayo.com', '@pay.folusayo.com', 'u@v@pay.folusayo.com',
  ':@pay.folusayo.com', 'user@pay.folusayo.com:443', 'pay.folusayo.com@evil.example', 'evil.example', 'evil.example@pay.folusayo.com',
  'sub.pay.folusayo.com', 'evilpay.folusayo.com', 'pay.folusayo.com.evil.example', 'localhost:3000', 'localhost',
  'pay%2Efolusayo.com', 'pay.folusayo%2Ecom', '%70ay.folusayo.com', '\uff50\uff41\uff59.folusayo.com', 'pay.folusayo.com%00',
  'pay.fol\tusayo.com', 'pay.folusayo.com\n', 'pay .folusayo.com', '[::1]', '[::1]:443', '', 'evil.example\\@pay.folusayo.com',
  'evil.example/@pay.folusayo.com', 'pay.folusayo.com\u0001', 'pay.folusayo.com\u0000', '\u00a0pay.folusayo.com', 'pay.folusayo.com ',
  'user@@pay.folusayo.com', 'pay.folusayo.com@', 'a b@pay.folusayo.com', 'us\u00e9r@pay.folusayo.com', 'pay.folusayo.co', 'pay.folusayo.comm',
  'xpay.folusayo.com', 'pay.folusayo.com:+443', 'pay.folusayo.com:4 43',
]
const customHosts = [
  'l', 'l', 'l', 'L', 'l:', 'l:80', 'l:0', 'l:99999', 'l:abc', 'l:80:90', 'u@l', 'u:p@l', '@l', 'u@l:', 'u@l:80', '%6C', '%6c', 'x', 'l.',
  'l@l', 'l:@l', '', 'u@', 'l ', ' l', 'l\t', 'ls', 'l,', 'ℓ', '[l]', 'l\\', 'l?', 'l#', 'u@v@l', 'pay.folusayo.com', 'l/',
]
const schemes = [
  'https', 'https', 'https', 'HTTPS', 'hTTps', 'http', 'ftp', 'wss', 'file', 'kobolink', 'kobolink', 'kobolink', 'KOBOLINK',
  'Kobolink', 'kobolink2', 'kobolink+x', 'kobolink.x', 'kobolink-x', 'javascript', 'data', 'a', 'l', 'mailto', 'h ttps', '1https', '',
]
const seps = [
  '://', '://', '://', ':', ':/', ':///', '::', ':\\\\', ':/\\', ':\\/', ':////', '//', '', ':// ', ': //', ':/ /', ':\t//', ':\n//', ':/\t/',
]

// ---- classification ---------------------------------------------------------------------------
function classify(input, { parseLinkCode, LINK_DOMAIN }) {
  const oracle = parseLinkCode(input)
  let expected = oracle
  let reason
  if (oracle !== null) {
    let url = null
    try {
      url = new URL(input)
    } catch {
      /* bare path: contracts accepts it, so does the app */
    }
    if (url) {
      if (url.protocol !== 'https:' && url.protocol !== 'kobolink:') {
        expected = null
        reason = 'scheme'
      } else if (url.protocol === 'https:') {
        if (url.hostname !== LINK_DOMAIN) {
          expected = null
          reason = 'host'
        } else if (url.port !== '') {
          // new URL drops 443 as the default; anything left is another origin.
          expected = null
          reason = 'port'
        } else {
          // Independent of the parser: is the literal authority host the link host?
          const stripped = input.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '')
          const m = /^https:[/\\]*([^/\\?#]*)/i.exec(stripped)
          const hostPort = m ? m[1].slice(m[1].lastIndexOf('@') + 1) : ''
          const literal = hostPort.split(':')[0].toLowerCase()
          if (literal !== LINK_DOMAIN) {
            expected = null
            reason = 'host-alias'
          }
        }
      }
    }
  }
  return reason ? [input, oracle, expected, reason] : [input, oracle, expected]
}

const fill = (template, code) => template.replaceAll('{C}', code)
const build = (prefix, scheme, sep, auth, path, suffix) => `${prefix}${scheme}${sep}${auth}${path}${suffix}`

/**
 * @param {{ parseLinkCode: (input: string) => string | null, LINK_DOMAIN: string }} oracle
 * @param {number} [minRows] grow the table with random and mutated rows to at least this many;
 *   omitted, the table is every curated and axis row plus 3500 of them.
 */
export function buildTable(oracle, minRows) {
  const rand = mulberry32(0x6b6f626f)
  const pick = (list) => list[Math.floor(rand() * list.length)]

  // ---- corpus -----------------------------------------------------------------------------------
  const seen = new Set()
  const rows = []
  function add(input) {
    if (seen.has(input)) return
    seen.add(input)
    rows.push(classify(input, oracle))
  }

  // 1. Everything contracts' own tests and Android's tests name.
  const curated = [
    'https://pay.folusayo.com/l/aBcDeFgH', 'https://pay.folusayo.com/l/aBcDeFgH/', 'https://pay.folusayo.com/l/aBcDeFgH?utm=whatsapp#x',
    'http://localhost:3000/l/aBcDeFgH', '/l/aBcDeFgH', '/l/aBcDeFgH?x=1', 'kobolink://l/aBcDeFgH', 'https://pay.folusayo.com/dashboard',
    'https://pay.folusayo.com/.well-known/apple-app-site-association', 'https://pay.folusayo.com/l/', 'https://pay.folusayo.com/l/abcdefg0',
    'https://pay.folusayo.com/l/aBcDeFgH/extra', 'https://pay.folusayo.com/links/aBcDeFgH', 'kobolink://dashboard', '', 'not a url',
    'https://pay.folusayo.com/l/aBcDeFgH?q=a b', 'https://pay.folusayo.com/l/aBcDeFgH?q=a b#frag ment',
    'https://pay.folusayo.com/l/aBcDeFgH/?q=a b', 'https://PAY.FOLUSAYO.COM/l/aBcDeFgH', 'http://pay.folusayo.com/l/aBcDeFgH',
    'https://pay.folusayo.com/l/aBcDeFg%48', 'https://pay.folusayo.com/l/aBcDeFg%2F', 'https://pay.folusayo.com/l/aBcDeFgH%20',
    '/l/aBcDeFg%48', '/l/./aBcDeFgH', 'kobolink://l/aBcDeFg%48', 'https://evil.example/l/aBcDeFgH',
    'https://pay.folusayo.com.evil.example/l/aBcDeFgH', 'https://evilpay.folusayo.com/l/aBcDeFgH',
    'https://pay.folusayo.com@evil.example/l/aBcDeFgH', 'https://evil.example/pay.folusayo.com/l/aBcDeFgH',
    'https://pay.folusayo.com./l/aBcDeFgH', 'https:///l/aBcDeFgH', 'https://sub.pay.folusayo.com/l/aBcDeFgH',
    '//evil.example/l/aBcDeFgH', '//pay.folusayo.com/l/aBcDeFgH', '//l/aBcDeFgH', 'https://pay.folusayo.com//l/aBcDeFgH',
    'https://pay.folusayo.com/l//aBcDeFgH', 'http://pay.folusayo.com//l/aBcDeFgH', '/l//x', '/l//aBcDeFgH', 'kobolink://l//x',
    'kobolink://l//aBcDeFgH', 'kobolink:///l/aBcDeFgH', 'kobolink:/l/aBcDeFgH', 'kobolink://x/l/aBcDeFgH', 'kobolink://L/aBcDeFgH',
    'kobolink://l:80/aBcDeFgH', 'kobolink://l', 'kobolink:///aBcDeFgH', 'l/aBcDeFgH', 'https://pay.folusayo.com/l/%2e/aBcDeFgH',
    'https://pay.folusayo.com/x/%2E%2e/l/aBcDeFgH', 'https://pay.folusayo.com/l/aBcDeFgH//', '/l/aBcDeFgH//', 'kobolink://l/aBcDeFgH/',
    'kobolink://l/aBcDeFgH?x=1#y', 'KOBOLINK://l/aBcDeFgH', 'HTTPS://pay.folusayo.com/l/aBcDeFgH', 'https://pay.folusayo.com/l/./aBcDeFgH',
    'https://pay.folusayo.com/x/../l/aBcDeFgH', 'https://pay.folusayo.com/l/aBcDeFgH/./', 'kobolink://l/./aBcDeFgH',
    'https://pay.folusayo.com:443/l/aBcDeFgH', 'ftp://pay.folusayo.com/l/aBcDeFgH', 'content://pay.folusayo.com/l/aBcDeFgH',
    'javascript:/l/aBcDeFgH', '://', 'https://', 'kobolink://', 'https://pay.folusayo.com/l/aBcDeFgH?'.repeat(50), '\u0000/l/aBcDeFgH',
    'kobolink:l/aBcDeFgH', 'kobolink:l/aBcDeFgH ?x', 'kobolink:l/aBcDeFgH #x', 'kobolink:l/aBcDeFgH%20', 'kobolink:l/aBcDeFgH/',
    'kobolink:l/aBcDeFgH//', 'kobolink:l/./aBcDeFgH', 'kobolink:l//aBcDeFgH', 'kobolink:/l/./aBcDeFgH', 'kobolink:l', 'kobolink:',
    'kobolink:?x', 'kobolink:#x', 'kobolink:l/aBcDeFgH\\', 'https:pay.folusayo.com/l/aBcDeFgH', 'https:/pay.folusayo.com/l/aBcDeFgH',
    'https:\\\\pay.folusayo.com\\l\\aBcDeFgH', 'https://pay.folusayo.com\\l\\aBcDeFgH', 'https://pay.folusayo.com/l\\aBcDeFgH',
    ' https://pay.folusayo.com/l/aBcDeFgH', 'https://pay.folusayo.com/l/aBcDeFgH ', '\thttps://pay.folusayo.com/l/aBcDeFgH\n',
    'https://pay.folusayo.com/l/aBcDeF\tgH', 'https://pay.fol\tusayo.com/l/aBcDeFgH', '/l/aBcDeF\tgH', ' /l/aBcDeFgH',
    'https://user:pw@pay.folusayo.com/l/aBcDeFgH', 'https://pay.folusayo.com:8443/l/aBcDeFgH', 'kobolink://u@l/aBcDeFgH',
    'kobolink://l:/aBcDeFgH', 'kobolink://l@l/aBcDeFgH', 'https://pay.folusayo.com/l/aBcDeFgH/..', 'https://pay.folusayo.com/l/aBcDeFgH/.',
    'https://pay.folusayo.com/l/x/../aBcDeFgH', 'https://pay.folusayo.com/l/aBcDeFg%23', 'https://pay.folusayo.com/l/aBcDeFg%3F',
  ]
  curated.forEach(add)

  // 2. One axis at a time around a valid base, for both accepted schemes plus the bare path.
  for (const code of codes) for (const t of pathTemplates) {
    add(fill(t, code))
    add(build('', 'https', '://', 'pay.folusayo.com', fill(t, code), ''))
    add(build('', 'kobolink', '://', 'l', fill(t.replace(/^\/l\//, '/'), code), ''))
    add(build('', 'kobolink', '://', 'l', fill(t, code), ''))
  }
  for (const prefix of prefixes) for (const suffix of suffixes) {
    add(build(prefix, 'https', '://', 'pay.folusayo.com', `/l/${C}`, suffix))
    add(build(prefix, 'kobolink', '://', 'l', `/${C}`, suffix))
    add(`${prefix}/l/${C}${suffix}`)
  }
  for (const host of httpsHosts) for (const t of ['/l/{C}', '/l/{C}/', '/{C}', '']) add(build('', 'https', '://', host, fill(t, C), ''))
  for (const host of customHosts) for (const t of ['/{C}', '/{C}/', '/l/{C}', '', '/']) add(build('', 'kobolink', '://', host, fill(t, C), ''))
  for (const scheme of schemes) for (const sep of seps) {
    add(build('', scheme, sep, 'pay.folusayo.com', `/l/${C}`, ''))
    add(build('', scheme, sep, 'l', `/${C}`, ''))
    add(build('', scheme, sep, '', `l/${C}`, ''))
    add(build('', scheme, sep, '', `/l/${C}`, ''))
  }

  // 3. Random walk through the full cross product.
  function randomRow() {
    const code = pick(codes)
    const scheme = pick(schemes)
    const custom = /^kobolink/i.test(scheme) && rand() < 0.8
    const auth = scheme === '' && rand() < 0.5 ? '' : pick(custom ? customHosts : httpsHosts)
    let path = fill(pick(pathTemplates), code)
    if (custom && rand() < 0.7) path = path.replace(/^\/l\//, '/')
    return build(rand() < 0.6 ? '' : pick(prefixes), scheme, pick(seps), auth, path, rand() < 0.5 ? '' : pick(suffixes))
  }

  // 4. Mutation fuzz around valid shapes: insert or replace characters that WHATWG parsing treats specially.
  const poolChars = ['/', '\\', '?', '#', '@', ':', '%', '.', '\t', '\n', '\r', ' ', '\u0000', 'l', 'L', '%2e', '%2E', '%2F', '%23', '%3F', '%48', '..', '//', './/', 'é', '\u0301']
  const bases = [
    `https://pay.folusayo.com/l/${C}`, `https://pay.folusayo.com/l/${C}/`, `kobolink://l/${C}`, `kobolink://l/${C}/`, `/l/${C}`, `/l/${C}/`,
    `https://user@pay.folusayo.com:443/l/${C}?q=1#f`, `kobolink://u:p@l/${C}?q=1#f`, `kobolink:l/${C}`, `HTTPS://PAY.FOLUSAYO.COM/x/../l/${C}`,
  ]
  function mutated() {
    let s = pick(bases)
    const edits = 1 + Math.floor(rand() * 3)
    for (let n = 0; n < edits; n++) {
      const at = Math.floor(rand() * (s.length + 1))
      const ch = pick(poolChars)
      s = rand() < 0.5 ? s.slice(0, at) + ch + s.slice(at) : s.slice(0, at) + ch + s.slice(at + 1)
    }
    return s
  }

  const target = minRows ?? rows.length + 3500
  let guard = 0
  while (rows.length < target && guard++ < target * 40) {
    add(rand() < 0.35 ? mutated() : randomRow())
  }
  return rows
}

/** The exact bytes of the committed table. */
export function renderTable(rows) {
  return '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n'
}
