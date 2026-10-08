import type { Metadata, Viewport } from 'next'
import {
  plexMono,
  plexMonoLatinExt,
  plexMonoVietnamese,
  plexSans,
  plexSansLatinExt,
  plexSansVietnamese,
} from './fonts'
import './globals.css'

/*
 * Self-hosted by next/font/local (./fonts.ts): no render-blocking request to
 * Google, no layout shift, no third-party connection from the payer's browser
 * — which matters on a checkout page — and no network needed at build time.
 */
const fontVariables = [
  plexSans,
  plexSansLatinExt,
  plexSansVietnamese,
  plexMono,
  plexMonoLatinExt,
  plexMonoVietnamese,
]
  .map((font) => font.variable)
  .join(' ')

export const metadata: Metadata = {
  title: { default: 'Kobolink', template: '%s · Kobolink' },
  description: 'Payment links for Nigerian merchants.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#F6F5F2',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>{children}</body>
    </html>
  )
}
