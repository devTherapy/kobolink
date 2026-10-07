import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeLogTail, tailLines } from './tail-log'

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

describe('describeLogTail', () => {
  it('frames the tail with the path so it can be found in a CI log', () => {
    const file = logWith(Array.from({ length: 100 }, (_, i) => `line ${String(i + 1)}`).join('\n') + '\n')
    const out = describeLogTail(file, 60)
    expect(out).toContain(`last 60 lines of ${file}`)
    expect(out).toContain('line 100')
    expect(out).toContain('line 41')
    expect(out).not.toContain('line 40\n')
  })

  it('says so when the log is empty', () => {
    expect(describeLogTail(logWith(''), 60)).toContain('(log is empty)')
  })

  it('does not throw when the log does not exist', () => {
    expect(describeLogTail('/nonexistent/dir/step.log', 60)).toContain('(log could not be read)')
  })
})
