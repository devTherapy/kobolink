import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { NewLinkButton } from './NewLinkButton'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}))

beforeEach(async () => {
  refresh.mockClear()
  await fetch(`http://localhost:3000${API.auth.login}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ngozi@example.com', password: 'a-real-password', client: 'web' }),
  })
})

const trigger = () => screen.getByRole('button', { name: 'New link' })

describe('NewLinkButton — opens the drawer', () => {
  it('is closed until the CTA is used, and has no dialog in the DOM', () => {
    render(<NewLinkButton />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('opens a labelled dialog with focus on the Title field', async () => {
    const user = userEvent.setup()
    render(<NewLinkButton />)

    await user.click(trigger())

    expect(screen.getByRole('dialog', { name: 'New payment link' })).toBeInTheDocument()
    expect(screen.getByLabelText('Title', { exact: false })).toHaveFocus()
  })
})

describe('NewLinkButton — dismissing', () => {
  it('Esc closes and focus returns to the CTA', async () => {
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await user.click(trigger())

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('Cancel closes and focus returns to the CTA', async () => {
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await user.click(trigger())

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('refuses to close while a request is in flight, then lets go once it settles', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post(API.links.collection, async () => {
        await gate
        return HttpResponse.json(
          { code: 'internal', message: 'Something broke.' },
          { status: 500 },
        )
      }),
    )
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await user.click(trigger())
    await user.type(screen.getByLabelText('Title', { exact: false }), 'Ankara set')
    await user.click(screen.getByRole('button', { name: 'Create link' }))

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    release()
    expect(await screen.findByRole('alert')).toHaveTextContent('No link was created.')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('NewLinkButton — Done when: the table shows the new link without a full reload', () => {
  it('on success: closes, refreshes the server render, returns focus, and announces the result', async () => {
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await user.click(trigger())
    await user.type(screen.getByLabelText('Title', { exact: false }), 'Ankara set')
    await user.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(trigger()).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Created “Ankara set”.')
  })

  it('keeps the live region mounted (and empty) before anything is created', () => {
    render(<NewLinkButton />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('clears last time’s confirmation when the drawer is opened again', async () => {
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await user.click(trigger())
    await user.type(screen.getByLabelText('Title', { exact: false }), 'Ankara set')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Created')
    })

    await user.click(trigger())

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})

describe('NewLinkButton — a transport failure may have created the link anyway', () => {
  /** Drives the drawer to a failed submit and waits for the banner. */
  async function failCreating(user: ReturnType<typeof userEvent.setup>) {
    await user.click(trigger())
    await user.type(screen.getByLabelText('Title', { exact: false }), 'Ankara set')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    await screen.findByRole('alert')
  }

  const closers: readonly [string, (user: ReturnType<typeof userEvent.setup>) => Promise<void>][] = [
    ['Cancel', (user) => user.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Esc', (user) => user.keyboard('{Escape}')],
  ]

  const transportFailures: readonly [string, () => Response][] = [
    ['a 502 with a proxy HTML body', () => new HttpResponse('<h1>Bad Gateway</h1>', { status: 502 })],
    ['a dropped connection', () => HttpResponse.error()],
  ]

  it.each(
    transportFailures.flatMap(([failure, respond]) =>
      closers.map(([closer, close]) => [failure, closer, respond, close] as const),
    ),
  )('after %s, closing with %s refreshes the list', async (_failure, _closer, respond, close) => {
    server.use(http.post(API.links.collection, () => respond()))
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await failCreating(user)
    expect(refresh).not.toHaveBeenCalled()

    await close(user)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when the API gave a definite answer that nothing was created', async () => {
    server.use(
      http.post(API.links.collection, () =>
        HttpResponse.json({ code: 'validation_failed', message: 'Title is too long.' }, { status: 400 }),
      ),
    )
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await failCreating(user)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes once, not twice, when a retry after the transport failure succeeds', async () => {
    let attempts = 0
    server.use(
      http.post(API.links.collection, () => {
        attempts++
        return attempts === 1 ? HttpResponse.error() : (undefined)
      }),
    )
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await failCreating(user)

    await user.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('forgets the failure once the list was refreshed, so a later clean cancel does not refresh again', async () => {
    server.use(http.post(API.links.collection, () => HttpResponse.error()))
    const user = userEvent.setup()
    render(<NewLinkButton />)
    await failCreating(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(refresh).toHaveBeenCalledTimes(1)

    await user.click(trigger())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
