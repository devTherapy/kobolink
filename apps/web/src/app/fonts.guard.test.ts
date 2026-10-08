import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards D31: fonts are self-hosted. The Google Fonts loader fetches from Google
 * at build time and intermittently failed CI ("Turbopack build failed ... Can't
 * resolve '@vercel/turbopack-next/internal/font/google/font'"), and made every
 * image build depend on a third party. This is a source-level check, so it runs
 * in `npm run test:web` without a build.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, '..')
const fontsDir = path.join(here, 'fonts')
const fontsTs = readFileSync(path.join(here, 'fonts.ts'), 'utf8')

// Assembled, and this file skipped below, so the guard does not trip on itself.
const GOOGLE_FONT_MODULE = ['next', 'font', 'google'].join('/')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(entry.name) ? [full] : []
  })
}

/** Every `path: './fonts/<file>.woff2'` literal handed to `localFont` in fonts.ts. */
const referenced = [...fontsTs.matchAll(/path:\s*'\.\/fonts\/([^']+)'/g)].map((m) => m[1]!)

describe('self-hosted fonts', () => {
  it('imports nothing from next/font/google anywhere under src', () => {
    const offenders = sourceFiles(srcDir)
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => readFileSync(file, 'utf8').includes(GOOGLE_FONT_MODULE))
      .map((file) => path.relative(srcDir, file))
    expect(offenders).toEqual([])
  })

  it('declares at least one font file', () => {
    expect(referenced.length).toBeGreaterThan(0)
  })

  it.each(referenced)('%s exists, is non-empty and is a woff2', (name) => {
    const file = path.join(fontsDir, name)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).size).toBeGreaterThan(0)
    // woff2 signature: the ASCII bytes "wOF2".
    expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2')
  })

  it('has no woff2 in ./fonts that fonts.ts does not use', () => {
    const onDisk = readdirSync(fontsDir).filter((name) => name.endsWith('.woff2'))
    expect(onDisk.sort()).toEqual([...new Set(referenced)].sort())
  })

  it('matches the checksums recorded in fonts/README.md', () => {
    const readme = readFileSync(path.join(fontsDir, 'README.md'), 'utf8')
    for (const name of new Set(referenced)) {
      const recorded = new RegExp(`\`${name}\`\\s*\\|\\s*\\d+\\s*\\|\\s*\`([0-9a-f]{64})\``).exec(readme)?.[1]
      const actual = createHash('sha256').update(readFileSync(path.join(fontsDir, name))).digest('hex')
      expect({ name, sha256: actual }).toEqual({ name, sha256: recorded })
    }
  })

  it('ships the OFL licence text alongside the fonts', () => {
    for (const name of ['OFL-ibm-plex-sans.txt', 'OFL-ibm-plex-mono.txt']) {
      expect(readFileSync(path.join(fontsDir, name), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1')
    }
  })
})
