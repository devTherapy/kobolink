import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from './cn'
import { Skeleton } from './Skeleton'

export interface TableColumn<T> {
  key: string
  header: string
  align?: 'left' | 'right' | undefined
  /** Applies `tabular-nums` — set for every money or count column. */
  numeric?: boolean | undefined
  render: (row: T) => ReactNode
}

export interface TableProps<T> {
  columns: TableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** Sticky header, for a table taller than its scroll container. */
  sticky?: boolean
  loading?: boolean
  loadingRowCount?: number
  /** What the empty-row slot renders when `rows` is empty and nothing is loading or has failed. */
  emptyState: ReactNode
  /**
   * A load failure. Replaces the body with a single full-width row —
   * composed the same way `emptyState` is, so the caller can pair the
   * message with a retry `<Button>` (§11: failure states "name what went
   * wrong … and offer the next step") instead of only a static string.
   */
  error?: ReactNode
  /** Rows become the interactive unit when this is given — see the states note below. */
  onRowClick?: ((row: T) => void) | undefined
  isRowDisabled?: ((row: T) => boolean) | undefined
  className?: string | undefined
}

/**
 * A row is only ever one of loading / error / empty / data — never two at
 * once — so this picks the body content with an if-chain rather than
 * threading multiple booleans through JSX conditionals.
 */
function renderBody<T>({
  columns,
  rows,
  rowKey,
  loading,
  loadingRowCount,
  emptyState,
  error,
  onRowClick,
  isRowDisabled,
}: Required<Pick<TableProps<T>, 'columns' | 'rows' | 'rowKey' | 'loadingRowCount' | 'emptyState'>> &
  Pick<TableProps<T>, 'loading' | 'error' | 'onRowClick' | 'isRowDisabled'>) {
  const columnCount = columns.length

  if (loading) {
    return Array.from({ length: loadingRowCount }, (_unused, index) => (
      <Skeleton key={index} shape="table-row" columns={columnCount} />
    ))
  }

  if (error) {
    return (
      <tr>
        <td colSpan={columnCount} className="px-4 py-10">
          <div role="alert" className="flex flex-col items-center gap-3 text-center text-[14px] text-(--color-danger)">
            {error}
          </div>
        </td>
      </tr>
    )
  }

  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={columnCount} className="p-0">
          {emptyState}
        </td>
      </tr>
    )
  }

  return rows.map((row) => {
    const disabled = isRowDisabled?.(row) ?? false
    return (
      <TableRow
        key={rowKey(row)}
        row={row}
        columns={columns}
        onRowClick={onRowClick && !disabled ? onRowClick : undefined}
        disabled={disabled}
      />
    )
  })
}

/**
 * Semantic `<table>`. Numeric columns carry `.tabular` so money and counts
 * align. `loading` / `error` / an empty `rows` array each replace the body
 * with one full-width row (a skeleton set, a message, or the caller's empty
 * state) rather than leaving a table with a header and nothing under it.
 *
 * `loading` and `error` are properties of the *fetch* — the whole table is
 * either mid-request, failed, or showing data — not of an individual row's
 * click action, so they live here rather than on `TableRow`. A row's own
 * seven states are the ones the design spec names for it specifically
 * (§11: "row focus/hover"): default/hover/focus/active/disabled.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  sticky = false,
  loading = false,
  loadingRowCount = 3,
  emptyState,
  error,
  onRowClick,
  isRowDisabled,
  className,
}: TableProps<T>) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full min-w-full border-collapse text-[14px]" aria-busy={loading || undefined}>
        <thead className={cn(sticky && 'sticky top-0 z-10 bg-(--color-surface)')}>
          <tr className="border-b border-(--color-border)">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-4 py-3 text-[13px] font-medium text-(--color-ink-3)',
                  column.align === 'right' ? 'text-right' : 'text-left',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {renderBody({
            columns,
            rows,
            rowKey,
            loading,
            loadingRowCount,
            emptyState,
            error,
            onRowClick,
            isRowDisabled,
          })}
        </tbody>
      </table>
    </div>
  )
}

interface TableRowProps<T> {
  row: T
  columns: TableColumn<T>[]
  onRowClick?: ((row: T) => void) | undefined
  disabled: boolean
}

/**
 * A `<tr>` can't be a `<button>`, so a clickable row trades table-row
 * semantics for `role="button"` plus keyboard handling — the same tradeoff
 * GitHub's and Linear's own row-as-link tables make. `aria-disabled` (not
 * the native `disabled` attribute, which `<tr>` doesn't support) plus
 * dropping the click handler blocks the disabled case the same way a real
 * disabled control would. A row with no `onRowClick` renders as a plain,
 * non-interactive row: no hover, focus, active or disabled styling, because
 * none of those states apply to something nothing can activate.
 */
function TableRow<T>({ row, columns, onRowClick, disabled }: TableRowProps<T>) {
  const clickable = Boolean(onRowClick)

  function activate() {
    onRowClick?.(row)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate()
    }
  }

  return (
    <tr
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? 'button' : undefined}
      aria-disabled={disabled || undefined}
      onClick={clickable ? activate : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      className={cn(
        'border-b border-(--color-border-soft) last:border-0',
        clickable &&
          'touch-manipulation cursor-pointer hover:bg-(--color-border-soft) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--color-brand) active:bg-(--color-border)',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {columns.map((column) => (
        <td
          key={column.key}
          className={cn(
            'px-4 py-3 text-(--color-ink)',
            column.numeric && 'tabular',
            column.align === 'right' ? 'text-right' : 'text-left',
          )}
        >
          {column.render(row)}
        </td>
      ))}
    </tr>
  )
}
