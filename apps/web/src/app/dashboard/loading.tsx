import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Table } from '@/components/ui/Table'
import { LINKS_TABLE_COLUMNS } from '@/components/dashboard/LinksTable'

/**
 * Next's file convention: rendered while `page.tsx`'s async data fetch
 * (`loadDashboardData`) is in flight, in place of Next's default "render
 * nothing until it resolves." Shaped like the real content it stands in for
 * — three stat cards, then the links table's own header and skeleton rows —
 * never a centred spinner (§11 non-negotiable).
 *
 * `LINKS_TABLE_COLUMNS` is imported from `LinksTable` itself rather than
 * redeclared here, so the skeleton always has the same column count and
 * headers as the real table — a second, hand-maintained column list here
 * could silently drift from the one `LinksTable` actually renders.
 */
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton shape="line" width="14rem" className="h-6" aria-label="Loading dashboard" />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_unused, index) => (
          <Card key={index} className="flex flex-col gap-2">
            <Skeleton shape="line" width="60%" aria-label="Loading stat label" />
            <Skeleton shape="block" height="1.75rem" width="45%" aria-label="Loading stat value" />
          </Card>
        ))}
      </div>

      <Card padding="none">
        <Table
          columns={LINKS_TABLE_COLUMNS}
          rows={[]}
          rowKey={(link) => link.code}
          emptyState={null}
          loading
          loadingRowCount={4}
        />
      </Card>
    </div>
  )
}
