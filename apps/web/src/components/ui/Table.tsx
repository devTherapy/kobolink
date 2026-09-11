import type { MouseEvent, ReactNode } from 'react'
import { cn } from './cn'
import { Skeleton } from './Skeleton'

/** Matches any element that already owns its own click/keyboard activation. */
const INTERACTIVE_DESCENDANT_SELECTOR = 'button, a, input, select, textarea, [role="button"], [role="link"]'

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
  /**
   * Sticky header, for a table taller than its scroll container. Has no
   * effect while `Table` is wrapped by its own `overflow-x-auto` div and
   * that div's height is unconstrained (the default) — the container never
   * scrolls vertically, so `position: sticky` never has anything to stick
   * against. Give the wrapping `className` a bounded height
   * (e.g. `max-h-96 overflow-y-auto`) for this to do anything.
   */
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
        onRowClick={onRowClick}
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
 * `role="button"` on the `<tr>` was tried and reverted: it replaces the row's
 * entire accessible role, so a screen reader stops presenting `cell`
 * children at all, and a real control rendered inside one of those cells
 * (F5 puts an actions menu in a payments row) becomes a button nested inside
 * a button — invalid, and dropped from the accessibility tree by most
 * screen readers.
 *
 * Instead the row stays a plain `<tr>`/`<td>` (real `row`/`cell` roles,
 * verified in the test below), and the row's primary action is a real
 * `<button>` occupying the first cell — keyboard/screen-reader users tab to
 * and activate *that*, the same way a table with a "linkified" first column
 * works elsewhere. The `<tr>` keeps a plain `onClick` only as a mouse
 * convenience ("click anywhere in the row"), guarded so a click that
 * originated inside any interactive descendant (that first-cell button, or
 * a future action in another cell) does not also fire the row handler —
 * otherwise every click on the primary button would activate `onRowClick`
 * twice, once via the button and once via bubbling to the row.
 */
function TableRow<T>({ row, columns, onRowClick, disabled }: TableRowProps<T>) {
  const clickable = Boolean(onRowClick) && !disabled

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement
    if (target.closest(INTERACTIVE_DESCENDANT_SELECTOR)) return
    onRowClick?.(row)
  }

  return (
    <tr
      onClick={clickable ? handleRowClick : undefined}
      className={cn(
        'border-b border-(--color-border-soft) last:border-0',
        clickable && 'hover:bg-(--color-border-soft) active:bg-(--color-border)',
        disabled && 'opacity-50',
      )}
    >
      {columns.map((column, index) => {
        const isPrimaryAction = index === 0 && Boolean(onRowClick)
        return (
          <td
            key={column.key}
            className={cn(
              'min-w-0 break-words text-(--color-ink)',
              isPrimaryAction ? 'p-0' : 'px-4 py-3',
              column.numeric && 'tabular',
              column.align === 'right' ? 'text-right' : 'text-left',
            )}
          >
            {isPrimaryAction ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRowClick?.(row)}
                className={cn(
                  'w-full touch-manipulation px-4 py-3 text-left outline-none',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--color-brand)',
                  'disabled:cursor-not-allowed',
                  !disabled && 'cursor-pointer',
                )}
              >
                {column.render(row)}
              </button>
            ) : (
              column.render(row)
            )}
          </td>
        )
      })}
    </tr>
  )
}
