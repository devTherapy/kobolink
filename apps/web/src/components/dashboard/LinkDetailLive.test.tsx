import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API,
  exampleLink,
  examplePayment,
  exampleStats,
  type DashboardEvent,
  type Payment,
  type PaymentLink,
} from '@kobolink/contracts'
import { DashboardStreamProvider } from '@/components/live/DashboardStreamProvider'
import { server } from '@/mocks/server'
import { FakeEventSource } from '@/test/fake-event-source'
import { LinkFigures } from './LinkFigures'
import { LinkStatusControl } from './LinkStatusControl'
import { PaymentsSection } from './PaymentsSection'

/**
 * F5's link-detail islands, driven by the F7 stream: a payment or a status
 * change arriving while the page is open reaches the figures, the payments
 * table and the switch — and a `router.refresh()` that hands them new props
 * does too (F5 originally copied its props into `useState` and ignored them).
 */
const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const CODE = 'aBcDeFgH'
const RENDERED_AT = '2026-06-15T12:00:00.000Z'
const LATER = '2026-06-15T12:00:30.000Z'
const link = exampleLink({ code: CODE, paymentCount: 3, totalPaidKobo: 5_550_000 })
const rendered = [
  examplePayment({ reference: 'kbl_aaaaaaaaaa', payerName: 'Ngozi Okafor' }),
  examplePayment({ reference: 'kbl_bbbbbbbbbb', payerName: 'Tunde Bello' }),
]

function open(): void {
  act(() => {
    FakeEventSource.latest.open()
  })
}

function send(event: DashboardEvent): void {
  act(() => {
    FakeEventSource.latest.send(event)
  })
}

function paymentCompleted(overrides: Partial<Payment> = {}): DashboardEvent {
  return {
    type: 'payment.completed',
    payment: examplePayment({ reference: 'kbl_cccccccccc', code: CODE, payerName: 'Amaka Eze', ...overrides }),
    stats: exampleStats({ asOf: LATER }),
  }
}

beforeEach(() => {
  FakeEventSource.reset()
  router.refresh.mockReset()
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PaymentsSection, live', () => {
  function renderSection(props: { initialPayments?: Payment[]; initialCursor?: string | null } = {}) {
    const view = render(
      <DashboardStreamProvider>
        <PaymentsSection code={CODE} initialPayments={props.initialPayments ?? rendered} initialCursor={props.initialCursor ?? null} />
      </DashboardStreamProvider>,
    )
    open()
    return view
  }

  function payerOrder(): string[] {
    return screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getByText(/Ngozi Okafor|Tunde Bello|Amaka Eze|Chidi Obi/).textContent ?? '')
  }

  it('puts a payment that arrives on top of the table, without a reload', () => {
    renderSection()
    expect(payerOrder()).toEqual(['Ngozi Okafor', 'Tunde Bello'])

    send(paymentCompleted())
    expect(payerOrder()).toEqual(['Amaka Eze', 'Ngozi Okafor', 'Tunde Bello'])
  })

  it('shows a declined attempt too, saying that no money moved', () => {
    renderSection()
    send({
      type: 'payment.failed',
      payment: examplePayment({
        reference: 'kbl_dddddddddd',
        code: CODE,
        payerName: 'Chidi Obi',
        status: 'failed',
        completedAt: null,
        failureReason: 'The card was declined.',
      }),
    })

    const row = screen.getAllByRole('row').find((candidate) => within(candidate).queryByText('Chidi Obi'))
    expect(row).toHaveTextContent('Failed')
    expect(row).toHaveTextContent('The card was declined. No money moved.')
  })

  it('says what arrived to a screen reader, and says that a declined attempt moved no money', () => {
    renderSection()
    send(paymentCompleted())
    expect(screen.getByText('New payment: ₦18,500 from Amaka Eze.')).toBeInTheDocument()

    send({
      type: 'payment.failed',
      payment: examplePayment({ reference: 'kbl_dddddddddd', code: CODE, payerName: 'Chidi Obi', status: 'failed', completedAt: null }),
    })
    expect(screen.getByText('A payment from Chidi Obi failed. No money moved.')).toBeInTheDocument()
  })

  it('ignores payments for other links', () => {
    renderSection()
    send(paymentCompleted({ code: 'zZzZzZzZ' }))
    expect(payerOrder()).toEqual(['Ngozi Okafor', 'Tunde Bello'])
  })

  it('lists a payment once, whether the stream repeats it or the refreshed page already has it', () => {
    const { rerender } = renderSection()
    send(paymentCompleted())
    send(paymentCompleted())
    expect(payerOrder().filter((payer) => payer === 'Amaka Eze')).toHaveLength(1)

    // router.refresh() delivers a first page that now includes it.
    const refreshed = [examplePayment({ reference: 'kbl_cccccccccc', code: CODE, payerName: 'Amaka Eze' }), ...rendered]
    rerender(
      <DashboardStreamProvider>
        <PaymentsSection code={CODE} initialPayments={refreshed} initialCursor={null} />
      </DashboardStreamProvider>,
    )
    expect(payerOrder()).toEqual(['Amaka Eze', 'Ngozi Okafor', 'Tunde Bello'])
  })

  it('shows what a refreshed first page brings even with no stream event at all', () => {
    const { rerender } = renderSection()
    rerender(
      <DashboardStreamProvider>
        <PaymentsSection
          code={CODE}
          initialPayments={[examplePayment({ reference: 'kbl_eeeeeeeeee', payerName: 'Chidi Obi' }), ...rendered]}
          initialCursor={null}
        />
      </DashboardStreamProvider>,
    )
    expect(payerOrder()[0]).toBe('Chidi Obi')
  })

  it('a refresh does not throw away pages the merchant already loaded with "Show more"', async () => {
    const older = examplePayment({ reference: 'kbl_ffffffffff', payerName: 'Chidi Obi' })
    server.use(
      http.get(API.links.payments(':code'), () =>
        HttpResponse.json({ items: [older], nextCursor: null }),
      ),
    )
    const { rerender } = renderSection({ initialCursor: 'cursor-1' })

    await userEvent.click(screen.getByRole('button', { name: /show more payments/i }))
    await waitFor(() => expect(screen.getByText('Chidi Obi')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /show more payments/i })).not.toBeInTheDocument()

    // A refresh arrives with a new first page — and an unrelated cursor for it.
    rerender(
      <DashboardStreamProvider>
        <PaymentsSection
          code={CODE}
          initialPayments={[examplePayment({ reference: 'kbl_cccccccccc', payerName: 'Amaka Eze' }), ...rendered]}
          initialCursor="cursor-2"
        />
      </DashboardStreamProvider>,
    )
    expect(payerOrder()).toEqual(['Amaka Eze', 'Ngozi Okafor', 'Tunde Bello', 'Chidi Obi'])
    // The merchant had reached the end; a refresh does not offer a page they have already read.
    expect(screen.queryByRole('button', { name: /show more payments/i })).not.toBeInTheDocument()
  })
})

describe('PaymentsSection, live, with older pages loaded', () => {
  const LETTERS = 'abcdefghjkmnpqrstuvw'
  /** A payment per index, newest first by index; references are valid and distinct. */
  const payment = (index: number): Payment =>
    examplePayment({ reference: `kbl_aaaaaaaa${LETTERS[Math.floor(index / 20)]}${LETTERS[index % 20]}`, code: CODE, payerName: `Payer ${index}` })
  const range = (from: number, to: number): Payment[] => Array.from({ length: to - from + 1 }, (_unused, i) => payment(from + i))
  const rowCount = () => screen.getAllByRole('row').length - 1
  const shown = () => new Set(screen.getAllByText(/^Payer \d+$/).map((cell) => cell.textContent))

  it('loses no payment when a live one pushes the last item of the first page off it', async () => {
    // Keyset pages: the API returned 1..20 with a cursor after 20, then 21..40 for that cursor.
    server.use(http.get(API.links.payments(':code'), () => HttpResponse.json({ items: range(21, 40), nextCursor: null })))
    const first = range(1, 20)
    const tree = (initialPayments: Payment[], initialCursor: string) => (
      <DashboardStreamProvider>
        <PaymentsSection code={CODE} initialPayments={initialPayments} initialCursor={initialCursor} />
      </DashboardStreamProvider>
    )
    const { rerender } = render(tree(first, 'c-after-20'))
    open()

    await userEvent.click(screen.getByRole('button', { name: /show more payments/i }))
    await waitFor(() => expect(rowCount()).toBe(40))

    // A payment lands; router.refresh() delivers a first page of [new, 1..19] with a cursor after 19.
    rerender(tree([payment(99), ...first.slice(0, 19)], 'c-after-19'))

    expect(rowCount()).toBe(41)
    expect(shown().has('Payer 20')).toBe(true)
    // Newest first, no gap, no duplicate.
    expect(screen.getAllByText(/^Payer \d+$/).map((cell) => cell.textContent)).toEqual(
      ['Payer 99', ...range(1, 40).map((p) => p.payerName)],
    )
  })

  it('keeps the "Showing N" note true after a refresh adds a row', async () => {
    server.use(http.get(API.links.payments(':code'), () => HttpResponse.json({ items: range(21, 40), nextCursor: null })))
    const first = range(1, 20)
    const tree = (initialPayments: Payment[], initialCursor: string) => (
      <DashboardStreamProvider>
        <PaymentsSection code={CODE} initialPayments={initialPayments} initialCursor={initialCursor} />
      </DashboardStreamProvider>
    )
    const { rerender } = render(tree(first, 'c-after-20'))
    open()
    await userEvent.click(screen.getByRole('button', { name: /show more payments/i }))
    await screen.findByText('20 more payments loaded. Showing 40.')

    rerender(tree([payment(99), ...first.slice(0, 19)], 'c-after-19'))
    expect(screen.getByText('20 more payments loaded. Showing 41.')).toBeInTheDocument()
  })
})

describe('LinkFigures, live', () => {
  function renderFigures(asOf = RENDERED_AT) {
    render(
      <DashboardStreamProvider>
        <LinkFigures link={link} asOf={asOf} />
      </DashboardStreamProvider>,
    )
    open()
  }

  function figure(label: string): string {
    return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? ''
  }

  it('shows the API\'s new counters when the link is updated, formatted by the contract', () => {
    renderFigures()
    expect(figure('Collected')).toBe('₦55,500')

    const updated: PaymentLink = { ...link, paymentCount: 4, totalPaidKobo: 7_400_000 }
    send({ type: 'link.updated', link: updated, stats: exampleStats({ asOf: LATER }) })

    expect(figure('Collected')).toBe('₦74,000')
    expect(figure('Successful payments')).toBe('4')
  })

  it('does not add a payment event\'s amount onto the counters — the refresh it schedules brings the API\'s own', () => {
    renderFigures()
    send(paymentCompleted())
    expect(figure('Collected')).toBe('₦55,500')
    expect(figure('Successful payments')).toBe('3')
  })

  it('ignores a link event the render already includes', () => {
    renderFigures(LATER)
    send({ type: 'link.updated', link: { ...link, paymentCount: 9 }, stats: exampleStats({ asOf: RENDERED_AT }) })
    expect(figure('Successful payments')).toBe('3')
  })

  it('ignores another link\'s events', () => {
    renderFigures()
    send({ type: 'link.updated', link: exampleLink({ code: 'zZzZzZzZ', paymentCount: 9 }), stats: exampleStats({ asOf: LATER }) })
    expect(figure('Successful payments')).toBe('3')
  })
})

describe('LinkStatusControl, live', () => {
  function renderControl(source: PaymentLink = link, asOf = RENDERED_AT) {
    const props = { code: source.code, status: source.status, isReusable: source.isReusable, expiresAt: source.expiresAt, paymentCount: source.paymentCount }
    const tree = (next: typeof props) => (
      <DashboardStreamProvider>
        <LinkStatusControl link={next} asOf={asOf} />
      </DashboardStreamProvider>
    )
    const view = render(tree(props))
    open()
    return { ...view, props, tree }
  }

  it('flips the switch and the badge when the link is turned off from another tab', () => {
    renderControl()
    const toggle = screen.getByRole('switch', { name: /accepting payments/i })
    expect(toggle).toBeChecked()

    send({ type: 'link.updated', link: { ...link, status: 'disabled' }, stats: exampleStats({ asOf: LATER }) })

    expect(toggle).not.toBeChecked()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('shows a single-use link as Paid once the API says it has a payment', () => {
    renderControl(exampleLink({ code: CODE, isReusable: false, paymentCount: 0 }))
    expect(screen.getByText('Active')).toBeInTheDocument()

    send({
      type: 'link.updated',
      link: exampleLink({ code: CODE, isReusable: false, paymentCount: 1 }),
      stats: exampleStats({ asOf: LATER }),
    })
    expect(screen.getByText('Paid')).toBeInTheDocument()
  })

  it('takes a refreshed link from its props — the old copy-into-useState ignored them', () => {
    const { rerender, props, tree } = renderControl()
    expect(screen.getByRole('switch')).toBeChecked()

    rerender(tree({ ...props, status: 'disabled' }))
    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('does not let an arriving update overwrite a toggle that is still in flight', async () => {
    let release: () => void = () => undefined
    server.use(
      http.patch(API.links.status(':code'), async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return HttpResponse.json({ ...link, status: 'disabled' })
      }),
    )
    renderControl()
    const toggle = screen.getByRole('switch', { name: /accepting payments/i })

    await userEvent.click(toggle)
    expect(toggle).not.toBeChecked() // optimistic

    // Meanwhile a stale-looking "active" update arrives from the stream.
    send({ type: 'link.updated', link: { ...link, status: 'active', paymentCount: 3 }, stats: exampleStats({ asOf: LATER }) })
    expect(toggle).not.toBeChecked()

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('Link turned off.')).toBeInTheDocument())
    expect(toggle).not.toBeChecked()
  })
})
