import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatNaira } from '@kobolink/contracts'
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

// `formatNaira`, never a raw `₦${kobo}` template — kobo isn't naira, and a
// bare template literal would print "₦1850000" for what is actually ₦18,500.
const columns: TableColumn<Row>[] = [
  { key: 'title', header: 'Title', render: (row) => row.title },
  { key: 'amount', header: 'Amount', align: 'right', numeric: true, render: (row) => formatNaira(row.amountKobo) },
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
    const cell = screen.getByText(formatNaira(1_850_000))
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

  it('makes the first cell a real button when onRowClick is given, activatable by click and keyboard (hover/focus/active state)', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" onRowClick={onRowClick} />)

    const firstRow = screen.getByText('Ankara set').closest('tr')!
    // Row semantics stay real: `row`/`cell` roles are exactly what a plain
    // <tr>/<td> already provide (implicit, no `role` attribute needed), not
    // something the click handler removes.
    expect(screen.getAllByRole('row')).toContain(firstRow)
    expect(within(firstRow).getAllByRole('cell')).toHaveLength(columns.length)
    expect(firstRow.className).toMatch(/hover:bg-\(--color-border-soft\)/)
    expect(firstRow.className).toMatch(/active:bg-\(--color-border\)/)

    const actionButton = within(firstRow).getByRole('button', { name: 'Ankara set' })
    expect(actionButton.className).toMatch(/focus-visible:outline/)

    await user.click(actionButton)
    expect(onRowClick).toHaveBeenCalledWith(rows[0])

    actionButton.focus()
    expect(actionButton).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  it('never carries a base outline-none/outline-hidden alongside focus-visible:outline on the row action button (focus state)', () => {
    // A base `outline-none`/`outline-hidden` unconditionally zeroes
    // Tailwind's `--tw-outline-style` custom property, which silently
    // defeats `focus-visible:outline-2` below it — it would never draw a
    // ring even while `:focus-visible` genuinely matches. See the note in
    // `ui/Field.tsx` for the full mechanism.
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" onRowClick={vi.fn()} />)
    const actionButton = screen.getByRole('button', { name: 'Ankara set' })
    expect(actionButton.className).toMatch(/focus-visible:outline-2/)
    expect(actionButton.className).not.toMatch(/\boutline-none\b/)
    expect(actionButton.className).not.toMatch(/\boutline-hidden\b/)
  })

  it('does not double-fire when a nested interactive element inside a row handles its own click', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onAction = vi.fn()
    const columnsWithAction: TableColumn<Row>[] = [
      ...columns,
      { key: 'actions', header: 'Actions', render: () => <button type="button" onClick={onAction}>Copy</button> },
    ]
    render(
      <Table columns={columnsWithAction} rows={rows} rowKey={(row) => row.id} emptyState="No rows" onRowClick={onRowClick} />,
    )

    const firstRow = screen.getByText('Ankara set').closest('tr')!
    await user.click(within(firstRow).getByRole('button', { name: 'Copy' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('leaves a row with no onRowClick fully non-interactive', () => {
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyState="No rows" />)
    const firstRow = screen.getByText('Ankara set').closest('tr')!
    expect(within(firstRow).queryByRole('button')).not.toBeInTheDocument()
  })

  describe('rowHref — rows that navigate', () => {
    it('renders column 0 as a real link and no button, so it works without client JS', () => {
      render(
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyState="No rows"
          rowHref={(row) => `/items/${row.id}`}
        />,
      )

      const link = screen.getByRole('link', { name: 'Ankara set' })
      expect(link).toHaveAttribute('href', '/items/a')
      expect(screen.getByRole('link', { name: 'Aso-oke gele' })).toHaveAttribute('href', '/items/b')
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      // Row and cell roles are untouched: it is a table with a link in it, not a table of links.
      expect(within(link.closest('tr')!).getAllByRole('cell')).toHaveLength(columns.length)
    })

    it('takes its accessible name from rowLabel when given', () => {
      render(
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyState="No rows"
          rowHref={(row) => `/items/${row.id}`}
          rowLabel={(row) => `Open ${row.title}`}
        />,
      )

      expect(screen.getByRole('link', { name: 'Open Ankara set' })).toBeInTheDocument()
    })

    it('stretches the link over the whole row, so a mouse can click anywhere, and rings the row on focus', () => {
      render(
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyState="No rows"
          rowHref={(row) => `/items/${row.id}`}
        />,
      )

      const link = screen.getByRole('link', { name: 'Ankara set' })
      const row = link.closest('tr')!
      expect(row.className).toMatch(/\brelative\b/)
      expect(row.className).toMatch(/hover:bg-\(--color-border-soft\)/)
      expect(row.className).toMatch(/active:bg-\(--color-border\)/)
      expect(link.className).toMatch(/after:absolute/)
      expect(link.className).toMatch(/after:inset-0/)
      expect(link.className).toMatch(/focus-visible:after:outline-2/)
      // The ring is on the stretched pseudo-element: the anchor's own outline is width-zeroed so they do not stack,
      // and — as for the button — never `outline-none`, which would also kill the pseudo's `--tw-outline-style`.
      expect(link.className).toMatch(/focus-visible:outline-0/)
      expect(link.className).not.toMatch(/(^|\s)(focus-visible:)?outline-(none|hidden)/)
    })

    it('is reachable and activatable by keyboard — Tab lands on the link', async () => {
      const user = userEvent.setup()
      render(
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyState="No rows"
          rowHref={(row) => `/items/${row.id}`}
        />,
      )

      await user.tab()
      expect(screen.getByRole('link', { name: 'Ankara set' })).toHaveFocus()
      await user.tab()
      expect(screen.getByRole('link', { name: 'Aso-oke gele' })).toHaveFocus()
    })

    it('wins over onRowClick when both are given', () => {
      render(
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyState="No rows"
          rowHref={(row) => `/items/${row.id}`}
          onRowClick={vi.fn()}
        />,
      )

      expect(screen.getAllByRole('link')).toHaveLength(rows.length)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('renders a disabled row as plain text, not a link (disabled state)', () => {
      render(
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyState="No rows"
          rowHref={(row) => `/items/${row.id}`}
          isRowDisabled={(row) => row.id === 'a'}
        />,
      )

      expect(screen.queryByRole('link', { name: 'Ankara set' })).not.toBeInTheDocument()
      expect(screen.getByText('Ankara set')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Aso-oke gele' })).toBeInTheDocument()
    })
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

    const disabledButton = screen.getByRole('button', { name: 'Ankara set' })
    expect(disabledButton).toBeDisabled()

    await user.click(disabledButton)
    expect(onRowClick).not.toHaveBeenCalled()

    const enabledButton = screen.getByRole('button', { name: 'Aso-oke gele' })
    expect(enabledButton).not.toBeDisabled()
    await user.click(enabledButton)
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })
})
