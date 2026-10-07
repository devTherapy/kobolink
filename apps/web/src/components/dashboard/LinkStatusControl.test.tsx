import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { API, exampleLink } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { linkStore } from '@/mocks/state'
import { LinkStatusControl } from './LinkStatusControl'

/** A PATCH handler that holds its response until the test says so, so a test can look at the in-flight state. */
function gatedStatusHandler(respond: () => Response | Promise<Response>) {
  let release: () => void = vi.fn()
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: unknown[] = []
  server.use(
    http.patch(API.links.status(':code'), async ({ request }) => {
      calls.push(await request.json())
      await gate
      return respond()
    }),
  )
  return { release, calls }
}

const failWith500 = () =>
  HttpResponse.json({ code: 'internal', message: 'Something went wrong on our side.' }, { status: 500 })

describe('LinkStatusControl — Done when: the toggle rolls back visibly when the request fails', () => {
  it('flips the switch and the badge immediately, then snaps both back and names the failure', async () => {
    const user = userEvent.setup()
    const { release, calls } = gatedStatusHandler(failWith500)
    render(<LinkStatusControl link={exampleLink()} />)

    const toggle = screen.getByRole('switch', { name: 'Accepting payments' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Active')).toBeInTheDocument()

    await user.click(toggle)

    // Optimistic: the request is still in flight, and the UI is already on the new answer.
    await waitFor(() => expect(calls).toEqual([{ status: 'disabled' }]))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-busy', 'true')

    release()

    // Rolled back — visibly: the switch and badge are what the server last said, and the page says why.
    const alert = await screen.findByRole('alert')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).not.toHaveAttribute('aria-busy')
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument()

    // It names what went wrong, what state the link is really in, and that no payments were touched.
    expect(alert).toHaveTextContent('Change not saved.')
    expect(alert).toHaveTextContent(/couldn't turn off this link/i)
    expect(alert).toHaveTextContent(/still accepting payments/i)
    expect(alert).toHaveTextContent(/no payments were affected/i)

    // And the switch carries that message for a screen reader, in its error state.
    expect(toggle).toHaveAttribute('data-error', 'true')
    expect(toggle).toHaveAccessibleDescription(alert.textContent ?? '')
    // The server really was not changed.
    expect(linkStore.get('aBcDeFgH')?.status).toBe('active')
  })

  it('rolls back and says so when the network drops, not only on an API error', async () => {
    const user = userEvent.setup()
    server.use(http.patch(API.links.status(':code'), () => HttpResponse.error()))
    render(<LinkStatusControl link={exampleLink()} />)

    await user.click(screen.getByRole('switch'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't turn off this link/i)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('rolls a failed re-enable back to off, and says the link is still turned off', async () => {
    const user = userEvent.setup()
    server.use(http.patch(API.links.status(':code'), failWith500))
    render(<LinkStatusControl link={exampleLink({ status: 'disabled' })} />)

    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/couldn't turn on this link/i)
    expect(alert).toHaveTextContent(/still turned off/i)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('uses the API\'s own reason for an expired session instead of a generic "servers" line', async () => {
    const user = userEvent.setup()
    server.use(
      http.patch(API.links.status(':code'), () =>
        HttpResponse.json({ code: 'unauthenticated', message: 'Sign in.' }, { status: 401 }),
      ),
    )
    render(<LinkStatusControl link={exampleLink()} />)

    await user.click(screen.getByRole('switch'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/session has expired/i)
  })

  it('an expired link whose switch change failed is described as still expired, not "still accepting payments"', async () => {
    const user = userEvent.setup()
    server.use(http.patch(API.links.status(':code'), failWith500))
    render(<LinkStatusControl link={exampleLink({ expiresAt: '2000-01-01T00:00:00.000Z' })} />)

    await user.click(screen.getByRole('switch'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/still expired/i)
    expect(alert).not.toHaveTextContent(/still accepting payments/i)
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  it('a spent single-use link whose switch change failed is described as still paid', async () => {
    const user = userEvent.setup()
    server.use(http.patch(API.links.status(':code'), failWith500))
    render(<LinkStatusControl link={exampleLink({ isReusable: false, paymentCount: 1 })} />)

    await user.click(screen.getByRole('switch'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/still paid/i)
    expect(alert).not.toHaveTextContent(/still accepting payments/i)
  })

  it('an expired session offers a way to sign in again, back to this very link', async () => {
    const user = userEvent.setup()
    server.use(
      http.patch(API.links.status(':code'), () =>
        HttpResponse.json({ code: 'unauthenticated', message: 'Sign in.' }, { status: 401 }),
      ),
    )
    render(<LinkStatusControl link={exampleLink()} />)

    await user.click(screen.getByRole('switch'))

    const alert = await screen.findByRole('alert')
    const signIn = within(alert).getByRole('link', { name: /sign in again/i })
    expect(signIn).toHaveAttribute('href', '/login?next=%2Fdashboard%2Flinks%2FaBcDeFgH')
  })

  it('offers no sign-in link for a failure that signing in would not fix', async () => {
    const user = userEvent.setup()
    server.use(http.patch(API.links.status(':code'), failWith500))
    render(<LinkStatusControl link={exampleLink()} />)

    await user.click(screen.getByRole('switch'))

    await screen.findByRole('alert')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('clears the error as soon as the merchant tries again, and a retry that works confirms and announces', async () => {
    const user = userEvent.setup()
    let attempt = 0
    server.use(
      http.patch(API.links.status(':code'), async ({ request }) => {
        attempt += 1
        if (attempt === 1) return failWith500()
        const body = (await request.json()) as { status: 'active' | 'disabled' }
        return HttpResponse.json({ ...exampleLink(), status: body.status })
      }),
    )
    render(<LinkStatusControl link={exampleLink()} />)

    await user.click(screen.getByRole('switch'))
    await screen.findByRole('alert')

    await user.click(screen.getByRole('switch'))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link turned off.'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch')).not.toHaveAttribute('data-error')
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })
})

describe('LinkStatusControl — the happy path', () => {
  it('PATCHes the stored status, reconciles to the server answer, and announces it politely', async () => {
    const user = userEvent.setup()
    render(<LinkStatusControl link={exampleLink()} />)

    await user.click(screen.getByRole('switch'))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link turned off.'))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(linkStore.get('aBcDeFgH')?.status).toBe('disabled')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('turns a disabled link back on', async () => {
    const user = userEvent.setup()
    const link = exampleLink({ status: 'disabled' })
    linkStore.set(link.code, link)
    render(<LinkStatusControl link={link} />)

    await user.click(screen.getByRole('switch'))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link turned on.'))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('ignores a second click while the first request is still in flight — one PATCH, not two', async () => {
    const user = userEvent.setup()
    const { release, calls } = gatedStatusHandler(() => HttpResponse.json({ ...exampleLink(), status: 'disabled' }))
    render(<LinkStatusControl link={exampleLink()} />)

    const toggle = screen.getByRole('switch')
    await user.click(toggle)
    await user.click(toggle)
    await user.click(toggle)
    release()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link turned off.'))
    expect(calls).toHaveLength(1)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps focus on the switch through the whole round trip', async () => {
    const user = userEvent.setup()
    render(<LinkStatusControl link={exampleLink()} />)

    await user.tab()
    expect(screen.getByRole('switch')).toHaveFocus()
    await user.keyboard(' ')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link turned off.'))

    expect(screen.getByRole('switch')).toHaveFocus()
  })

  it('shows the derived status, not the stored one, and says why the switch cannot override it', () => {
    render(<LinkStatusControl link={exampleLink({ expiresAt: '2000-01-01T00:00:00.000Z' })} />)

    expect(screen.getByText('Expired')).toBeInTheDocument()
    expect(screen.getByText(/cannot take payments whatever this switch says/i)).toBeInTheDocument()
  })

  it('says a single-use link that has been paid is Paid', () => {
    render(<LinkStatusControl link={exampleLink({ isReusable: false, paymentCount: 1 })} />)

    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.getByText(/single-use link has been paid/i)).toBeInTheDocument()
  })
})
