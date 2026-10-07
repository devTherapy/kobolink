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
  return splitLines(text).slice(-count).join('\n')
}

/**
 * The first `head` and last `tail` lines of a log, with a marker for what was
 * left out. Both ends are needed: a Turbopack failure puts its header and the
 * first error in the opening lines and then repeats hundreds of
 * `at <unknown>` frames, so the tail alone shows none of the reason.
 */
export function excerptLines(text: string, head: number, tail: number): string {
  const lines = splitLines(text)
  if (lines.length <= head + tail) return lines.join('\n')
  const omitted = lines.length - head - tail
  return [...lines.slice(0, head), `... ${String(omitted)} lines omitted ...`, ...lines.slice(-tail)].join('\n')
}

/**
 * Head and tail of a step's log file for the console, framed so it can be
 * found in a long CI log. Never throws: a missing or unreadable log must not
 * replace the original failure with an ENOENT.
 */
export function describeLogExcerpt(logPath: string, head: number, tail: number): string {
  let body: string
  try {
    body = excerptLines(readFileSync(logPath, 'utf8'), head, tail) || '(log is empty)'
  } catch {
    body = '(log could not be read)'
  }
  return `---- first ${String(head)} and last ${String(tail)} lines of ${logPath} ----\n${body}\n---- end of log ----`
}
