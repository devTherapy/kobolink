import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'

/**
 * The shared shell for `/login` and `/register` — DESIGN-SPEC §11's "Operate"
 * register (familiar, unsurprising, merchant-facing), on the ordinary
 * `--color-ground`, not the checkout's warmer `--color-checkout-ground`
 * (that token is reserved for the Persuade-mode public checkout — §11 draws
 * the line between the two registers explicitly).
 */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-(--color-ground) px-4 py-10 sm:py-16">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-1 text-center">
          <p className="text-[16px] font-semibold text-(--color-ink)">Kobolink</p>
          <h1 className="text-[23px] font-semibold text-(--color-ink)">{title}</h1>
          {subtitle ? <p className="text-[14px] text-(--color-ink-2)">{subtitle}</p> : null}
        </div>
        <Card>{children}</Card>
      </div>
    </main>
  )
}
