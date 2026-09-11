import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Pill, StatusPill } from './Pill'

describe('Pill', () => {
  it('renders its label with a tone-specific class', () => {
    render(<Pill tone="danger">Failed</Pill>)
    const pill = screen.getByText('Failed')
    expect(pill.className).toMatch(/color-danger/)
  })

  it.each([
    ['success', 'color-success'],
    ['warning', 'color-warning'],
    ['danger', 'color-danger'],
    ['neutral', 'color-ink-2'],
  ] as const)('gives the %s tone a distinguishing %s class, not just a differently-labelled pill', (tone, expectedClassFragment) => {
    render(<Pill tone={tone}>{tone}</Pill>)
    expect(screen.getByText(tone).className).toMatch(new RegExp(expectedClassFragment))
  })
})

describe('StatusPill', () => {
  it.each([
    ['Active', 'color-success'],
    ['Paid', 'color-success'],
    ['Pending', 'color-warning'],
    ['Failed', 'color-danger'],
    ['Disabled', 'color-ink-2'],
    ['Expired', 'color-ink-2'],
  ] as const)('maps %s to the %s tone', (status, expectedClassFragment) => {
    render(<StatusPill status={status} />)
    expect(screen.getByText(status).className).toMatch(new RegExp(expectedClassFragment))
  })
})
