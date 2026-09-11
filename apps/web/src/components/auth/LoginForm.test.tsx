import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { API } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { LoginForm } from './LoginForm'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}))

async function fillForm(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  // `{ exact: false }`: `required` appends a visually-`aria-hidden` " *" to
  // the label's text content, which an exact match would fail against —
  // see `Field.test.tsx`'s own convention for a required field.
  await user.type(screen.getByLabelText('Email', { exact: false }), email)
  await user.type(screen.getByLabelText('Password', { exact: false }), password)
}

describe('LoginForm — Done when: a bad password shows the error beside the field', () => {
  it('renders the unauthenticated message beside the password field with aria-invalid/aria-describedby', async () => {
    const user = userEvent.setup()
    render(<LoginForm next={null} />)

    await fillForm(user, 'ngozi@example.com', 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const passwordInput = await screen.findByLabelText('Password', { exact: false })
    expect(passwordInput).toHaveAttribute('aria-invalid', 'true')
    const describedBy = passwordInput.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const message = screen.getByText('The email or password you entered is incorrect.')
    expect(message).toBeInTheDocument()
    expect(message.id).toBe(describedBy)

    // README: one message for both "wrong password" and "unknown user" —
    // it must never be split into two different stories beside two
    // different fields.
    expect(screen.queryByText(/no account|unknown user|does not exist/i)).not.toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('LoginForm — rate limiting', () => {
  it('shows the Retry-After window from the API', async () => {
    const user = userEvent.setup()
    render(<LoginForm next={null} />)

    await fillForm(user, 'ratelimited@example.com', 'anything123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument()
    expect(screen.getByText(/try again in 30 seconds/i)).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('LoginForm — successful sign-in', () => {
  it('navigates to /dashboard by default', async () => {
    const user = userEvent.setup()
    render(<LoginForm next={null} />)

    await fillForm(user, 'ngozi@example.com', 'a-real-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('navigates to a validated same-origin `next` instead', async () => {
    const user = userEvent.setup()
    render(<LoginForm next="/dashboard/links/aBcDeFgH" />)

    await fillForm(user, 'ngozi@example.com', 'a-real-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard/links/aBcDeFgH')
    })
  })
})

describe('LoginForm — validation_failed.fields', () => {
  it('renders a server-side field error beside the matching input', async () => {
    server.use(
      http.post(API.auth.login, () =>
        HttpResponse.json(
          {
            code: 'validation_failed',
            message: 'Could not sign in with that input.',
            fields: { email: ['This email address looks malformed.'] },
          },
          { status: 400 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(<LoginForm next={null} />)

    await fillForm(user, 'ngozi@example.com', 'a-real-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('This email address looks malformed.')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('LoginForm — transport failure', () => {
  it('shows a generic connection message, not a blank failure', async () => {
    server.use(http.post(API.auth.login, () => HttpResponse.error()))

    const user = userEvent.setup()
    render(<LoginForm next={null} />)

    await fillForm(user, 'ngozi@example.com', 'a-real-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText(/could not reach kobolink/i)).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})
