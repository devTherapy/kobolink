/**
 * A minimal inline SVG for the links table's empty state, matching the style
 * `components/checkout/icons.tsx` established: no icon package, `aria-hidden`
 * because the state it illustrates is always also said in words next to it.
 */
import type { SVGProps } from 'react'

export function LinkIcon(props: SVGProps<SVGSVGElement>) {
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
    >
      <path d="M9 15 15 9" />
      <path d="M11 6.5 12.5 5A4 4 0 0 1 18 10.5L16.5 12" />
      <path d="M13 17.5 11.5 19A4 4 0 0 1 6 13.5L7.5 12" />
    </svg>
  )
}
