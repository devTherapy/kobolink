import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeLogExcerpt, excerptLines, tailLines } from './tail-log'

const dirs: string[] = []

function logWith(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tail-log-'))
  dirs.push(dir)
  const file = path.join(dir, 'step.log')
  writeFileSync(file, content)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The shape of a real failed `build-web.log` (CI run 37672998353, 883 lines,
 * ANSI colour codes removed, source excerpts trimmed): the reason is in the
 * first 30 lines, the remaining ~850 are `at <unknown>` frames.
 */
const HEAD = [
  '▲ Next.js 16.3.4 (Turbopack)',
  '✓ Running next.config.ts took 20ms',
  '  Creating an optimized production build ...',
  '',
  '> Build error occurred',
  'Error: Turbopack build failed with 24 errors:',
  '[next]/internal/font/google/ibm_plex_sans_e1b07859.module.css:8:8',
  "Error: Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'",
  '',
  'next/font/google queries have exactly one entry',
]
const FRAME = '    at <unknown> ([next]/internal/font/google/ibm_plex_sans_e1b07859.module.css:178:8)'
const REAL_SHAPED_LOG = [...HEAD, ...Array.from({ length: 873 }, () => FRAME), '    at <unknown> (last frame)'].join('\n') + '\n'

describe('tailLines', () => {
  it('keeps the last N lines and ignores the trailing newline', () => {
    expect(tailLines('a\nb\nc\nd\n', 2)).toBe('c\nd')
  })

  it('returns everything when the log is shorter than N', () => {
    expect(tailLines('a\nb', 60)).toBe('a\nb')
  })

  it('handles CRLF output', () => {
    expect(tailLines('a\r\nb\r\nc\r\n', 2)).toBe('b\nc')
  })

  it('returns an empty string for an empty log', () => {
    expect(tailLines('', 60)).toBe('')
  })
})

describe('excerptLines', () => {
  it('returns a short log whole, with no omission marker', () => {
    expect(excerptLines('a\nb\nc\n', 2, 2)).toBe('a\nb\nc')
  })

  it('keeps both ends of a long log and says how many lines were left out', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    const out = excerptLines(text, 3, 2)
    expect(out).toBe('line 1\nline 2\nline 3\n... 95 lines omitted ...\nline 99\nline 100')
  })

  it('shows the Turbopack header and the module-not-found line that the tail alone misses', () => {
    expect(tailLines(REAL_SHAPED_LOG, 60)).not.toContain('Turbopack build failed')

    const out = excerptLines(REAL_SHAPED_LOG, 30, 60)
    expect(out).toContain('Turbopack build failed with 24 errors')
    expect(out).toContain("Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'")
    expect(out).toContain('next/font/google queries have exactly one entry')
    expect(out).toContain('at <unknown> (last frame)')
    expect(out).toContain('lines omitted')
    expect(out.split('\n')).toHaveLength(30 + 1 + 60)
  })
})

describe('describeLogExcerpt', () => {
  it('frames the excerpt with the path so it can be found in a CI log', () => {
    const file = logWith(REAL_SHAPED_LOG)
    const out = describeLogExcerpt(file, 30, 60)
    expect(out).toContain(`first 30 and last 60 lines of ${file}`)
    expect(out).toContain('Turbopack build failed with 24 errors')
    expect(out.endsWith('---- end of log ----')).toBe(true)
  })

  it('says so when the log is empty', () => {
    expect(describeLogExcerpt(logWith(''), 30, 60)).toContain('(log is empty)')
  })

  it('does not throw when the log does not exist', () => {
    expect(describeLogExcerpt('/nonexistent/dir/step.log', 30, 60)).toContain('(log could not be read)')
  })
})
