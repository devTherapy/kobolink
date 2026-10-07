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
 * ANSI colour codes removed): 18 lines of banner and notices, the
 * `Turbopack build failed with 24 errors` header on line 19, then the same
 * 34-line error block 24 times, then 48 `at <unknown>` frames. The text of
 * each block is abridged; the line counts and the order are the real ones.
 */
function realShapedLog(): string {
  const preamble = [
    '▲ Next.js 16.3.4 (Turbopack)',
    '✓ Running next.config.ts took 20ms',
    ...Array.from({ length: 14 }, (_, i) => `notice ${String(i + 1)}`),
    '  Creating an optimized production build ...',
    '> Build error occurred',
    'Error: Turbopack build failed with 24 errors:',
  ]
  const block = (n: number): string[] => [
    `[next]/internal/font/google/ibm_plex_sans_e1b07859.module.css:${String(n * 10)}:8`,
    "Error: Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'",
    ...Array.from({ length: 6 }, (_, i) => `  source excerpt ${String(i + 1)}`),
    '',
    'next/font/google queries have exactly one entry',
    '',
    'Debug info:',
    '- Execution of *<ModuleAssetContext as AssetContext>::process_resolve_result failed',
    '- Execution of resolve failed',
    '- Execution of resolve_internal failed',
    '- Execution of <NextFontGoogleFontFileReplacer as ImportMappingReplacement>::result failed',
    '- next/font/google queries have exactly one entry',
    'Error while looking up import map: next/font/google queries have exactly one entry',
    '',
    'Debug info:',
    '- Execution of <NextFontGoogleFontFileReplacer as ImportMappingReplacement>::result failed',
    '- next/font/google queries have exactly one entry',
    '',
    '',
    'Import trace:',
    '  Server Component:',
    '    [next]/internal/font/google/ibm_plex_sans_e1b07859.module.css',
    '    [next]/internal/font/google/ibm_plex_sans_e1b07859.js',
    '    ./apps/web/src/app/layout.tsx',
    '',
    'https://nextjs.org/docs/messages/module-not-found',
    '',
    '',
    '',
  ]
  const frames = Array.from({ length: 48 }, (_, i) => `    at <unknown> (frame ${String(i + 1)})`)
  const lines = [...preamble, ...Array.from({ length: 24 }, (_, n) => block(n + 1)).flat(), ...frames]
  return lines.join('\n') + '\n'
}

describe('realShapedLog', () => {
  it('has the line counts of the real log it imitates', () => {
    const text = realShapedLog()
    expect(text.split('\n').length - 1).toBe(883)
    expect(text.split('Turbopack build failed').length - 1).toBe(1)
    expect(text.split("Module not found: Can't resolve").length - 1).toBe(24)
  })
})

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

  it('returns an empty string for an empty log or a count of 0', () => {
    expect(tailLines('', 60)).toBe('')
    expect(tailLines('a\nb\n', 0)).toBe('')
  })
})

describe('excerptLines', () => {
  it('returns a short log whole, with no omission marker', () => {
    expect(excerptLines('a\nb\nc\n', 2, 2)).toBe('a\nb\nc')
  })

  it('keeps both ends of a long log and says how many lines were left out', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    expect(excerptLines(text, 3, 2)).toBe('line 1\nline 2\nline 3\n... 95 lines omitted ...\nline 99\nline 100')
  })

  it('treats a tail of 0 as no tail, not the whole log', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    expect(excerptLines(text, 2, 0)).toBe('line 1\nline 2\n... 8 lines omitted ...')
    expect(excerptLines(text, 0, 2)).toBe('... 8 lines omitted ...\nline 9\nline 10')
  })

  it('shows the header and the module-not-found line that the tail of the real log lacks', () => {
    const log = realShapedLog()
    const tail = tailLines(log, 60)
    expect(tail).not.toContain('Turbopack build failed')
    expect(tail).not.toContain('Module not found')

    const out = excerptLines(log, 30, 60)
    expect(out).toContain('Turbopack build failed with 24 errors')
    expect(out).toContain("Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'")
    expect(out).toContain('next/font/google queries have exactly one entry')
    expect(out).toContain('at <unknown> (frame 48)')
    expect(out).toContain('lines omitted')
    expect(out.split('\n')).toHaveLength(30 + 1 + 60)
  })
})

describe('describeLogExcerpt', () => {
  it('frames the excerpt with the path so it can be found in a CI log', () => {
    const file = logWith(realShapedLog())
    const out = describeLogExcerpt(file, 30, 60)
    expect(out).toContain(`first 30 and last 60 lines of ${file}`)
    expect(out).toContain('Turbopack build failed with 24 errors')
    expect(out.endsWith('---- end of log ----')).toBe(true)
  })

  it('says "full log" when nothing was left out', () => {
    const out = describeLogExcerpt(logWith('a\nb\n'), 30, 60)
    expect(out).toContain('full log of')
    expect(out).not.toContain('first 30')
  })

  it('says so when the log is empty', () => {
    expect(describeLogExcerpt(logWith(''), 30, 60)).toContain('(log is empty)')
  })

  it('does not throw when the log does not exist', () => {
    expect(describeLogExcerpt('/nonexistent/dir/step.log', 30, 60)).toContain('(log could not be read)')
  })
})
