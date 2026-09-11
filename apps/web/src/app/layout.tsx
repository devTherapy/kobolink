import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import { MswProvider } from '@/mocks/msw-provider'
import './globals.css'

/**
 * Self-hosted at build time by next/font: no render-blocking request to
 * Google, no layout shift, and no third-party connection from the payer's
 * browser — which matters on a checkout page.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
})

// Mono is for references and codes only, never as a "technical" costume.
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
})

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
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <MswProvider>{children}</MswProvider>
      </body>
    </html>
  )
}
