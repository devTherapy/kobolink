import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { API } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { LogoutButton } from './LogoutButton'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
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

  it('still redirects to /login even when the logout request fails (best-effort)', async () => {
    server.use(http.post(API.auth.logout, () => HttpResponse.error()))

    const user = userEvent.setup()
    render(<LogoutButton />)

    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login')
    })
  })
})
