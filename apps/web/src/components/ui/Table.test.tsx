import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TableColumn } from './Table'
import { Table } from './Table'

interface Row {
  id: string
  title: string
  amountKobo: number
}

const rows: Row[] = [
  { id: 'a', title: 'Ankara set', amountKobo: 1_850_000 },
  { id: 'b', title: 'Aso-oke gele', amountKobo: 950_000 },
]

const columns: TableColumn<Row>[] = [
  { key: 'title', header: 'Title', render: (row) => row.title },
  { key: 'amount', header: 'Amount', align: 'right', numeric: true, render: (row) => `₦${row.amountKobo}` },
]

describe('Table', () => {
  it('renders a header per column and one row per record (default state)', () => {
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" />)

    expect(screen.getByRole('columnheader', { name: 'Title' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toBeInTheDocument()
    expect(screen.getByText('Ankara set')).toBeInTheDocument()
    expect(screen.getByText('Aso-oke gele')).toBeInTheDocument()
  })

  it('marks numeric columns tabular', () => {
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" />)
    const cell = screen.getByText('₦1850000')
    expect(cell.className).toMatch(/tabular/)
  })

  it('renders the empty-row slot when there are no rows', () => {
    render(<Table columns={columns} rows={[]} rowKey={(row) => row.id} emptyState="No links yet" />)
    expect(screen.getByText('No links yet')).toBeInTheDocument()
    expect(screen.queryByText('Ankara set')).not.toBeInTheDocument()
  })

  it('renders skeleton rows and marks the table busy while loading (loading state)', () => {
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" loading />)

    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true')
    // Skeleton rows are `aria-hidden` filler, not the real data.
    expect(screen.queryByText('Ankara set')).not.toBeInTheDocument()
    expect(document.querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(3)
  })

  it('replaces the body with an alert when loading failed (error state)', () => {
    render(
      <Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" error="Could not load links." />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load links.')
    expect(screen.queryByText('Ankara set')).not.toBeInTheDocument()
  })

  it('composes a retry action into the error state, the same way emptyState does', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        emptyState="No rows"
        error={
          <>
            <p>Could not load links.</p>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </>
        }
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not load links.')
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('makes a row activatable by click and by keyboard when onRowClick is given (hover/focus/active state)', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" onRowClick={onRowClick} />)

    const firstRow = screen.getByText('Ankara set').closest('tr')
    expect(firstRow).toHaveAttribute('role', 'button')
    expect(firstRow?.className).toMatch(/hover:/)
    expect(firstRow?.className).toMatch(/focus-visible:outline/)
    expect(firstRow?.className).toMatch(/active:/)

    await user.click(within(firstRow!).getByText('Ankara set'))
    expect(onRowClick).toHaveBeenCalledWith(rows[0])

    firstRow?.focus()
    expect(firstRow).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  it('leaves a row with no onRowClick fully non-interactive', () => {
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" />)
    const firstRow = screen.getByText('Ankara set').closest('tr')
    expect(firstRow).not.toHaveAttribute('role')
    expect(firstRow).not.toHaveAttribute('tabindex')
  })

  it('blocks activation on a disabled row (disabled state)', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        emptyState="No rows"
        onRowClick={onRowClick}
        isRowDisabled={(row) => row.id === 'a'}
      />,
    )

    const disabledRow = screen.getByText('Ankara set').closest('tr')
    expect(disabledRow).toHaveAttribute('aria-disabled', 'true')
    expect(disabledRow).not.toHaveAttribute('role')

    await user.click(within(disabledRow!).getByText('Ankara set'))
    expect(onRowClick).not.toHaveBeenCalled()

    const enabledRow = screen.getByText('Aso-oke gele').closest('tr')
    await user.click(within(enabledRow!).getByText('Aso-oke gele'))
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })
})
