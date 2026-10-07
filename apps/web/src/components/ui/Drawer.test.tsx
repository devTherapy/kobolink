import { useRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Drawer } from './Drawer'

/** A page with something behind the drawer, and an opener that is not the first button on it. */
function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const openerRef = useRef<HTMLElement | null>(null)
  return (
    <>
      <a href="/elsewhere">Before the page</a>
      <button
        type="button"
        onClick={(event) => {
          openerRef.current = event.currentTarget
          setOpen(true)
        }}
      >
        Open drawer
      </button>
      <Drawer
        open={open}
        onClose={() => {
          onClose?.()
          setOpen(false)
        }}
        title="New payment link"
        returnFocusRef={openerRef}
      >
        <input aria-label="First field" />
        <input aria-label="Second field" />
        <button type="button">Last action</button>
      </Drawer>
    </>
  )
}

describe('Drawer — closed', () => {
  it('renders nothing at all', () => {
    render(<Drawer open={false} onClose={vi.fn()} title="Hidden"><input aria-label="Field" /></Drawer>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Field')).not.toBeInTheDocument()
  })
})

describe('Drawer — open', () => {
  it('is a labelled modal dialog', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))

    const dialog = screen.getByRole('dialog', { name: 'New payment link' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('puts focus on the first field of the body, not on the Close chrome', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))

    expect(screen.getByLabelText('First field')).toHaveFocus()
  })

  it('makes the page behind it inert and locks its scroll, then restores both on close', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open drawer' })
    // `render` appends its container to <body>; that container is the page behind the drawer.
    const page = opener.closest('body > div')!
    expect(page).not.toHaveAttribute('inert')

    await user.click(opener)
    expect(page).toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('hidden')

    await user.keyboard('{Escape}')
    expect(page).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('')
  })
})

describe('Drawer — Esc closes', () => {
  it('calls onClose when Escape is pressed with focus inside', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('still hears Escape when focus has fallen to <body> (a disabled input cannot hold it)', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))
    ;(document.activeElement as HTMLElement).blur()
    expect(document.body).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves closing to the owner: onClose that does nothing keeps the drawer open', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <>
        <button type="button">Opener</button>
        <Drawer open onClose={onClose} title="Busy">
          <input aria-label="Field" />
        </Drawer>
      </>,
    )

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes from the Close button too', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('Drawer — focus trap', () => {
  it('wraps Tab from the last tabbable element to the first (the Close button)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))
    screen.getByRole('button', { name: 'Last action' }).focus()

    await user.tab()

    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('wraps Shift+Tab from the first tabbable element to the last', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))
    screen.getByRole('button', { name: 'Close' }).focus()

    await user.tab({ shift: true })

    expect(screen.getByRole('button', { name: 'Last action' })).toHaveFocus()
  })

  it('never lets Tab reach the page behind it, however many times it is pressed', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))
    const dialog = screen.getByRole('dialog')

    for (let i = 0; i < 8; i++) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
  })
})

describe('Drawer — focus returns to the trigger', () => {
  it('lands back on the exact button that opened it after Esc', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open drawer' })
    await user.click(opener)

    await user.keyboard('{Escape}')

    expect(opener).toHaveFocus()
  })

  it('lands back on the opener after the Close button too', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open drawer' })
    await user.click(opener)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(opener).toHaveFocus()
  })
})
