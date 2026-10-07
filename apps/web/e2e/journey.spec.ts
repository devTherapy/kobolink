import { randomBytes, randomUUID } from 'node:crypto'
import { formatNaira } from '@kobolink/contracts'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { E2E_WEB_PORT } from './support/ports'

/**
 * PLAN.md F9: a merchant creates a link, a stranger pays it in a fresh browser
 * context, and the merchant's dashboard -- left open, never reloaded -- moves.
 *
 * Everything between the browsers is real: Postgres, the NestJS API, the Next
 * proxy, the `LISTEN/NOTIFY` -> SSE stream. The payment itself goes through the
 * API's own simulated gateway (`POST /api/checkout/verify` decides, per B5; an
 * email starting with the decline prefix is the only thing that fails it), so no
 * provider keys exist anywhere in this suite.
 *
 * Credentials are minted per run and never written down: the merchant is a
 * throwaway row in a throwaway container.
 */

const AMOUNT_NAIRA = '18,500'
const AMOUNT_KOBO = 1_850_000

function mintCredentials() {
  const id = randomUUID().slice(0, 8)
  return {
    email: `e2e-${id}@example.com`,
    password: randomBytes(18).toString('base64url'),
    displayName: `Ngozi E2E ${id}`,
    linkTitle: `Ankara two-piece ${id}`,
  }
}

/** What the test plants on the merchant's `window`; see the marker block in the test. */
interface E2eWindow {
  __noReload?: string
  __announcements?: string[]
}

/**
 * `browser.newContext()` does not inherit the project's device emulation, so a
 * "fresh" payer on the mobile project would otherwise be a desktop browser.
 * Only the device fields are copied -- never storage state -- so the context
 * stays as fresh as a stranger's phone.
 */
function projectContextOptions(use: {
  viewport?: { width: number; height: number } | null | undefined
  userAgent?: string | undefined
  deviceScaleFactor?: number | undefined
  isMobile?: boolean | undefined
  hasTouch?: boolean | undefined
}) {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = use
  return {
    ...(viewport ? { viewport } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    ...(isMobile !== undefined ? { isMobile } : {}),
    ...(hasTouch !== undefined ? { hasTouch } : {}),
  }
}

/** The `<dd>` of the dashboard stat card with this label. */
function stat(page: Page, label: string) {
  return page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
}

test('a stranger pays a new link and the merchant dashboard moves without a reload', async ({ page, browser }, testInfo) => {
  const merchant = mintCredentials()
  const baseURL = `http://localhost:${E2E_WEB_PORT}`

  // -- Merchant: register (API, through the Next proxy), then sign in through the UI.
  const signup = await playwrightRequest.newContext({ baseURL })
  const registered = await signup.post('/api/auth/register', {
    data: {
      email: merchant.email,
      password: merchant.password,
      displayName: merchant.displayName,
      role: 'merchant',
      client: 'web',
    },
  })
  expect(registered.status(), 'register through the proxy').toBe(201)
  await signup.dispose()

  await page.goto('/login')
  await page.getByLabel('Email').fill(merchant.email)
  await page.getByLabel('Password').fill(merchant.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Welcome back, ${merchant.displayName}`)

  // MSW must not be anywhere on this path.
  const workers = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
  expect(workers, 'no service worker (MSW) is registered').toBe(0)

  // The stream has to be open *before* the payment, or this would only prove a
  // page load. "Live" is the provider's own word for an open, receiving stream.
  await expect(page.locator('[data-status]')).toHaveAttribute('data-status', 'live')
  await expect(stat(page, 'Total collected')).toHaveText(formatNaira(0))
  await expect(stat(page, 'Payments')).toHaveText('0')
  await expect(stat(page, 'Active links')).toHaveText('0')

  // A value that survives a soft navigation or `router.refresh()` but not a
  // reload; read back at the end to prove the page was never reloaded. The
  // observer records the screen-reader announcement: the live region's text is
  // only present between the event and the refresh it schedules (~300ms), which
  // a polling assertion made afterwards would usually miss.
  const noReloadMarker = randomUUID()
  await page.evaluate((marker) => {
    const w = window as unknown as E2eWindow
    w.__noReload = marker
    w.__announcements = []
    new MutationObserver(() => {
      for (const region of document.querySelectorAll('[role="status"]')) {
        const text = region.textContent ?? ''
        if (text.includes('New payment received') && !w.__announcements?.includes(text)) w.__announcements?.push(text)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, noReloadMarker)

  // -- Merchant: create the link in the drawer.
  await page.getByRole('button', { name: 'New link' }).click()
  const drawer = page.getByRole('dialog', { name: 'New payment link' })
  await drawer.getByLabel('Title').fill(merchant.linkTitle)
  await drawer.getByLabel('Amount').fill(AMOUNT_NAIRA)
  await drawer.getByRole('button', { name: 'Create link' }).click()
  await expect(drawer).toBeHidden()

  const rowLink = page.getByRole('link', { name: `View ${merchant.linkTitle}` })
  await expect(rowLink).toBeVisible()
  const href = await rowLink.getAttribute('href')
  const code = /^\/dashboard\/links\/([^/]+)$/.exec(href ?? '')?.[1]
  expect(code, 'the new row links to its detail page').toBeTruthy()
  await expect(stat(page, 'Active links')).toHaveText('1')
  const row = page.getByRole('row').filter({ has: rowLink })
  await expect(row).toContainText('Active')

  // -- Payer: a fresh context shares nothing with the merchant -- no cookies, no storage.
  const payerContext = await browser.newContext({ ...projectContextOptions(testInfo.project.use), baseURL })
  try {
    // The server-rendered page, before any JS: the first response carries the
    // merchant name and amount in its Open Graph tags (what a WhatsApp scraper reads).
    const rawHtml = await (await payerContext.request.get(`/l/${code}`)).text()
    const ogTitle = /<meta property="og:title" content="([^"]*)"/.exec(rawHtml)?.[1]
    expect(ogTitle, 'og:title in the raw HTML').toBe(`Pay ${formatNaira(AMOUNT_KOBO)} to ${merchant.displayName}`)
    expect(rawHtml).toContain(`<title>Pay ${formatNaira(AMOUNT_KOBO)} to ${merchant.displayName}</title>`)
    expect(rawHtml).toContain(merchant.linkTitle)

    const payer = await payerContext.newPage()
    await payer.goto(`/l/${code}`)
    await expect(payer.getByRole('heading', { level: 1 })).toHaveText(merchant.linkTitle)
    await payer.getByLabel('Your name').fill('Chidi Payer')
    await payer.getByLabel('Email').fill(`payer-${randomUUID().slice(0, 8)}@example.com`)
    await payer.getByRole('button', { name: `Pay ${formatNaira(AMOUNT_KOBO)}` }).click()
    await expect(payer.getByRole('heading', { name: 'Payment successful' })).toBeVisible()
    await expect(payer.getByText('Money moved. Your payment was successful.')).toBeVisible()
  } finally {
    await payerContext.close()
  }

  // -- Merchant: the same page, never reloaded, has moved.
  await expect(stat(page, 'Total collected')).toHaveText(formatNaira(AMOUNT_KOBO))
  await expect(stat(page, 'Payments')).toHaveText('1')
  await expect(row).toContainText('Paid')
  await expect(row.getByRole('cell').nth(3)).toHaveText('1')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as E2eWindow).__announcements ?? []), {
      message: 'the screen-reader announcement was rendered',
    })
    .toContain(`New payment received: ${formatNaira(AMOUNT_KOBO)} from Chidi Payer.`)

  const markerAfter = await page.evaluate(() => (window as unknown as E2eWindow).__noReload)
  expect(markerAfter, 'the dashboard page was not reloaded').toBe(noReloadMarker)
})
