/**
 * Validates a `?next=` query value into a same-origin path, or `null`.
 *
 * `next` arrives from a query string a stranger's browser controls entirely
 * — a shared or bookmarked `/login?next=...` link. Handing it to
 * `router.replace` unchecked would let a crafted link redirect a merchant
 * off Kobolink immediately after they authenticate (an open redirect: the
 * one moment a phishing link most wants control of). Only a value that is
 * unambiguously "this app, this origin" is safe to use.
 *
 * Rejects:
 * - anything not starting with a single `/` (a bare path segment, or an
 *   absolute URL like `https://evil.example`)
 * - `//evil.example` — a *protocol-relative* URL. Browsers resolve a leading
 *   `//` against the current scheme, so this silently leaves the origin
 *   despite "starting with a slash"
 * - a value containing `\`, which some browsers normalise to `/` during URL
 *   parsing, turning `/\evil.example` into the same protocol-relative attack
 *
 * `new URL(value, base)` is the actual authority on what origin a browser
 * would resolve `value` to relative to `base` — string prefix checks alone
 * are exactly the class of bug open-redirect filters keep getting wrong, so
 * this defers to the real parser rather than re-deriving its rules by hand.
 */
export function sameOriginPath(value: string | null | undefined): string | null {
  if (!value) return null
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null

  const base = 'http://kobolink.invalid'
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return null
  }
  if (url.origin !== base) return null

  return `${url.pathname}${url.search}${url.hash}`
}
