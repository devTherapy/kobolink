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
})

describe('PaymentsSection, live, pages loaded with "Show more"', () => {
  const LETTERS = 'abcdefghjkmnpqrstuvw'
  /** A payment per index, newest first by index; references are valid and distinct. */
  const payment = (index: number): Payment =>
    examplePayment({ reference: `kbl_aaaaaaaa${LETTERS[Math.floor(index / 20)]}${LETTERS[index % 20]}`, code: CODE, payerName: `Payer ${index}` })
  const range = (from: number, to: number): Payment[] => Array.from({ length: to - from + 1 }, (_unused, i) => payment(from + i))
  const payers = () => screen.queryAllByText(/^Payer \d+$/).map((cell) => cell.textContent)
  const names = (...parts: (number | [number, number])[]) =>
    parts.flatMap((part) => (typeof part === 'number' ? [`Payer ${part}`] : range(part[0], part[1]).map((p) => p.payerName)))
  const showMore = () => screen.queryByRole('button', { name: /show more payments/i })

  const first = range(1, 20)
  const refreshedFirst = [payment(99), ...first.slice(0, 19)]
  const tree = (initialPayments: Payment[], initialCursor: string) => (
    <DashboardStreamProvider>
      <PaymentsSection code={CODE} initialPayments={initialPayments} initialCursor={initialCursor} />
    </DashboardStreamProvider>
  )

  /** Keyset pages as the API serves them: each cursor names the item it continues after. */
  function serveKeysetPages(onRequest?: () => Promise<void>) {
    server.use(
      http.get(API.links.payments(':code'), async ({ request }) => {
        await onRequest?.()
        const cursor = new URL(request.url).searchParams.get('cursor')
        if (cursor === 'c-after-20') return HttpResponse.json({ items: range(21, 40), nextCursor: 'c-after-40' })
        if (cursor === 'c-after-19') return HttpResponse.json({ items: range(20, 39), nextCursor: 'c-after-39' })
        return HttpResponse.json({ items: [], nextCursor: null })
      }),
    )
  }

  it('a refreshed first page starts the older pages over from its own cursor, so no payment falls in a gap', async () => {
    serveKeysetPages()
    const { rerender } = render(tree(first, 'c-after-20'))
    open()
    await userEvent.click(showMore()!)
    await waitFor(() => expect(payers()).toEqual(names([1, 40])))

    // A payment lands; the refresh delivers [new, 1..19] with a cursor after 19.
    rerender(tree(refreshedFirst, 'c-after-19'))
    expect(payers()).toEqual(names(99, [1, 19]))

    // The merchant presses Show more again: the page continues from item 19, so 20 is there.
    await userEvent.click(showMore()!)
    await waitFor(() => expect(payers()).toEqual(names(99, [1, 39])))
  })

  describe('when a refresh collapses the table back to the first page', () => {
    /** The visitor pressed Show more and reached the end: the button is gone, focus sits on the note. */
    async function reachTheEnd() {
      server.use(
        http.get(API.links.payments(':code'), () => HttpResponse.json({ items: range(21, 40), nextCursor: null })),
      )
      const view = render(tree(first, 'c-after-20'))
      open()
      await userEvent.click(showMore()!)
      await waitFor(() => expect(payers()).toEqual(names([1, 40])))
      const note = screen.getByRole('status', { name: '' })
      expect(note).toHaveTextContent('20 more payments loaded. Showing 40.')
      expect(note).toHaveFocus()
      return { ...view, note }
    }

    it('announces the collapse in the same status region, politely', async () => {
      const { rerender, note } = await reachTheEnd()
      rerender(tree(refreshedFirst, 'c-after-19'))

      expect(payers()).toEqual(names(99, [1, 19]))
      expect(note).toHaveTextContent('Showing the first page of payments.')
      expect(note).toHaveAttribute('role', 'status')
    })

    it('keeps focus where it was: the note stays visible, so the browser has nothing to drop', async () => {
      const { rerender, note } = await reachTheEnd()
      rerender(tree(refreshedFirst, 'c-after-19'))

      expect(note).toBeVisible()
      // An empty note is `empty:hidden`; a focused element that becomes display:none loses focus to <body>.
      expect(note).not.toBeEmptyDOMElement()
      expect(note).toHaveFocus()
    })

    it('does not take focus from a visitor who had moved on', async () => {
      const { rerender, note } = await reachTheEnd()
      const elsewhere = document.createElement('button')
      document.body.append(elsewhere)
      elsewhere.focus()

      rerender(tree(refreshedFirst, 'c-after-19'))
      expect(note).toHaveTextContent('Showing the first page of payments.')
      expect(elsewhere).toHaveFocus()
      elsewhere.remove()
    })

    it('says nothing when nothing had been loaded beyond the first page', () => {
      const { rerender } = render(tree(first, 'c-after-20'))
      open()
      rerender(tree(refreshedFirst, 'c-after-19'))
      expect(screen.queryByText(/showing the first page/i)).toBeNull()
    })

    it('a later "Show more" replaces the collapse note with the usual count', async () => {
      serveKeysetPages()
      const { rerender } = await reachTheEnd()
      rerender(tree(refreshedFirst, 'c-after-19'))
      await userEvent.click(showMore()!)
      await screen.findByText('20 more payments loaded. Showing 40.')
      expect(screen.queryByText(/showing the first page/i)).toBeNull()
    })
  })

  it('a request already in flight when the first page changes is discarded, not appended after a gap', async () => {
    let release: () => void = () => undefined
    serveKeysetPages(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const { rerender } = render(tree(first, 'c-after-20'))
    open()
    await userEvent.click(showMore()!)

    rerender(tree(refreshedFirst, 'c-after-19'))
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    // 21..40 was fetched against the old first page: showing it would leave 20 missing.
    expect(payers()).toEqual(names(99, [1, 19]))
    expect(showMore()).toBeEnabled()
  })

  it('a refresh that changes nothing visible does not collapse what was loaded', async () => {
    serveKeysetPages()
    const { rerender } = render(tree(first, 'c-after-20'))
    open()
    await userEvent.click(showMore()!)
    await waitFor(() => expect(payers()).toEqual(names([1, 40])))

    // Same first page, new array identity — as when a reconnect refresh finds nothing new.
    rerender(tree([...first], 'c-after-20'))
    expect(payers()).toEqual(names([1, 40]))
  })

  it('keeps the "Showing N" note true as live payments change the list', async () => {
    serveKeysetPages()
    render(tree(first, 'c-after-20'))
    open()
    await userEvent.click(showMore()!)
    await screen.findByText('20 more payments loaded. Showing 40.')

    send(paymentCompleted())
    expect(screen.getByText('20 more payments loaded. Showing 41.')).toBeInTheDocument()
  })

  it('counts "N more loaded" against the list as it was when the response arrived', async () => {
    let release: () => void = () => undefined
    server.use(
      http.get(API.links.payments(':code'), async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return HttpResponse.json({ items: range(21, 40), nextCursor: null })
      }),
    )
    render(tree(first, 'c-after-20'))
    open()
    await userEvent.click(showMore()!)

    // While the request is out, the stream already delivers one of the payments the page contains.
    send({ type: 'payment.completed', payment: payment(21), stats: exampleStats({ asOf: LATER }) })
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(await screen.findByText('19 more payments loaded. Showing 40.')).toBeInTheDocument()
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

  it('flips the switch and the badge when a link.updated event says the link is off', () => {
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
