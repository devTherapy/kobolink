import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyLink } from './CopyLink'

const URL_TEXT = 'https://pay.folusayo.com/l/aBcDeFgH'

/** `userEvent.setup()` installs its own Clipboard stub on `navigator`; these replace it deliberately. */
function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

function setExecCommand(impl: ((command: string) => boolean) | undefined) {
  Object.defineProperty(document, 'execCommand', { value: impl, configurable: true, writable: true })
}

afterEach(() => {
  vi.useRealTimers()
  setExecCommand(undefined)
})

describe('CopyLink', () => {
  it('shows the URL as selectable text with a name, and a Copy button (default)', () => {
    render(<CopyLink url={URL_TEXT} />)

    const input = screen.getByRole('textbox', { name: 'Payment link URL' })
    expect(input).toHaveValue(URL_TEXT)
    expect(input).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
  })

  it('selects the whole URL when the field is focused, so Ctrl+C is one keystroke away', async () => {
    const user = userEvent.setup()
    render(<CopyLink url={URL_TEXT} />)

    await user.click(screen.getByRole('textbox'))

    const input = screen.getByRole<HTMLInputElement>('textbox')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(URL_TEXT.length)
  })

  it('copies with the Clipboard API, changes the label, and announces it in a live region', async () => {
    const user = userEvent.setup()
    render(<CopyLink url={URL_TEXT} />)

    await user.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe(URL_TEXT)
    expect(screen.getByRole('status')).toHaveTextContent('Link copied to the clipboard.')
  })

  it('puts the label back after a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    render(<CopyLink url={URL_TEXT} />)

    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('falls back to execCommand when the Clipboard API does not exist (an http:// host)', async () => {
    const user = userEvent.setup()
    setClipboard(undefined)
    const execCommand = vi.fn(() => true)
    setExecCommand(execCommand)
    render(<CopyLink url={URL_TEXT} />)

    await user.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(execCommand).toHaveBeenCalledWith('copy')
    // It copied *the URL*: the field was selected end to end when the command ran.
    const input = screen.getByRole<HTMLInputElement>('textbox')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(URL_TEXT.length)
  })

  it('falls back to execCommand when the Clipboard API rejects (permission denied)', async () => {
    const user = userEvent.setup()
    setClipboard({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) })
    const execCommand = vi.fn(() => true)
    setExecCommand(execCommand)
    render(<CopyLink url={URL_TEXT} />)

    await user.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('when nothing works it says so, selects the URL, and never claims "Copied" (error state)', async () => {
    const user = userEvent.setup()
    setClipboard(undefined)
    setExecCommand(() => false)
    render(<CopyLink url={URL_TEXT} />)

    const button = screen.getByRole('button', { name: 'Copy link' })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/press Ctrl\+C/i))
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()
    expect(button).toHaveAttribute('data-error', 'true')
    // The URL is selected and focused, ready for the manual copy.
    const input = screen.getByRole<HTMLInputElement>('textbox')
    expect(input).toHaveFocus()
    expect((input.selectionEnd ?? 0) - (input.selectionStart ?? 0)).toBe(URL_TEXT.length)
  })

  it('shows the busy state while the clipboard write is pending (loading state)', async () => {
    const user = userEvent.setup()
    let finish: () => void = vi.fn()
    setClipboard({
      writeText: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    render(<CopyLink url={URL_TEXT} />)

    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(screen.getByRole('button', { name: 'Copy link' })).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      finish()
      await Promise.resolve()
    })
    expect(await screen.findByRole('button', { name: 'Copied' })).not.toHaveAttribute('aria-busy')
  })

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup()
    render(<CopyLink url={URL_TEXT} />)

    await user.tab() // the URL field
    await user.tab() // the Copy button
    expect(screen.getByRole('button', { name: 'Copy link' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
