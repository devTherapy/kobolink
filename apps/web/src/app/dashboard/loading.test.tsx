import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LINKS_TABLE_COLUMNS } from '@/components/dashboard/LinksTable'
import DashboardLoading from './loading'

describe('DashboardLoading — Done when: loading is a skeleton shaped like the content', () => {
  it('renders three stat-card skeletons, not a spinner', () => {
    render(<DashboardLoading />)
    expect(screen.getAllByLabelText('Loading stat value')).toHaveLength(3)
    expect(document.querySelector('svg')).not.toBeInTheDocument()
  })

  it('renders the real table header with skeleton rows underneath, marked busy', () => {
    render(<DashboardLoading />)

    for (const column of LINKS_TABLE_COLUMNS) {
      expect(screen.getByRole('columnheader', { name: column.header })).toBeInTheDocument()
    }

    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true')
    expect(document.querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(4)
  })
})
