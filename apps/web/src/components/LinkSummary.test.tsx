import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ApiError } from '@kobolink/contracts'
import { server } from '@/mocks/server'
import { LinkSummary } from './LinkSummary'

/**
 * The F0 done-when test: a component renders against a mocked endpoint with
 * no backend running. `handlers.ts` answers `API.links.resolve` from the
 * `exampleLink()` fixture in `@kobolink/contracts`; this asserts the fixture's
 * data reaches the screen, and that a non-2xx response surfaces as the typed
 * error state rather than an unhandled rejection.
 */
describe('LinkSummary', () => {
  it('renders the fixture data returned by the mocked public-link endpoint', async () => {
    render(<LinkSummary code="aBcDeFgH" />)

    expect(screen.getByRole('status', { name: 'Loading link' })).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'Ankara Two-Piece Set' })).toBeInTheDocument()
    expect(screen.getByText('Adebayo Stores')).toBeInTheDocument()
    expect(screen.getByText('₦18,500')).toBeInTheDocument()
  })

  it('surfaces a non-2xx response as the typed error state, not a crash', async () => {
    const notFound: ApiError = { code: 'not_found', message: 'No link with that code.' }
    server.use(
      http.get('/api/links/:code/public', () => HttpResponse.json(notFound, { status: 404 })),
    )

    render(<LinkSummary code="ZZZZZZZZ" />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('No link with that code.')
    })
  })
})
