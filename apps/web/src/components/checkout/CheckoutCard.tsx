import type { ReactNode } from 'react'

/**
 * The one visual shell every `/l/[code]` screen sits inside — payable,
 * disabled, expired, already-paid, and every `PayForm` result. A plain
 * function component (no directive): rendered from the server page for the
 * page shell and non-payable screens, and from inside the `"use client"`
 * `PayForm` for its own result states, without needing two copies of the
 * same markup.
 */
export function CheckoutShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-(--color-checkout-ground) px-4 py-10 sm:py-16">
      <div className="w-full max-w-md">{children}</div>
    </main>
  )
}

export function CheckoutCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-(--radius-card) border border-(--color-border) bg-(--color-surface) p-6 shadow-(--shadow-card) sm:p-8">
      {children}
    </div>
  )
}
