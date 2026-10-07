import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { encode } from 'uqr'
import { describe, expect, it } from 'vitest'
import { QrCode } from './QrCode'

const URL_TEXT = 'https://pay.folusayo.com/l/aBcDeFgH'

describe('QrCode', () => {
  it('is an image with a text alternative that carries the encoded URL', () => {
    render(<QrCode value={URL_TEXT} label={`QR code for Ankara set. Scanning it opens ${URL_TEXT}`} />)

    const image = screen.getByRole('img', { name: /QR code for Ankara set/ })
    expect(image).toHaveAccessibleName(`QR code for Ankara set. Scanning it opens ${URL_TEXT}`)
  })

  it('draws the whole code as one path, sized to the modules plus a 4-module quiet zone, on white', () => {
    const { container } = render(<QrCode value={URL_TEXT} label="QR" />)
    const { size } = encode(URL_TEXT, { ecc: 'M', border: 0 })

    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('viewBox', `0 0 ${size + 8} ${size + 8}`)
    // One white field, one dark path — not a rect per module.
    expect(container.querySelectorAll('rect')).toHaveLength(1)
    expect(container.querySelectorAll('path')).toHaveLength(1)
  })

  // A QR code is dark-on-light, always. Colours come from literals, not theme tokens: a token redefined by a
  // future dark theme would invert the code into something scanners reject.
  it('pins its colours: literal dark modules on a literal white field, no theme token anywhere', () => {
    const { container } = render(<QrCode value={URL_TEXT} label="QR" />)
    const field = container.querySelector('rect')
    const modules = container.querySelector('path')

    expect(field?.getAttribute('fill')).toBe('#FFFFFF')
    expect(modules?.getAttribute('fill')).toBe('#0C1626')
    // Nothing that paints the code may reach for a theme token (the frame's border class is not part of the code).
    const painted = `${field?.outerHTML}${modules?.outerHTML.replace(/ d="[^"]*"/, '')}`
    expect(painted).not.toContain('--color-')
    expect(painted).not.toMatch(/class=/)
  })

  it('encodes exactly the module matrix the encoder produces — every dark module is in the path, no others', () => {
    const { container } = render(<QrCode value={URL_TEXT} label="QR" />)
    const { data } = encode(URL_TEXT, { ecc: 'M', border: 0 })
    const d = container.querySelector('path')?.getAttribute('d') ?? ''

    // Rebuild the lit set from the path's `M x y h w v1 h-w z` runs.
    const lit = new Set<string>()
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(w); i += 1) lit.add(`${Number(x) + i - 4},${Number(y) - 4}`)
    }

    const expected = new Set<string>()
    data.forEach((row, y) => row.forEach((on, x) => on && expected.add(`${x},${y}`)))
    expect(lit).toEqual(expected)
  })

  it('is deterministic, and a different URL is a different picture', () => {
    const first = render(<QrCode value={URL_TEXT} label="QR" />).container.querySelector('path')?.getAttribute('d')
    const again = render(<QrCode value={URL_TEXT} label="QR" />).container.querySelector('path')?.getAttribute('d')
    const other = render(<QrCode value={`${URL_TEXT}x`} label="QR" />).container.querySelector('path')?.getAttribute('d')

    expect(again).toBe(first)
    expect(other).not.toBe(first)
  })

  it('renders to static markup with no client JS — the SVG is in the server HTML', () => {
    const html = renderToStaticMarkup(<QrCode value={URL_TEXT} label="QR" size={120} />)

    expect(html).toContain('<svg')
    expect(html).toContain('role="img"')
    expect(html).toContain('width="120"')
    expect(html).toContain('<path d="M')
  })
})
