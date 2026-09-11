/**
 * Minimal inline SVGs for the checkout's result screens. No icon package —
 * five glyphs don't earn a dependency, and `ui-ux-pro-max`'s own checklist
 * bans emoji standing in for icons. Every icon is `aria-hidden`: the state
 * it illustrates is always also said in words next to it (a screen reader
 * user gets "Payment successful", never a bare checkmark).
 */
import type { SVGProps } from 'react'

function Svg(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  )
}

export function CheckCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </Svg>
  )
}

export function XCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </Svg>
  )
}

export function AlertTriangleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 9.5v4.25" />
      <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function WifiOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3 3l18 18" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 12.5a10 10 0 0 1 3.2-2.2" />
      <path d="M12.5 7.5A10 10 0 0 1 19 10" />
      <circle cx="12" cy="20" r="0.75" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function SpinnerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true" className="animate-spin" {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
