import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API, exampleLink, newPaymentReference, toPublicLink } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { checkoutSessions } from '@/mocks/state'
import { PayForm } from './PayForm'

// The seeded fixture link: fixed amount, ₦18,500, "Adebayo Stores".
const link = toPublicLink(exampleLink())

async function fillPayerFields(user: ReturnType<typeof userEvent.setup>, email = 'ngozi@example.com') {
  await user.type(screen.getByLabelText('Your name'), 'Ngozi Okafor')
  await user.type(screen.getByLabelText('Email'), email)
}

describe('PayForm — happy path', () => {
  it('shows the reference, amount and merchant, and says money moved', async () => {
    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
    expect(screen.getByText('₦18,500')).toBeInTheDocument()
    expect(screen.getByText('to Adebayo Stores')).toBeInTheDocument()
    // The exact positive copy — `/money moved/i` alone would also match
    // "No money moved.", which is exactly the wrong thing for this test to
    // pass against.
    expect(screen.getByText('Money moved. Your payment was successful.')).toBeInTheDocument()
    expect(screen.getByText(/^Reference kbl_/)).toBeInTheDocument()
  })

  it('marks the fields aria-busy while the submit is in flight', async () => {
    // A deliberately slow `initialize` so the "submitting" phase — the only
    // phase that still renders the fields at all; "verifying" swaps the
    // whole form out for `VerifyingSkeleton` — is observable instead of
    // racing straight past it.
    const reference = newPaymentReference()
    server.use(
      http.post(API.checkout.initialize, async () => {
        await delay(30)
        checkoutSessions.set(reference, {
          code: link.code,
          amountKobo: link.amountKobo ?? 0,
          payerName: 'Ngozi Okafor',
          payerEmail: 'ngozi@example.com',
        })
        return HttpResponse.json(
          {
            reference,
            code: link.code,
            amountKobo: link.amountKobo,
            currency: 'NGN',
            status: 'pending',
            createdAt: new Date().toISOString(),
          },
          { status: 201 },
        )
      }),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-busy', 'true')

    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
  })
})

describe('PayForm — simulated decline', () => {
  it('a `fail@` email shows the failure reason, "no money moved", and a retry', async () => {
    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user, 'fail@example.com')
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeInTheDocument()
    expect(screen.getByText('Card declined by the simulated gateway.')).toBeInTheDocument()
    expect(screen.getByText('No money moved.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /pay ₦18,500/i })).toBeInTheDocument()
  })
})

describe('PayForm — amount_mismatch', () => {
  it('shows the error inline, tied to the amount field with aria-describedby', async () => {
    server.use(
      http.post(API.checkout.initialize, () =>
        HttpResponse.json(
          { code: 'amount_mismatch', message: 'That amount does not match this link.', moneyMoved: false },
          { status: 422 },
        ),
      ),
    )

    const openLink = { ...link, amountKobo: null }
    const user = userEvent.setup()
    render(<PayForm link={openLink} />)

    await user.type(screen.getByLabelText('Amount'), '18500')
    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: 'Pay' }))

    const error = await screen.findByText('That amount does not match this link.')
    const amountInput = screen.getByLabelText('Amount')
    expect(amountInput.getAttribute('aria-describedby')).toBe(error.id)
    expect(amountInput).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('PayForm — a single-use link paid by someone else between load and pay', () => {
  it('renders the already-paid screen instead of a form error', async () => {
    server.use(
      http.post(API.checkout.initialize, () =>
        HttpResponse.json(
          {
            code: 'link_not_payable',
            message: 'This link cannot be paid right now.',
            moneyMoved: false,
            state: 'already-paid',
          },
          { status: 409 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: /already been paid/i })).toBeInTheDocument()
    expect(screen.getByText(/no money has moved/i)).toBeInTheDocument()
  })

  it('renders neutral copy for link_not_payable without a state, never a fabricated reason', async () => {
    server.use(
      http.post(API.checkout.initialize, () =>
        HttpResponse.json(
          { code: 'link_not_payable', message: 'This link cannot be paid right now.', moneyMoved: false },
          { status: 409 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: 'This link cannot be paid right now' })).toBeInTheDocument()
    // Never the "disabled" copy — nothing told this client the merchant
    // actually switched the link off.
    expect(screen.queryByText(/turned off/i)).not.toBeInTheDocument()
    expect(screen.getByText(/no money has moved/i)).toBeInTheDocument()
  })
})

describe('PayForm — amount_mismatch on a fixed-amount link', () => {
  it('re-fetches the link, tells the payer the price changed, and offers a reload', async () => {
    server.use(
      http.post(API.checkout.initialize, () =>
        HttpResponse.json(
          { code: 'amount_mismatch', message: 'That amount does not match this link.', moneyMoved: false },
          { status: 422 },
        ),
      ),
      http.get(API.links.resolve(':code'), () =>
        HttpResponse.json({ state: 'payable', link: { ...link, amountKobo: 2_500_000 } }),
      ),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: 'The price has changed' })).toBeInTheDocument()
    expect(screen.getByText(/now costs ₦25,000/)).toBeInTheDocument()
    expect(screen.getByText(/no money moved/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('still offers a reload even when the re-fetch itself fails', async () => {
    server.use(
      http.post(API.checkout.initialize, () =>
        HttpResponse.json(
          { code: 'amount_mismatch', message: 'That amount does not match this link.', moneyMoved: false },
          { status: 422 },
        ),
      ),
      http.get(API.links.resolve(':code'), () => HttpResponse.error()),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: 'The price has changed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })
})

describe('PayForm — non-transport verify errors', () => {
  it('a 500 with moneyMoved true lands on the check-status screen, never a re-armed Pay button', async () => {
    server.use(
      http.post(API.checkout.verify, () =>
        HttpResponse.json({ code: 'internal', message: 'Something went wrong.', moneyMoved: true }, { status: 500 }),
      ),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: /couldn.t confirm this payment/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check status' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pay ₦18,500/i })).not.toBeInTheDocument()
  })

  it('a rate_limited response with no moneyMoved also lands on the check-status screen', async () => {
    server.use(
      http.post(API.checkout.verify, () =>
        HttpResponse.json({ code: 'rate_limited', message: 'Slow down.' }, { status: 429 }),
      ),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: /couldn.t confirm this payment/i })).toBeInTheDocument()
    expect(screen.getByText(/may or may not have moved/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check status' })).toBeInTheDocument()
  })

  it('link_not_payable at verify time renders the matching non-payable screen', async () => {
    server.use(
      http.post(API.checkout.verify, () =>
        HttpResponse.json(
          {
            code: 'link_not_payable',
            message: 'This link cannot be paid right now.',
            moneyMoved: false,
            state: 'expired',
          },
          { status: 409 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: /expired/i })).toBeInTheDocument()
    expect(screen.getByText(/no money has moved/i)).toBeInTheDocument()
  })

  it('moneyMoved: false at verify time shows the failure and allows a fresh attempt', async () => {
    server.use(
      http.post(API.checkout.verify, () =>
        HttpResponse.json(
          { code: 'internal', message: 'Could not confirm that payment.', moneyMoved: false },
          { status: 500 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeInTheDocument()
    expect(screen.getByText('Could not confirm that payment.')).toBeInTheDocument()
    expect(screen.getByText('No money moved.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /pay ₦18,500/i })).toBeInTheDocument()
  })
})

describe('PayForm — transport errors', () => {
  it('a dropped verify offers "Check status", which re-verifies the same reference and recovers', async () => {
    server.use(http.post(API.checkout.verify, () => HttpResponse.error(), { once: true }))

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: /couldn.t confirm this payment/i })).toBeInTheDocument()
    expect(screen.getByText(/may or may not have moved/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Check status' }))

    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
  })

  it('a dropped initialize offers "Try again" and states nothing was charged; resubmitting recovers', async () => {
    server.use(http.post(API.checkout.initialize, () => HttpResponse.error(), { once: true }))

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await fillPayerFields(user)
    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByRole('heading', { name: /couldn.t confirm this payment/i })).toBeInTheDocument()
    expect(screen.getByText(/nothing was charged/i)).toBeInTheDocument()

    // "Try again" (no reference exists yet — initialize itself never
    // landed) returns to the editable form rather than blindly
    // resubmitting, unlike "Check status" above. The mocked network error
    // was `{ once: true }`, so this second submit reaches the real handler.
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /pay ₦18,500/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
  })
})

describe('PayForm — client-side validation', () => {
  it('rejects an empty name and email without ever calling the API', async () => {
    server.use(
      http.post(API.checkout.initialize, () => {
        throw new Error('initialize should not be called when client-side validation fails')
      }),
    )

    const user = userEvent.setup()
    render(<PayForm link={link} />)

    await user.click(screen.getByRole('button', { name: /pay ₦18,500/i }))

    expect(await screen.findByText('Enter your name.')).toBeInTheDocument()
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
  })
})
