import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LINK_DOMAIN, parseLinkCode } from '../src/index.js'

/**
 * The iOS app's Swift `LinkCodeParser` is proven against a table of what `parseLinkCode` returns
 * (mobile/ios/KobolinkKit/Tests/KobolinkKitTests/Resources/link-parser-oracle.json). Nothing in the
 * Swift build knows when `routes.ts` changes, so this runs the generator against the SOURCE of
 * contracts (not dist, so CI needs no build) and fails if the committed table is stale. The fix is
 * to regenerate it (see mobile/ios/README.md) and let the Swift tests say whether the parser still agrees.
 */
const tools = fileURLToPath(new URL('../../../mobile/ios/KobolinkKit/Tools/link-parser-corpus.mjs', import.meta.url))
const committed = fileURLToPath(
  new URL('../../../mobile/ios/KobolinkKit/Tests/KobolinkKitTests/Resources/link-parser-oracle.json', import.meta.url),
)

type Row = [string, string | null, string | null, string?]
interface Corpus {
  buildTable: (oracle: { parseLinkCode: typeof parseLinkCode; LINK_DOMAIN: string }) => Row[]
  renderTable: (rows: Row[]) => string
}

describe('the iOS parser oracle table', () => {
  it('is byte-for-byte what the generator produces from the current parseLinkCode', async () => {
    const corpus = (await import(/* @vite-ignore */ tools)) as Corpus
    const fresh = corpus.renderTable(corpus.buildTable({ parseLinkCode, LINK_DOMAIN }))
    const stored = readFileSync(committed, 'utf8')
    if (fresh !== stored) {
      const freshRows = fresh.split('\n')
      const storedRows = stored.split('\n')
      const index = freshRows.findIndex((row, i) => row !== storedRows[i])
      throw new Error(
        `link-parser-oracle.json is stale (first difference at line ${index + 1}: stored ${storedRows[index]}, generated ${freshRows[index]}). ` +
          'Regenerate it: npm run build -w packages/contracts && node mobile/ios/KobolinkKit/Tools/generate-link-parser-cases.mjs',
      )
    }
    expect(fresh).toBe(stored)
  })

  it('is deterministic: two runs give the same bytes', async () => {
    const corpus = (await import(/* @vite-ignore */ tools)) as Corpus
    const once = corpus.renderTable(corpus.buildTable({ parseLinkCode, LINK_DOMAIN }))
    const twice = corpus.renderTable(corpus.buildTable({ parseLinkCode, LINK_DOMAIN }))
    expect(twice).toBe(once)
  })

  it('records contracts answer for every row', async () => {
    const corpus = (await import(/* @vite-ignore */ tools)) as Corpus
    const rows = corpus.buildTable({ parseLinkCode, LINK_DOMAIN })
    expect(rows.length).toBeGreaterThan(14_000)
    for (const [input, oracle] of rows) expect(parseLinkCode(input)).toBe(oracle)
  })
})
