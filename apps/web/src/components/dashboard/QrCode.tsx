import { encode } from 'uqr'

/** Quiet zone, in modules. The QR spec asks for 4; a scanner needs it. */
const QUIET_ZONE = 4

export interface QrCodeProps {
  /** What the code encodes — the link's public URL, from `linkUrl()`. */
  value: string
  /**
   * The text alternative. Required, not defaulted: a QR code is a picture of
   * a string, and the string is what a screen-reader user needs. Say what it
   * is and what it encodes.
   */
  label: string
  /** Rendered edge length in CSS pixels; the SVG scales, so this is a max. */
  size?: number
}

/**
 * Turn the module matrix into one `<path>` of horizontal runs: a 33x33 code
 * is ~1,000 modules, and one `<rect>` per module would be ~1,000 DOM nodes
 * for a picture. A run of adjacent dark modules in a row becomes one
 * `h`-segment, so the whole code is a single element with a short `d`.
 */
function modulesToPath(matrix: boolean[][]): string {
  const segments: string[] = []
  matrix.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x += 1
        continue
      }
      const start = x
      while (x < row.length && row[x]) x += 1
      segments.push(`M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`)
    }
  })
  return segments.join('')
}

/**
 * A QR code, drawn as an inline SVG from `uqr`, a small zero-dependency
 * pure-JS encoder (MIT). No `"use client"`: encoding is synchronous and deterministic, so it
 * runs on the server and ships no QR code to the browser — only the SVG.
 *
 * Always dark-on-white with its own white quiet zone, whatever surface it
 * sits on: scanners expect dark modules on a light field, and a themed or
 * inverted code is the classic way to ship one that does not scan. Error
 * correction `M` (15%) is the usual middle: a URL this short stays at a low
 * QR version, and a larger-module code is easier to scan off a screen.
 *
 * Non-interactive, so only its one state applies — the rendered code. It is
 * `role="img"` with an `aria-label`; the URL is also shown as text beside it
 * (see `CopyLink`), so nothing here is the only way to learn the address.
 */
export function QrCode({ value, label, size = 192 }: QrCodeProps) {
  const { data } = encode(value, { ecc: 'M', border: 0 })
  const modules = data.length
  const total = modules + QUIET_ZONE * 2

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="h-auto w-full rounded-(--radius-input) border border-(--color-border)"
      style={{ maxWidth: size }}
    >
      <rect width={total} height={total} className="fill-white" />
      <path d={modulesToPath(data)} className="fill-(--color-ink)" />
    </svg>
  )
}
