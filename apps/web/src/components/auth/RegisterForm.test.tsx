import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RegisterForm } from './RegisterForm'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}))

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  { email, password = 'a-real-password' }: { email: string; password?: string },
) {
  // `{ exact: false }`: `required` appends a visually-`aria-hidden` " *" to
  // the label's text content — invisible to assistive tech (the accessible
  // name excludes it), but still part of the label element's `textContent`,
  // which is what an exact match compares against. `Field.test.tsx`
  // establishes this same convention for a required field.
  await user.type(screen.getByLabelText('Full name', { exact: false }), 'Ngozi Okafor')
  await user.type(screen.getByLabelText('Email', { exact: false }), email)
  await user.type(screen.getByLabelText('Password', { exact: false }), password)
}

describe('RegisterForm — conflict', () => {
  it('renders the taken-email error beside the email field, not as a generic banner', async () => {
    const user = userEvent.setup()
    render(<RegisterForm next={null} />)

    await fillForm(user, { email: 'taken@example.com' })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const emailInput = await screen.findByLabelText('Email', { exact: false })
    expect(emailInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('An account with that email address already exists.')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('RegisterForm — successful registration', () => {
  it('navigates to /dashboard on success', async () => {
    const user = userEvent.setup()
    render(<RegisterForm next={null} />)

    await fillForm(user, { email: 'ngozi@example.com' })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('leaves phone empty without a validation error — it is optional', async () => {
    const user = userEvent.setup()
    render(<RegisterForm next={null} />)

    await fillForm(user, { email: 'ngozi2@example.com' })
    expect(screen.getByLabelText('Phone')).not.toHaveAttribute('aria-invalid')

    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })
})

describe('RegisterForm — local validation', () => {
  it('rejects a too-short password before ever calling the API, with human-readable copy', async () => {
    const user = userEvent.setup()
    render(<RegisterForm next={null} />)

    await fillForm(user, { email: 'ngozi@example.com', password: 'short' })
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByLabelText('Password', { exact: false })).toHaveAttribute('aria-invalid', 'true')
    // This form is `noValidate` — Zod's own `safeParse` is the only guard
    // before submission, so its raw v4 message ("Too small: expected string
    // to have >=10 characters") would otherwise render verbatim right below
    // the "At least 10 characters." hint. Assert the human copy, not just
    // that *some* error rendered.
    expect(screen.getByText('Password must be at least 10 characters.')).toBeInTheDocument()
    expect(screen.queryByText(/too small|>=10 characters/i)).not.toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it('rejects an empty full name with human-readable copy, not the raw Zod message', async () => {
    const user = userEvent.setup()
    render(<RegisterForm next={null} />)

    await user.type(screen.getByLabelText('Email', { exact: false }), 'ngozi@example.com')
    await user.type(screen.getByLabelText('Password', { exact: false }), 'a-real-password')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByLabelText('Full name', { exact: false })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Full name is required.')).toBeInTheDocument()
    expect(screen.queryByText(/too small|>=1 characters/i)).not.toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})
