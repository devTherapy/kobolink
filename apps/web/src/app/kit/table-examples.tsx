'use client'

import { useState } from 'react'
import { formatNaira } from '@kobolink/contracts'
import { Table, type TableColumn } from '@/components/ui/Table'

interface DemoRow {
  id: string
  title: string
  amountKobo: number
}

// Amounts are kobo, formatted via `formatNaira` in `render` — the showcase
// demonstrates the real money rule, never a pre-formatted display string.
const COLUMNS: TableColumn<DemoRow>[] = [
  { key: 'title', header: 'Title', render: (row) => row.title },
  { key: 'amount', header: 'Amount', align: 'right', numeric: true, render: (row) => formatNaira(row.amountKobo) },
]

const ROWS: DemoRow[] = [
  { id: '1', title: 'Ankara Two-Piece Set', amountKobo: 1_850_000 },
  { id: '2', title: 'Aso-oke Gele', amountKobo: 950_000 },
  // Disabled row demo: an already-paid, non-reusable link's row an operator
  // shouldn't be able to reopen from the table.
  { id: '3', title: 'Agbada (sold out)', amountKobo: 4_500_000 },
]

/**
 * `onRowClick` is a function prop, so — like Field's controlled value —
 * demonstrating it needs a client boundary; a Server Component can't hand a
 * closure to a component that isn't itself `"use client"`. This is the one
 * place in the kit that shows Table's row states: default/hover/focus/
 * active (click a row, or Tab to it and press Enter/Space) and disabled
 * (the third row — a real `disabled` attribute on its first-cell button,
 * not just a dimmed look).
 */
export function ClickableTableExample() {
  const [lastActivated, setLastActivated] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-2">
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        emptyState="No links yet"
        onRowClick={(row) => {
          setLastActivated(row.title)
        }}
        isRowDisabled={(row) => row.id === '3'}
      />
      <p aria-live="polite" className="text-[13px] text-(--color-ink-3)">
        {lastActivated ? `Last activated: ${lastActivated}` : 'Click a row, or Tab to it and press Enter. Row 3 is disabled.'}
      </p>
    </div>
  )
}
