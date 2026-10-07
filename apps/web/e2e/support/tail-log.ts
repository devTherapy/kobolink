import { readFileSync } from 'node:fs'

/**
 * The last `count` lines of a log, for a failure message. A trailing newline is
 * not a line, so `tailLines('a\nb\n', 1)` is `'b'`.
 */
export function tailLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count).join('\n')
}

/**
 * Tail of a step's log file for the console, framed so it can be found in a
 * long CI log. Never throws: a missing or unreadable log must not replace the
 * original failure with an ENOENT.
 */
export function describeLogTail(logPath: string, count: number): string {
  let body: string
  try {
    body = tailLines(readFileSync(logPath, 'utf8'), count) || '(log is empty)'
  } catch {
    body = '(log could not be read)'
  }
  return `---- last ${String(count)} lines of ${logPath} ----\n${body}\n---- end of log ----`
}
