'use client'

import { useState } from 'react'
import { Table, type TableColumn } from '@/components/ui/Table'

interface DemoRow {
  id: string
  title: string
  amount: string
}

const COLUMNS: TableColumn<DemoRow>[] = [
  { key: 'title', header: 'Title', render: (row) => row.title },
  { key: 'amount', header: 'Amount', align: 'right', numeric: true, render: (row) => row.amount },
]

const ROWS: DemoRow[] = [
  { id: '1', title: 'Ankara Two-Piece Set', amount: '₦18,500' },
  { id: '2', title: 'Aso-oke Gele', amount: '₦9,500' },
]

/**
 * `onRowClick` is a function prop, so — like Field's controlled value —
 * demonstrating it needs a client boundary; a Server Component can't hand a
 * closure to a component that isn't itself `"use client"`. This is the one
 * place in the kit that shows Table's row states: default/hover/focus/
 * active (click a row, or Tab to it and press Enter/Space).
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
      />
      <p aria-live="polite" className="text-[13px] text-(--color-ink-3)">
        {lastActivated ? `Last activated: ${lastActivated}` : 'Click a row, or Tab to it and press Enter.'}
      </p>
    </div>
  )
}
