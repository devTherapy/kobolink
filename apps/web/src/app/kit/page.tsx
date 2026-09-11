import type { Metadata } from 'next'
import { formatNaira } from '@kobolink/contracts'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pill, StatusPill, type PillStatus } from '@/components/ui/Pill'
import { Skeleton } from '@/components/ui/Skeleton'
import { Table, type TableColumn } from '@/components/ui/Table'
import { TextFieldExample } from './field-examples'
import { ClickableTableExample } from './table-examples'

export const metadata: Metadata = {
  title: 'UI Kit',
}

const SECTION_TITLE = 'text-[19px] font-semibold text-(--color-ink)'
const SECTION_LABEL = 'text-[13px] font-medium text-(--color-ink-3)'

// Static demo fixtures — hoisted to module scope rather than rebuilt on
// every render of `KitPage` (`rendering-hoist-jsx`/`js-cache-function-results`
// spirit: nothing here depends on props or request data). Amounts are kobo,
// formatted via `formatNaira` in `render` — never a pre-formatted string —
// so the showcase demonstrates the real money rule, not a shortcut around it.
const TABLE_COLUMNS: TableColumn<{ id: string; title: string; amountKobo: number }>[] = [
  { key: 'title', header: 'Title', render: (row) => row.title },
  { key: 'amount', header: 'Amount', align: 'right', numeric: true, render: (row) => formatNaira(row.amountKobo) },
]
const TABLE_ROWS = [
  { id: '1', title: 'Ankara Two-Piece Set', amountKobo: 1_850_000 },
  { id: '2', title: 'Aso-oke Gele', amountKobo: 950_000 },
]
const STATUSES: PillStatus[] = ['Active', 'Disabled', 'Expired', 'Paid', 'Pending', 'Failed']

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className={SECTION_TITLE}>{title}</h2>
      {children}
    </section>
  )
}

function StateLabel({ children }: { children: React.ReactNode }) {
  return <span className={SECTION_LABEL}>{children}</span>
}

// A decorative demo icon only — EmptyState hides it from assistive tech
// itself (`aria-hidden` on its wrapper), so no `<title>`/role is needed here.
function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 15l6-6m-5-1 1.2-1.2a3 3 0 1 1 4.2 4.2L14 12m-4 4-1.2 1.2a3 3 0 1 1-4.2-4.2L6 12"
      />
    </svg>
  )
}

/**
 * F1's showcase: every component in every one of its seven states, for the
 * `web-design-guidelines` pass and for screenshots at 375 / 768 / 1024 / 1440.
 * A server component — no data, nothing that needs a client boundary — so a
 * `"use client"` island (`field-examples.tsx`, next to this file) carries
 * only the two Field demos that need local state.
 */
export default function KitPage() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-14 px-6 py-12">
      <header className="flex flex-col gap-1">
        <p className={SECTION_LABEL}>Kobolink</p>
        <h1 className="text-[26px] font-semibold text-(--color-ink)">UI Kit</h1>
        <p className="max-w-2xl text-[14px] text-(--color-ink-2)">
          Every component from the F1 kit, in every state it ships. Built from the tokens in{' '}
          <code className="font-mono text-[13px]">globals.css</code> — the tokens define every colour these
          components use, extended (never replaced) when a new one earns its place, like the skeleton fill below.
        </p>
      </header>

      <Section title="Button">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-col items-start gap-2">
              <StateLabel>primary</StateLabel>
              <Button variant="primary">Create link</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>secondary</StateLabel>
              <Button variant="secondary">Cancel</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>ghost</StateLabel>
              <Button variant="ghost">Copy link</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>danger</StateLabel>
              <Button variant="danger">Disable link</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-col items-start gap-2">
              <StateLabel>default</StateLabel>
              <Button>Save</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>disabled</StateLabel>
              <Button disabled>Save</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>loading</StateLabel>
              <Button status="loading">Pay now</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>error</StateLabel>
              <Button status="error">Retry</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-col items-start gap-2">
              <StateLabel>sm</StateLabel>
              <Button size="sm">Small</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>md</StateLabel>
              <Button size="md">Medium</Button>
            </div>
            <div className="flex flex-col items-start gap-2">
              <StateLabel>lg</StateLabel>
              <Button size="lg">Large</Button>
            </div>
          </div>
          <p className={SECTION_LABEL}>
            Hover, focus and active are pointer/keyboard states — try Tab, click-and-hold, and mouse-over on the
            buttons above.
          </p>
        </div>
      </Section>

      <Section title="Field">
        <div className="grid max-w-xl grid-cols-1 gap-6 sm:grid-cols-2">
          <TextFieldExample />
        </div>
        <p className={SECTION_LABEL}>
          Hover, focus and active are pointer/keyboard states — try Tab and click into the fields above.
        </p>
      </Section>

      <Section title="Pill">
        <div className="flex flex-wrap items-center gap-3">
          {STATUSES.map((status) => (
            <StatusPill key={status} status={status} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Pill tone="success">success tone</Pill>
          <Pill tone="warning">warning tone</Pill>
          <Pill tone="danger">danger tone</Pill>
          <Pill tone="neutral">neutral tone</Pill>
        </div>
      </Section>

      <Section title="Card">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <p className={SECTION_LABEL}>Adebayo Stores</p>
            <h3 className="text-[19px] font-semibold text-(--color-ink)">Ankara Two-Piece Set</h3>
            <p className="tabular mt-1 text-[23px] font-semibold text-(--color-ink)">{formatNaira(1_850_000)}</p>
          </Card>
          <Card as="article" padding="none">
            <div className="p-4">
              <p className={SECTION_LABEL}>padding=&quot;none&quot;, own padding inside</p>
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Table">
        <div className="flex flex-col gap-6">
          <div>
            <StateLabel>default, with rows</StateLabel>
            <Card padding="none" className="mt-2 overflow-hidden">
              <Table columns={TABLE_COLUMNS} rows={TABLE_ROWS} rowKey={(row) => row.id} emptyState="No links yet" />
            </Card>
          </div>
          <div>
            <StateLabel>clickable row — default, hover, focus, active</StateLabel>
            <Card padding="none" className="mt-2 overflow-hidden">
              <ClickableTableExample />
            </Card>
          </div>
          <div>
            <StateLabel>loading</StateLabel>
            <Card padding="none" className="mt-2 overflow-hidden">
              <Table columns={TABLE_COLUMNS} rows={[]} rowKey={(row) => row.id} emptyState="No links yet" loading />
            </Card>
          </div>
          <div>
            <StateLabel>error, with a composed retry action</StateLabel>
            <Card padding="none" className="mt-2 overflow-hidden">
              <Table
                columns={TABLE_COLUMNS}
                rows={[]}
                rowKey={(row) => row.id}
                emptyState="No links yet"
                error={
                  <>
                    <p>Could not load links. No changes were made.</p>
                    <Button variant="secondary" size="sm">
                      Retry
                    </Button>
                  </>
                }
              />
            </Card>
          </div>
          <div>
            <StateLabel>empty</StateLabel>
            <Card padding="none" className="mt-2 overflow-hidden">
              <Table
                columns={TABLE_COLUMNS}
                rows={[]}
                rowKey={(row) => row.id}
                emptyState={
                  // h3: nested under this page's own "Table" <h2>, so the
                  // demo's heading doesn't sit at the same level as its
                  // section label.
                  <EmptyState
                    as="h3"
                    icon={<LinkIcon />}
                    title="No links yet"
                    body="Create your first payment link to see it here."
                  />
                }
              />
            </Card>
          </div>
        </div>
      </Section>

      <Section title="EmptyState">
        <Card padding="none">
          {/* h3 here too, for the same reason as the Table section's empty
              slot above — nested under this page's own "EmptyState" <h2>. */}
          <EmptyState
            as="h3"
            icon={<LinkIcon />}
            title="No links yet"
            body="Create your first payment link to start getting paid."
            action={<Button variant="primary">Create a link</Button>}
          />
        </Card>
      </Section>

      <Section title="Skeleton">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <StateLabel>block</StateLabel>
            <Skeleton shape="block" width="12rem" height="8rem" aria-label="Loading card" />
          </div>
          <div className="flex flex-col gap-2">
            <StateLabel>line</StateLabel>
            <Skeleton shape="line" width="60%" aria-label="Loading title" />
          </div>
          <div className="flex flex-col gap-2">
            <StateLabel>table-row</StateLabel>
            <table className="w-full max-w-md border-collapse">
              <tbody>
                <Skeleton shape="table-row" columns={3} />
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </main>
  )
}
