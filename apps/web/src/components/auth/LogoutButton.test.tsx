import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { API } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { LogoutButton } from './LogoutButton'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}))

describe('LogoutButton — Done when: logout clears and redirects', () => {
  it('calls auth.logout and redirects to /login', async () => {
    let logoutCalled = false
    server.use(
      http.post(API.auth.logout, () => {
        logoutCalled = true
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const user = userEvent.setup()
    render(<LogoutButton />)

    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login')
    })
    expect(logoutCalled).toBe(true)
  })

  it('shows an error and stays put when the logout request fails, instead of navigating away', async () => {
    server.use(http.post(API.auth.logout, () => HttpResponse.error()))

    const user = userEvent.setup()
    render(<LogoutButton />)

    const button = screen.getByRole('button', { name: 'Log out' })
    await user.click(button)

    // A failed logout never cleared the session cookie server-side, so
    // navigating to /login would just bounce straight back to /dashboard —
    // silently leaving the merchant signed in with no feedback. The fix
    // is to surface the failure and never call router.replace at all.
    await vi.waitFor(() => {
      expect(button).toHaveAttribute('data-error')
    })
    expect(replace).not.toHaveBeenCalled()
  })

  it('allows retrying after a failed logout, and redirects once the retry succeeds', async () => {
    let attempt = 0
    server.use(
      http.post(API.auth.logout, () => {
        attempt += 1
        return attempt === 1 ? HttpResponse.error() : new HttpResponse(null, { status: 204 })
      }),
    )

    const user = userEvent.setup()
    render(<LogoutButton />)

    const button = screen.getByRole('button', { name: 'Log out' })
    await user.click(button)
    await vi.waitFor(() => {
      expect(button).toHaveAttribute('data-error')
    })
    expect(replace).not.toHaveBeenCalled()

    await user.click(button)
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login')
    })
    expect(attempt).toBe(2)
  })
})
