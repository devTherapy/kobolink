import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { API, examplePayment, type Payment } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { PaymentsSection } from './PaymentsSection'

const CODE = 'aBcDeFgH'

const paid = examplePayment({ reference: 'kbl_aaaaaaaaaa', payerName: 'Ngozi Okafor' })
const declined = examplePayment({
  reference: 'kbl_bbbbbbbbbb',
  payerName: 'Tunde Bello',
  payerEmail: 't***@example.com',
  status: 'failed',
  completedAt: null,
  failureReason: 'The card was declined.',
})
const pending = examplePayment({
  reference: 'kbl_cccccccccc',
  payerName: 'Amaka Eze',
  status: 'pending',
  completedAt: null,
})

describe('PaymentsSection', () => {
  it('lists payments with payer, amount, status and date — money via formatNaira', () => {
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor={null} />)

    expect(screen.getByRole('heading', { level: 2, name: 'Payments' })).toBeInTheDocument()
    for (const header of ['Payer', 'Amount', 'Status', 'Date']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    expect(screen.getByText('Ngozi Okafor')).toBeInTheDocument()
    expect(screen.getByText('n***@example.com')).toBeInTheDocument()
    expect(screen.getByText('₦18,500')).toBeInTheDocument()
    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.getByText(/14 Jun 2026|Jun 14, 2026/)).toBeInTheDocument()
    expect(screen.getByText('kbl_aaaaaaaaaa')).toBeInTheDocument()
  })

  it('says whether money moved on every payment that did not complete', () => {
    render(<PaymentsSection code={CODE} initialPayments={[paid, declined, pending]} initialCursor={null} />)

    const rows = screen.getAllByRole('row')
    const failedRow = rows.find((row) => within(row).queryByText('Tunde Bello'))
    const pendingRow = rows.find((row) => within(row).queryByText('Amaka Eze'))
    const paidRow = rows.find((row) => within(row).queryByText('Ngozi Okafor'))

    expect(failedRow).toHaveTextContent('Failed')
    expect(failedRow).toHaveTextContent('The card was declined. No money moved.')
    expect(pendingRow).toHaveTextContent('Pending')
    expect(pendingRow).toHaveTextContent('No money moved.')
    expect(paidRow).not.toHaveTextContent('No money moved')
  })

  it('teaches the interface when there are no payments, instead of an empty table', () => {
    render(<PaymentsSection code={CODE} initialPayments={[]} initialCursor={null} />)

    expect(screen.getByRole('heading', { level: 3, name: 'No payments yet' })).toBeInTheDocument()
    expect(screen.getByText(/scan its QR code/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more payments' })).not.toBeInTheDocument()
  })

  it('offers "Show more" while there is a next page', () => {
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)
    expect(screen.getByRole('button', { name: 'Show more payments' })).toBeInTheDocument()
  })

  it('offers no "Show more" on a single page', () => {
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor={null} />)
    expect(screen.queryByRole('button', { name: 'Show more payments' })).not.toBeInTheDocument()
  })

  it('follows the cursor, appends the next page, and drops the button on the last page', async () => {
    const user = userEvent.setup()
    const seen: string[] = []
    server.use(
      http.get(API.links.payments(':code'), ({ request }) => {
        seen.push(new URL(request.url).search)
        return HttpResponse.json({ items: [declined], nextCursor: null })
      }),
    )
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

    await user.click(screen.getByRole('button', { name: 'Show more payments' }))

    expect(await screen.findByText('Tunde Bello')).toBeInTheDocument()
    expect(screen.getByText('Ngozi Okafor')).toBeInTheDocument()
    expect(seen).toEqual(['?cursor=cur_1&limit=20'])
    expect(screen.queryByRole('button', { name: 'Show more payments' })).not.toBeInTheDocument()
  })

  it('never shows the same payment twice if a later page repeats one', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(API.links.payments(':code'), () => HttpResponse.json({ items: [paid, declined], nextCursor: null })),
    )
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

    await user.click(screen.getByRole('button', { name: 'Show more payments' }))
    await screen.findByText('Tunde Bello')

    expect(screen.getAllByText('Ngozi Okafor')).toHaveLength(1)
  })

  it('shows a busy button while the next page loads, and ignores a second click', async () => {
    const user = userEvent.setup()
    let release: () => void = vi.fn()
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    server.use(
      http.get(API.links.payments(':code'), async () => {
        calls += 1
        await gate
        return HttpResponse.json({ items: [declined], nextCursor: null })
      }),
    )
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

    const button = screen.getByRole('button', { name: 'Show more payments' })
    await user.click(button)
    await user.click(button)
    expect(button).toHaveAttribute('aria-busy', 'true')
    release()

    await screen.findByText('Tunde Bello')
    expect(calls).toBe(1)
  })

  it('names the failure, keeps what is already shown, and retries from the same cursor', async () => {
    const user = userEvent.setup()
    const cursors: (string | null)[] = []
    let attempt = 0
    server.use(
      http.get(API.links.payments(':code'), ({ request }) => {
        cursors.push(new URL(request.url).searchParams.get('cursor'))
        attempt += 1
        if (attempt === 1) return HttpResponse.json({ code: 'internal', message: 'boom' }, { status: 500 })
        return HttpResponse.json({ items: [declined], nextCursor: null })
      }),
    )
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

    await user.click(screen.getByRole('button', { name: 'Show more payments' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/couldn't load more payments/i)
    expect(alert).toHaveTextContent(/payments above are unaffected/i)
    expect(alert).toHaveTextContent(/no money moved/i)
    // What was already on screen is untouched, and the button is still there to try again.
    expect(screen.getByText('Ngozi Okafor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show more payments' })).toHaveAttribute('data-error', 'true')

    await user.click(screen.getByRole('button', { name: 'Show more payments' }))

    expect(await screen.findByText('Tunde Bello')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(cursors).toEqual(['cur_1', 'cur_1'])
  })

  describe('after "Show more" loads the last page', () => {
    it('moves focus off the button that unmounts, onto the live message that says what arrived', async () => {
      const user = userEvent.setup()
      server.use(
        http.get(API.links.payments(':code'), () =>
          HttpResponse.json({ items: [declined, pending], nextCursor: null }),
        ),
      )
      render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

      await user.click(screen.getByRole('button', { name: 'Show more payments' }))

      await screen.findByText('Tunde Bello')
      expect(screen.queryByRole('button', { name: 'Show more payments' })).not.toBeInTheDocument()
      // Not <body>: keyboard and screen-reader users stay where the list grew.
      const message = screen.getByRole('status')
      expect(message).toHaveTextContent('2 more payments loaded.')
      expect(message).toHaveFocus()
    })

    it('says the count in the singular for one payment', async () => {
      const user = userEvent.setup()
      server.use(
        http.get(API.links.payments(':code'), () => HttpResponse.json({ items: [declined], nextCursor: null })),
      )
      render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

      await user.click(screen.getByRole('button', { name: 'Show more payments' }))

      expect(await screen.findByRole('status')).toHaveTextContent('1 more payment loaded.')
    })
  })

  it('announces a middle page too, and leaves focus on the button that is still there', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(API.links.payments(':code'), () => HttpResponse.json({ items: [declined], nextCursor: 'cur_2' })),
    )
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

    await user.click(screen.getByRole('button', { name: 'Show more payments' }))

    await screen.findByText('Tunde Bello')
    expect(screen.getByRole('status')).toHaveTextContent('1 more payment loaded.')
    expect(screen.getByRole('button', { name: 'Show more payments' })).toHaveFocus()
  })

  it('an expired session says so and offers sign-in back to this page — a retry could never succeed', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(API.links.payments(':code'), () =>
        HttpResponse.json({ code: 'unauthenticated', message: 'Sign in.' }, { status: 401 }),
      ),
    )
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

    await user.click(screen.getByRole('button', { name: 'Show more payments' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/session has expired/i)
    expect(alert).toHaveTextContent(/payments above are unaffected/i)
    expect(within(alert).getByRole('link', { name: /sign in again/i })).toHaveAttribute(
      'href',
      '/login?next=%2Fdashboard%2Flinks%2FaBcDeFgH',
    )
    expect(screen.queryByRole('button', { name: 'Show more payments' })).not.toBeInTheDocument()
    expect(screen.getByText('Ngozi Okafor')).toBeInTheDocument()
  })

  it('a failure that is not a session problem still offers Try again and no sign-in link', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(API.links.payments(':code'), () => HttpResponse.json({ code: 'internal', message: 'x' }, { status: 500 })),
    )
    render(<PaymentsSection code={CODE} initialPayments={[paid]} initialCursor="cur_1" />)

    await user.click(screen.getByRole('button', { name: 'Show more payments' }))

    await screen.findByRole('alert')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show more payments' })).toBeInTheDocument()
  })

  it('every payment row is a plain table row — real row and cell roles, nothing clickable', () => {
    const rows: Payment[] = [paid, declined]
    render(<PaymentsSection code={CODE} initialPayments={rows} initialCursor={null} />)

    expect(screen.getAllByRole('row')).toHaveLength(rows.length + 1)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
