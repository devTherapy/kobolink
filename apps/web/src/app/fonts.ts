import localFont from 'next/font/local'

/**
 * IBM Plex, self-hosted. The woff2 files are committed under `./fonts` (see
 * `fonts/README.md` for provenance, checksums and the OFL licence), so
 * `next build` makes no request to fonts.googleapis.com or gstatic.com: a
 * build can no longer fail because a third party was slow, and the Docker
 * image build needs no network beyond the npm registry. This replaces
 * the Google Fonts loader, whose build-time fetch intermittently failed CI with
 * "Turbopack build failed ... NextFontGoogleFontFileReplacer" (D31).
 *
 * Each typeface is three calls, one per unicode-range slice, because
 * `next/font/local` applies one `declarations` block to every face of a call:
 *
 *   latin       U+0000-00FF and the usual punctuation. The only slice that is
 *               preloaded, and the one that carries the size-adjusted fallback.
 *   latin-ext   includes the naira sign U+20A6, so every checkout needs it, and
 *               the Yoruba and Igbo letters outside Latin-1 (ṣ, ọ, ụ ...).
 *   vietnamese  U+1EA0-1EF9: the dotted vowels ẹ ị ọ ụ used in Yoruba and Igbo.
 *
 * Google served the same slices plus cyrillic and greek, which this product
 * has no use for. A slice is downloaded only when a character in its range is
 * rendered, so a page that does not need one never fetches it.
 *
 * Sans is the variable font (one file per slice, as Google served it); the
 * `@font-face` weight range is clamped to 400-700, the weights the design uses,
 * so a stray `font-weight: 300` still resolves to Regular rather than a Light
 * nobody designed for. Mono has no variable build upstream: one static file per
 * slice and weight (400, 500).
 *
 * `next/font/local` needs literal arguments (no shared constants, no helper
 * function), hence the repetition. Each call defines its own CSS variable;
 * `globals.css` joins them into `--font-sans` and `--font-mono`, ext and
 * vietnamese first so that the fallback face riding with the latin slice is the
 * last Plex family tried (it has no unicode-range and would otherwise answer
 * for characters the later slices exist to cover).
 */

export const plexSans = localFont({
  src: [{ path: './fonts/ibm-plex-sans-latin-wght-normal.woff2', weight: '400 700', style: 'normal' }],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
})

export const plexSansLatinExt = localFont({
  src: [{ path: './fonts/ibm-plex-sans-latin-ext-wght-normal.woff2', weight: '400 700', style: 'normal' }],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
  variable: '--font-ibm-plex-sans-latin-ext',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
})

export const plexSansVietnamese = localFont({
  src: [{ path: './fonts/ibm-plex-sans-vietnamese-wght-normal.woff2', weight: '400 700', style: 'normal' }],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
    },
  ],
  variable: '--font-ibm-plex-sans-vietnamese',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
})

// Mono is for references and codes only, never as a "technical" costume.
export const plexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
})

export const plexMonoLatinExt = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-ext-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
  variable: '--font-ibm-plex-mono-latin-ext',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
})

export const plexMonoVietnamese = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-vietnamese-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-vietnamese-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
    },
  ],
  variable: '--font-ibm-plex-mono-vietnamese',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
})
