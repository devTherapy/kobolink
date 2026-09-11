import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API, exampleLink, toPublicLink } from '@kobolink/contracts'
import { server } from '@/mocks/server'
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
    expect(screen.getByText(/money moved/i)).toBeInTheDocument()
    expect(screen.getByText(/^Reference kbl_/)).toBeInTheDocument()
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
