import { readFileSync } from 'node:fs'

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The last `count` lines of a log. A trailing newline is not a line, so
 * `tailLines('a\nb\n', 1)` is `'b'`.
 */
export function tailLines(text: string, count: number): string {
  return count > 0 ? splitLines(text).slice(-count).join('\n') : ''
}

interface Excerpt {
  body: string
  omitted: number
}

function excerpt(text: string, head: number, tail: number): Excerpt {
  const lines = splitLines(text)
  const first = Math.max(0, head)
  const last = Math.max(0, tail)
  if (lines.length <= first + last) return { body: lines.join('\n'), omitted: 0 }
  const omitted = lines.length - first - last
  // `slice(-0)` is `slice(0)`: a tail of 0 must mean no tail, not the whole log.
  const tailPart = last > 0 ? lines.slice(-last) : []
  return { body: [...lines.slice(0, first), `... ${String(omitted)} lines omitted ...`, ...tailPart].join('\n'), omitted }
}

/**
 * The first `head` and last `tail` lines of a log, with a marker for what was
 * left out. Both ends are needed because the two carry different things: a
 * failed Turbopack build opens with the `build failed with N errors` header and
 * the first error, then repeats the same ~35-line error block N times, then
 * ends on stack frames. A tail alone starts mid-block and has neither the
 * header nor the `Module not found` line.
 */
export function excerptLines(text: string, head: number, tail: number): string {
  return excerpt(text, head, tail).body
}

/**
 * Head and tail of a step's log file for the console, framed so it can be
 * found in a long CI log. Never throws: a missing or unreadable log must not
 * replace the original failure with an ENOENT.
 */
export function describeLogExcerpt(logPath: string, head: number, tail: number): string {
  let title = `log of ${logPath}`
  let body: string
  try {
    const result = excerpt(readFileSync(logPath, 'utf8'), head, tail)
    body = result.body || '(log is empty)'
    title = result.omitted === 0 ? `full log of ${logPath}` : `first ${String(head)} and last ${String(tail)} lines of ${logPath}`
  } catch {
    body = '(log could not be read)'
  }
  return `---- ${title} ----\n${body}\n---- end of log ----`
}
