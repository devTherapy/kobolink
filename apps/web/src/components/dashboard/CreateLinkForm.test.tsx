import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API, type ApiError, type PaymentLink } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { linkStore } from '@/mocks/state'
import { todayLocalDate } from '@/lib/create-link-form'
import { CreateLinkForm } from './CreateLinkForm'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}))

/** The mock API guards `POST /api/links` on the session cookie, exactly as `LinksController` does. */
async function signIn() {
  await fetch(`http://localhost:3000${API.auth.login}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ngozi@example.com', password: 'a-real-password', client: 'web' }),
  })
}

beforeEach(async () => {
  await signIn()
})

function setup() {
  const onCreated = vi.fn<(link: PaymentLink) => void>()
  const onCancel = vi.fn()
  const onPendingChange = vi.fn<(pending: boolean) => void>()
  const onTransportFailure = vi.fn()
  const user = userEvent.setup()
  render(
    <CreateLinkForm
      onCreated={onCreated}
      onCancel={onCancel}
      onPendingChange={onPendingChange}
      onTransportFailure={onTransportFailure}
    />,
  )
  return { user, onCreated, onCancel, onPendingChange, onTransportFailure }
}

const titleInput = () => screen.getByLabelText('Title', { exact: false })
const amountInput = () => screen.getByLabelText('Amount')
const submit = () => screen.getByRole('button', { name: 'Create link' })

function errorBody(code: ApiError['code'], message: string, extra: Partial<ApiError> = {}): ApiError {
  return { code, message, ...extra }
}

/**
 * A handler that returns nothing hands the request on to the next matching
 * handler in MSW 2 — here, the default mock, which really creates the link.
 * That is what lets a test script "fail N times, then behave normally".
 */
const fallThrough = (): never => undefined as never

const COLLISION = errorBody('conflict', 'Could not allocate a unique link code. Try again.')

describe('CreateLinkForm — Done when: validation errors are inline', () => {
  it('shows an empty-title error beside the title, wired for assistive tech, and sends nothing', async () => {
    const { user, onCreated } = setup()
    let requests = 0
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith(API.links.collection)) requests++
    })

    await user.click(submit())

    const input = titleInput()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const message = screen.getByText('Title is required.')
    expect(message.id).toBe(input.getAttribute('aria-describedby'))
    expect(requests).toBe(0)
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('moves focus to the first invalid field', async () => {
    const { user } = setup()
    await user.click(submit())
    expect(titleInput()).toHaveFocus()
  })

  it('shows every problem at once, each beside its own field', async () => {
    const { user } = setup()
    await user.type(amountInput(), 'abc')
    await user.click(submit())

    expect(screen.getByText('Title is required.')).toBeInTheDocument()
    expect(screen.getByText(/enter an amount like 18,500/i)).toBeInTheDocument()
    expect(amountInput()).toHaveAttribute('aria-invalid', 'true')
  })

  it('rejects an out-of-range amount, naming the bounds', async () => {
    const { user } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.type(amountInput(), '50')
    await user.click(submit())

    expect(screen.getByText('Enter an amount between ₦100 and ₦10,000,000.')).toBeInTheDocument()
    expect(amountInput()).toHaveFocus()
  })

  it('offers the picker no day before today (local)', () => {
    setup()
    expect(screen.getByLabelText('Expires on')).toHaveAttribute('min', todayLocalDate())
  })

  it('rejects a past expiry date', async () => {
    const { user } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.type(screen.getByLabelText('Expires on'), '2020-01-01')
    await user.click(submit())

    expect(screen.getByText('Pick today or a later date.')).toBeInTheDocument()
  })

  it('puts a server-side validation_failed message beside the field it names (amountKobo -> amount)', async () => {
    server.use(
      http.post(API.links.collection, () =>
        HttpResponse.json(errorBody('validation_failed', 'bad', { fields: { amountKobo: ['The server does not like it.'] } }), {
          status: 400,
        }),
      ),
    )
    const { user, onCreated } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    expect(await screen.findByText('The server does not like it.')).toBeInTheDocument()
    expect(amountInput()).toHaveAttribute('aria-invalid', 'true')
    expect(amountInput()).toHaveFocus()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('retires a field’s error the moment it is edited, leaving the others', async () => {
    const { user } = setup()
    await user.type(amountInput(), 'abc')
    await user.click(submit())
    expect(screen.getByText('Title is required.')).toBeInTheDocument()
    expect(screen.getByText(/enter an amount like/i)).toBeInTheDocument()

    await user.type(titleInput(), 'A')

    expect(screen.queryByText('Title is required.')).not.toBeInTheDocument()
    expect(titleInput()).not.toHaveAttribute('aria-invalid')
    expect(screen.getByText(/enter an amount like/i)).toBeInTheDocument()
  })

  it('clears a stale field error once the merchant fixes it and resubmits', async () => {
    const { user, onCreated } = setup()
    await user.click(submit())
    expect(screen.getByText('Title is required.')).toBeInTheDocument()

    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled()
    })
    expect(screen.queryByText('Title is required.')).not.toBeInTheDocument()
  })
})

describe('CreateLinkForm — kobo on the wire', () => {
  it('posts integer kobo parsed from the naira text, and the new link is in the store', async () => {
    let body: unknown
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith(API.links.collection)) {
        body = await request.clone().json()
      }
    })
    const { user, onCreated } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.type(amountInput(), '18,500.50')
    await user.click(screen.getByRole('checkbox', { name: 'Reusable' }))
    await user.click(submit())

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1)
    })
    expect(body).toEqual({
      title: 'Ankara set',
      amountKobo: 1_850_050,
      isReusable: true,
      expiresAt: null,
    })
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({ title: 'Ankara set', amountKobo: 1_850_050 })
    expect(Array.from(linkStore.values()).some((link) => link.title === 'Ankara set')).toBe(true)
  })

  it('sends amountKobo: null when the amount is left blank ("payer chooses")', async () => {
    const { user, onCreated } = setup()
    await user.type(titleInput(), 'Open donation')
    await user.click(submit())

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled()
    })
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({ amountKobo: null })
  })
})

describe('CreateLinkForm — Done when: a duplicate code retries invisibly', () => {
  it('resubmits after a conflict and succeeds, with no error ever shown to the merchant', async () => {
    let attempts = 0
    server.use(
      http.post(API.links.collection, () => {
        attempts++
        if (attempts === 1) return HttpResponse.json(COLLISION, { status: 409 })
        return fallThrough()
      }),
    )
    const { user, onCreated } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1)
    })
    expect(attempts).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/unique link code/i)).not.toBeInTheDocument()
  })

  it('keeps the button loading across the retries instead of flashing an error between them', async () => {
    const seen: (string | null)[] = []
    let attempts = 0
    server.use(
      http.post(API.links.collection, () => {
        attempts++
        seen.push(submit().getAttribute('aria-busy'))
        return attempts < 3 ? HttpResponse.json(COLLISION, { status: 409 }) : fallThrough()
      }),
    )
    const { user, onCreated } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1)
    })
    expect(seen).toEqual(['true', 'true', 'true'])
  })

  it('says plainly that nothing was created once the retries are spent', async () => {
    let attempts = 0
    server.use(
      http.post(API.links.collection, () => {
        attempts++
        return HttpResponse.json(COLLISION, { status: 409 })
      }),
    )
    const { user, onCreated, onPendingChange } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not generate a unique link code. No link was created. Try again.',
    )
    expect(attempts).toBe(3)
    expect(onCreated).not.toHaveBeenCalled()
    expect(onPendingChange).toHaveBeenLastCalledWith(false)
    // The merchant's input survives, so "try again" is one click.
    expect(titleInput()).toHaveValue('Ankara set')
    expect(submit()).toHaveAttribute('data-error')
  })
})

describe('CreateLinkForm — other failures name what happened and what to do', () => {
  it('an expired session: says nothing was created and offers sign-in', async () => {
    server.use(
      http.post(API.links.collection, () =>
        HttpResponse.json(errorBody('unauthenticated', 'Your session has expired.'), { status: 401 }),
      ),
    )
    const { user } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your session has expired, so no link was created.')
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/login?next=%2Fdashboard')
  })

  it('rate limiting: shows the Retry-After window', async () => {
    server.use(
      http.post(API.links.collection, () =>
        HttpResponse.json(errorBody('rate_limited', 'Slow down.'), { status: 429, headers: { 'retry-after': '12' } }),
      ),
    )
    const { user } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 12 seconds.')
  })

  it('a dead connection: does NOT claim nothing was created, because it cannot know', async () => {
    server.use(http.post(API.links.collection, () => HttpResponse.error()))
    const { user } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not reach kobolink/i)
    expect(alert).toHaveTextContent(/if the link appears in your list, it was created/i)
    expect(alert).not.toHaveTextContent('No link was created')
  })

  it.each([
    ['a dropped connection', () => HttpResponse.error()],
    ['a 502 with a proxy HTML body', () => new HttpResponse('<h1>Bad Gateway</h1>', { status: 502 })],
  ])('tells the owner the list may be stale after %s', async (_name, respond) => {
    server.use(http.post(API.links.collection, () => respond()))
    const { user, onTransportFailure } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    await screen.findByRole('alert')
    expect(onTransportFailure).toHaveBeenCalledTimes(1)
  })

  it('does not tell the owner anything is stale when the API said nothing was created', async () => {
    server.use(
      http.post(API.links.collection, () => HttpResponse.json(errorBody('internal', 'Something broke.'), { status: 500 })),
    )
    const { user, onTransportFailure } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    await screen.findByRole('alert')
    expect(onTransportFailure).not.toHaveBeenCalled()
  })

  it('moves focus to the alert so a keyboard user lands where the news is', async () => {
    server.use(http.post(API.links.collection, () => HttpResponse.json(COLLISION, { status: 409 })))
    const { user } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert).toHaveFocus()
    })
  })
})

describe('CreateLinkForm — loading, cancel', () => {
  it('disables the fields and Cancel and tells the owner a request is in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post(API.links.collection, async () => {
        await gate
        return fallThrough()
      }),
    )
    const { user, onPendingChange } = setup()
    await user.type(titleInput(), 'Ankara set')
    await user.click(submit())

    expect(onPendingChange).toHaveBeenCalledWith(true)
    expect(titleInput()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(submit()).toHaveAttribute('aria-busy', 'true')
    // The button keeps focus (it is aria-disabled, not disabled).
    expect(submit()).toHaveFocus()

    release()
    await waitFor(() => {
      expect(submit()).toBeInTheDocument()
    })
  })

  it('Cancel calls onCancel', async () => {
    const { user, onCancel } = setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
