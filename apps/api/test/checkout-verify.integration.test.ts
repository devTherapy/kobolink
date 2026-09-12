import { randomUUID } from 'node:crypto'
import {
  API,
  ApiErrorSchema,
  InitializeCheckoutResponseSchema,
  PaymentLinkSchema,
  VerifyCheckoutResponseSchema,
} from '@kobolink/contracts'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiTestContext, startApiTestContext } from './support/api-test-context.js'
import { registerMerchant } from './support/register-user.js'

/**
 * `POST /api/checkout/verify` — PLAN.md's B5 row, the endpoint that
 * actually decides a payment and (on success) posts the ledger entries.
 * Unauthenticated by design, same as `checkout-initialize.integration.test
 * .ts` — no `Cookie` on any request here either.
 *
 * "Entries balance to zero" and "a client cannot forge a posting" are
 * proven directly against the database in the tests that need them, not
 * asserted once in the abstract — the happy-path test itself sums
 * `ledger_entries` for the posting it just created.
 */
describe('POST /api/checkout/verify (real Postgres via Testcontainers)', () => {
  let ctx: ApiTestContext | undefined

  beforeAll(async () => {
    ctx = await startApiTestContext()
  }, 120_000)

  afterAll(async () => {
    await ctx?.teardown()
  })

  function idempotencyKey(): string {
    return `test-idem-${randomUUID()}`
  }

  async function createLink(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await getCtx()
      .request.post(API.links.collection)
      .set('Cookie', cookie)
      .send({ title: 'A link', ...overrides })
    if (response.status !== 201) throw new Error(`fixture create failed: ${response.status} ${JSON.stringify(response.body)}`)
    return PaymentLinkSchema.parse(response.body).code
  }

  async function initialize(code: string, amountKobo: number, payerEmail = 'chidinma@example.test'): Promise<string> {
    const response = await getCtx()
      .request.post(API.checkout.initialize)
      .set('Idempotency-Key', idempotencyKey())
      .send({ code, amountKobo, payerName: 'Chidinma Okafor', payerEmail })
    if (response.status !== 201) throw new Error(`fixture initialize failed: ${response.status} ${JSON.stringify(response.body)}`)
    return InitializeCheckoutResponseSchema.parse(response.body).reference
  }

  function verify(reference: string, key = idempotencyKey()) {
    return getCtx().request.post(API.checkout.verify).set('Idempotency-Key', key).send({ reference })
  }

  function pool(): Pool {
    return new Pool({ connectionString: getCtx().connectionString })
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Polls `pg_stat_activity` (on its own connection, never the one doing
   * the holding) until some *other* backend is genuinely waiting on a lock,
   * or the timeout elapses. This is what makes "the concurrent request is
   * really blocked behind our held-open transaction" an assertion the test
   * proves rather than a fixed `sleep` the test just hopes was long enough.
   */
  async function waitForBlockedBackend(activity: Pool, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await activity.query<{ count: number }>(
        `select count(*)::int as count
         from pg_stat_activity
         where datname = current_database()
           and wait_event_type = 'Lock'
           and pid <> pg_backend_pid()`,
      )
      if ((result.rows[0]?.count ?? 0) > 0) return true
      await sleep(15)
    }
    return false
  }

  it('200 success: posts two balanced ledger entries (merchant_receivable credited, external_funding debited) and updates the link counters', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-happy@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)

    const response = await verify(reference)

    expect(response.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(response.body)
    expect(body.payment.reference).toBe(reference)
    expect(body.payment.status).toBe('success')
    expect(body.payment.moneyMoved).toBe(true)
    expect(body.payment.failureReason).toBeNull()
    expect(body.payment.amountKobo).toBe(500_000)
    expect(body.payment.completedAt).not.toBeNull()
    // The email is masked, never the raw address, even to the payer's own result screen.
    expect(body.payment.payerEmail).toBe('c***@example.test')

    const db = pool()
    try {
      const postings = await db.query<{ id: string; kind: string }>(`select id, kind from postings where reference = $1`, [
        reference,
      ])
      expect(postings.rows).toHaveLength(1)
      expect(postings.rows[0]?.kind).toBe('link_payment')
      const postingId = postings.rows[0]?.id

      const entries = await db.query<{ amount_kobo: string; kind: string }>(
        `select e.amount_kobo, a.kind
         from ledger_entries e
         join ledger_accounts a on a.id = e.account_id
         where e.posting_id = $1`,
        [postingId],
      )
      expect(entries.rows).toHaveLength(2)
      const sum = entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)
      expect(sum).toBe(0)
      const byKind = new Map(entries.rows.map((row) => [row.kind, Number(row.amount_kobo)]))
      expect(byKind.get('merchant_receivable')).toBe(500_000)
      expect(byKind.get('external_funding')).toBe(-500_000)
    } finally {
      await db.end()
    }

    const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    const link = PaymentLinkSchema.parse(linkResponse.body)
    expect(link.paymentCount).toBe(1)
    expect(link.totalPaidKobo).toBe(500_000)
  })

  it('200 failed (simulated decline): a payerEmail starting fail@ declines — 200, not an error, and moves no money', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-decline@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000, 'fail@example.test')

    const response = await verify(reference)

    expect(response.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(response.body)
    expect(body.payment.status).toBe('failed')
    expect(body.payment.moneyMoved).toBe(false)
    expect(body.payment.failureReason).toBe('Card declined by the simulated gateway.')

    const db = pool()
    try {
      const postings = await db.query<{ id: string }>(`select id from postings where reference = $1`, [reference])
      expect(postings.rows).toHaveLength(1)
      const entries = await db.query(`select 1 from ledger_entries where posting_id = $1`, [postings.rows[0]?.id])
      // A decline moves no money at all — not a reversing pair, no entries whatsoever.
      expect(entries.rows).toHaveLength(0)
    } finally {
      await db.end()
    }

    const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    const link = PaymentLinkSchema.parse(linkResponse.body)
    expect(link.paymentCount).toBe(0)
    expect(link.totalPaidKobo).toBe(0)
  })

  it('200 failed: a single-use link already paid by a racing checkout resolves the second attempt as failed, never a second posting that moves money', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-already-paid@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: false })

    // Both checkouts are *initialized* while the link is still fresh
    // (`paymentCount === 0`) — modelling two payers racing for the same
    // single-use link — and only then verified in order, so the decision
    // (not just the initialize-time check) is what has to catch the second
    // one: `decideVerify` re-resolves the link, under a row lock, at the
    // moment it is about to decide, never trusting whatever it looked like
    // back at `initialize` time.
    const firstReference = await initialize(code, 500_000)
    const secondReference = await initialize(code, 500_000, 'second@example.test')

    const firstVerify = await verify(firstReference)
    expect(VerifyCheckoutResponseSchema.parse(firstVerify.body).payment.status).toBe('success')

    const secondVerify = await verify(secondReference)

    expect(secondVerify.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(secondVerify.body)
    expect(body.payment.status).toBe('failed')
    expect(body.payment.moneyMoved).toBe(false)
    expect(body.payment.failureReason).toBe('Link is already paid')

    const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
    const link = PaymentLinkSchema.parse(linkResponse.body)
    expect(link.paymentCount).toBe(1)
    expect(link.totalPaidKobo).toBe(500_000)
  })

  it('404 not_found: a reference nothing ever initialized', async () => {
    const response = await verify('kbl_2A3b4C5d6E')
    expect(response.status).toBe(404)
    expect(ApiErrorSchema.parse(response.body).code).toBe('not_found')
  })

  it('400 validation_failed: no Idempotency-Key header', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-no-key@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000 })
    const reference = await initialize(code, 500_000)

    const response = await getCtx().request.post(API.checkout.verify).send({ reference })

    expect(response.status).toBe(400)
    const body = ApiErrorSchema.parse(response.body)
    expect(body.code).toBe('validation_failed')
    expect(body.moneyMoved).toBe(false)
  })

  it('replaying the same Idempotency-Key is a no-op: identical response, still exactly one posting', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-replay-same-key@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)
    const key = idempotencyKey()

    const first = await verify(reference, key)
    const second = await verify(reference, key)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)

    const db = pool()
    try {
      const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where reference = $1`, [reference])
      expect(postings.rows[0]?.count).toBe(1)
    } finally {
      await db.end()
    }
  })

  it('verifying the same reference again under a *different* Idempotency-Key still returns the original decision — a reference is decided once', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-replay-diff-key@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)

    const first = await verify(reference, idempotencyKey())
    const second = await verify(reference, idempotencyKey())

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)

    const db = pool()
    try {
      const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where reference = $1`, [reference])
      expect(postings.rows[0]?.count).toBe(1)
      const linkResponse = await getCtx().request.get(API.links.item(code)).set('Cookie', merchant.cookie)
      expect(PaymentLinkSchema.parse(linkResponse.body).paymentCount).toBe(1)
    } finally {
      await db.end()
    }
  })

  it('a client cannot forge a ledger posting: extra reference-adjacent fields in the body are ignored, the amount is always what initialize resolved', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-forged-fields@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)

    const response = await getCtx()
      .request.post(API.checkout.verify)
      .set('Idempotency-Key', idempotencyKey())
      .send({
        reference,
        // `VerifyCheckoutRequestSchema` names only `reference` — none of
        // these reach `PaymentsService`, which decides the amount and the
        // accounts purely from server-side state (`checkout_sessions`,
        // resolved at `initialize` time).
        amountKobo: 999_999_999,
        entries: [{ accountId: 'evil_account', amountKobo: 999_999_999 }],
        accountId: 'evil_account',
      })

    expect(response.status).toBe(200)
    const body = VerifyCheckoutResponseSchema.parse(response.body)
    expect(body.payment.amountKobo).toBe(500_000)

    const db = pool()
    try {
      const entries = await db.query<{ amount_kobo: string }>(
        `select e.amount_kobo from ledger_entries e join postings p on p.id = e.posting_id where p.reference = $1`,
        [reference],
      )
      const amounts = entries.rows.map((row) => Number(row.amount_kobo)).sort((a, b) => a - b)
      expect(amounts).toEqual([-500_000, 500_000])
    } finally {
      await db.end()
    }
  })

  it('smoke test — concurrent first-time payments across 8 distinct links/merchants all succeed with exactly one balanced posting each (does NOT pin the getOrCreateAccount race — see the deterministic test below for that)', async () => {
    // NOTE: despite the docstring this test originally shipped with, this
    // does not reliably exercise `getOrCreateAccount`'s unique-violation
    // recovery path. By the time this test runs, an earlier test in this
    // file has already created the `external_funding` singleton, so
    // `findAccount` finds it and no insert (let alone a racing one) is ever
    // attempted for it; and all 8 merchants are distinct, so
    // `ledger_accounts_owner_kind_unique` can never fire between them
    // either — there is no pair of concurrent inserts here that target the
    // same row. What's left is 8 merchant_receivable creates that don't
    // conflict with each other or anything else, so this passes identically
    // against the pre-fix code. It's still a reasonable smoke test for
    // "many concurrent first payments don't do something else broken", so
    // it stays — but the test named "deterministically forces the
    // getOrCreateAccount unique-violation race" below is what actually pins
    // the `bbf9ce9` fix.
    const LINK_COUNT = 8
    const references: string[] = []
    const merchantIds: string[] = []
    for (let i = 0; i < LINK_COUNT; i++) {
      const merchant = await registerMerchant(getCtx(), `verify-concurrent-accounts-${i}@example.test`)
      merchantIds.push(merchant.userId)
      const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
      references.push(await initialize(code, 500_000, `payer-${i}@example.test`))
    }

    const responses = await Promise.all(references.map((reference) => verify(reference)))

    for (const response of responses) {
      expect(response.status).toBe(200)
      const body = VerifyCheckoutResponseSchema.parse(response.body)
      expect(body.payment.status).toBe('success')
      expect(body.payment.moneyMoved).toBe(true)
    }

    const db = pool()
    try {
      // Exactly one `external_funding` row ever exists, no matter how many
      // transactions raced to create it — the losers recovered the
      // winner's row instead of erroring (or, pre-fix, instead of leaving
      // one race unrecovered and duplicating the singleton).
      const externalAccounts = await db.query<{ count: number }>(
        `select count(*)::int as count from ledger_accounts where kind = 'external_funding'`,
      )
      expect(externalAccounts.rows[0]?.count).toBe(1)

      // Scoped to *this test's* merchants — earlier tests in this file
      // create their own `merchant_receivable` rows too, so a bare, unscoped
      // count here would be a false negative against the rest of the suite,
      // not a real assertion about this race.
      const merchantAccounts = await db.query<{ count: number }>(
        `select count(*)::int as count from ledger_accounts where kind = 'merchant_receivable' and owner_user_id = any($1::text[])`,
        [merchantIds],
      )
      expect(merchantAccounts.rows[0]?.count).toBe(LINK_COUNT)

      for (const reference of references) {
        const entries = await db.query<{ amount_kobo: string }>(
          `select e.amount_kobo from ledger_entries e join postings p on p.id = e.posting_id where p.reference = $1`,
          [reference],
        )
        expect(entries.rows).toHaveLength(2)
        const sum = entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)
        expect(sum).toBe(0)
      }
    } finally {
      await db.end()
    }
  })

  it('deterministically forces the getOrCreateAccount unique-violation race: a held-open raw insert on ledger_accounts_owner_kind_unique blocks the real verify call, which recovers the winner\'s row on 200 instead of a raw 500', async () => {
    // A brand-new merchant, never paid before — its `merchant_receivable`
    // account does not exist yet, so `verify`'s own `getOrCreateAccount`
    // call is guaranteed to attempt a real insert for
    // `(kind: 'merchant_receivable', ownerUserId: merchant.userId)` rather
    // than short-circuiting on `findAccount`. That sidesteps both problems
    // the smoke test above has: no earlier test could have already created
    // this specific owner's account, and we control the exact row a second,
    // real insert collides with instead of hoping 8 distinct owners
    // incidentally collide on the singleton.
    const merchant = await registerMerchant(getCtx(), 'verify-forced-account-race@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const reference = await initialize(code, 500_000)

    // A dedicated raw connection (not the `Pool` the app itself uses) holds
    // one transaction open with an uncommitted insert claiming
    // `(merchant_receivable, merchant.userId)` — exactly the row `verify`'s
    // `getOrCreateAccount` is about to try to create. Under READ COMMITTED,
    // the app's own `findAccount` re-read can't see this uncommitted row,
    // so it will not short-circuit; it will attempt the same insert and
    // collide with us at the Postgres level, not "eventually, if the timing
    // lines up" — that is the difference between this test and the smoke
    // test above.
    const rawClient = new Client({ connectionString: getCtx().connectionString })
    await rawClient.connect()
    const activity = pool()
    try {
      await rawClient.query('BEGIN')
      const winnerAccountId = randomUUID()
      await rawClient.query(
        `insert into ledger_accounts (id, owner_user_id, kind) values ($1, $2, 'merchant_receivable')`,
        [winnerAccountId, merchant.userId],
      )

      // Fire the real endpoint call concurrently — its transaction's insert
      // for this exact (owner, kind) pair is now queued behind ours at the
      // Postgres index level and cannot proceed until we commit or roll
      // back.
      // `verify(...)` returns a supertest `Test`, which — like
      // superagent generally — does not actually dispatch the HTTP request
      // until something calls `.then`/`.end` on it. Storing it in a plain
      // variable and awaiting it only later (after the polling below) would
      // silently never send the request during the window we need it
      // in-flight; wrapping it in `Promise.resolve` forces that `.then` call
      // now, so the request is genuinely on the wire before we start polling.
      const verifyPromise = Promise.resolve(verify(reference))

      // Prove the block is real before touching anything — a genuinely
      // different backend must be sitting in `pg_stat_activity` waiting on
      // a lock. If this never becomes true, the race was never engaged at
      // all and the rest of the test would otherwise pass for the wrong
      // reason.
      const blocked = await waitForBlockedBackend(activity)
      expect(blocked).toBe(true)

      // Release the lock. The real request's queued insert now fails with
      // a genuine 23505 on `ledger_accounts_owner_kind_unique` — this is
      // the exact unique-violation `getOrCreateAccount`'s catch block has
      // to recover from by re-reading and returning our winner's row on the
      // still-live outer transaction, rather than a raw 500 from an
      // aborted one (the pre-`bbf9ce9` bug).
      await rawClient.query('COMMIT')

      const response = await verifyPromise
      expect(response.status).toBe(200)
      const body = VerifyCheckoutResponseSchema.parse(response.body)
      expect(body.payment.status).toBe('success')
      expect(body.payment.moneyMoved).toBe(true)

      const db = pool()
      try {
        // Exactly one merchant_receivable account for this merchant — the
        // race did not duplicate it — and it is *our* row: the real
        // request's insert lost and recovered the winner's id rather than
        // somehow squeezing in a second row.
        const accounts = await db.query<{ id: string; count: number }>(
          `select id, count(*) over ()::int as count from ledger_accounts where kind = 'merchant_receivable' and owner_user_id = $1`,
          [merchant.userId],
        )
        expect(accounts.rows).toHaveLength(1)
        expect(accounts.rows[0]?.count).toBe(1)
        expect(accounts.rows[0]?.id).toBe(winnerAccountId)

        // The posting the real request produced points its
        // merchant_receivable leg at that same winner account, and the two
        // entries still balance to zero.
        const entries = await db.query<{ amount_kobo: string; account_id: string; kind: string }>(
          `select e.amount_kobo, e.account_id, a.kind
           from ledger_entries e
           join postings p on p.id = e.posting_id
           join ledger_accounts a on a.id = e.account_id
           where p.reference = $1`,
          [reference],
        )
        expect(entries.rows).toHaveLength(2)
        expect(entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)).toBe(0)
        const merchantLeg = entries.rows.find((row) => row.kind === 'merchant_receivable')
        expect(merchantLeg?.account_id).toBe(winnerAccountId)
        expect(Number(merchantLeg?.amount_kobo)).toBe(500_000)
      } finally {
        await db.end()
      }
    } finally {
      await activity.end()
      // If the test failed before COMMIT above, this transaction is still
      // open — end() alone would leave it dangling on the pool until the
      // connection is torn down; roll it back explicitly so a failure here
      // never holds a lock into the next test.
      await rawClient.query('ROLLBACK').catch(() => undefined)
      await rawClient.end()
    }
  })

  it('same link — concurrent verify calls reusing the same Idempotency-Key for two different references: one succeeds, the other is a clean idempotency_mismatch, never a raw 500', async () => {
    const merchant = await registerMerchant(getCtx(), 'verify-concurrent-idem-race@example.test')
    const code = await createLink(merchant.cookie, { amountKobo: 500_000, isReusable: true })
    const firstReference = await initialize(code, 500_000, 'racer-one@example.test')
    const secondReference = await initialize(code, 500_000, 'racer-two@example.test')
    const key = idempotencyKey()

    // Both calls pass `IdempotencyService.lookup` before either has
    // committed (no row exists yet for `key`) and lock two *different*
    // `checkout_sessions` rows, so the session-level `FOR UPDATE` never
    // serialises them — but both references share this *one* link, and
    // `decideVerify` also takes `FOR UPDATE` on the link row itself, so in
    // practice this pair *is* serialised there: the second transaction
    // blocks on the link lock until the first commits, and only reaches the
    // `postings` insert after the winner has already landed. That still
    // validly exercises the catch-and-rethrow path below (the loser's
    // insert genuinely conflicts and genuinely gets caught), but it is not
    // a DB-level race at the `postings` insert itself — see the
    // "two different links" variant right after this one for that.
    const [first, second] = await Promise.all([verify(firstReference, key), verify(secondReference, key)])

    const statuses = [first.status, second.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 422])

    const success = first.status === 200 ? first : second
    const mismatch = first.status === 422 ? first : second
    const successBody = VerifyCheckoutResponseSchema.parse(success.body)
    expect(successBody.payment.status).toBe('success')
    expect(successBody.payment.moneyMoved).toBe(true)
    expect(ApiErrorSchema.parse(mismatch.body).code).toBe('idempotency_mismatch')

    const db = pool()
    try {
      // Only the winner's posting survives — the loser's transaction rolled
      // back in full, including its own `checkout_sessions` claim, so it
      // never left a half-decided reference behind either.
      const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where idempotency_key = $1`, [
        key,
      ])
      expect(postings.rows[0]?.count).toBe(1)
      const idempotencyRows = await db.query<{ count: number }>(`select count(*)::int as count from idempotency_keys where key = $1`, [
        key,
      ])
      expect(idempotencyRows.rows[0]?.count).toBe(1)
    } finally {
      await db.end()
    }
  })

  it('two different links — concurrent verify calls reusing the same Idempotency-Key for two different links/references: no link-level lock to serialise them, so this is the real DB-level race on postings_idempotency_scope_key_unique', async () => {
    // Two distinct links (and, incidentally, two distinct merchants) means
    // `decideVerify`'s `FOR UPDATE` locks — one on `checkout_sessions`, one
    // on `links` — are all on different rows for the two calls. Nothing
    // serialises them: both transactions can genuinely run concurrently
    // all the way to the `postings` insert, which is where
    // `(idempotency_scope, idempotency_key)` — identical for both, on
    // purpose — actually collides. Unlike the `getOrCreateAccount` race,
    // this conflict is guaranteed by construction (both requests target the
    // exact same key), not by hitting a microseconds-wide timing window: at
    // most one insert can ever win, so this reliably produces a genuine
    // concurrent 200/422 split without needing a held-open raw transaction
    // to force it.
    const firstMerchant = await registerMerchant(getCtx(), 'verify-concurrent-idem-race-link-a@example.test')
    const secondMerchant = await registerMerchant(getCtx(), 'verify-concurrent-idem-race-link-b@example.test')
    const firstCode = await createLink(firstMerchant.cookie, { amountKobo: 500_000, isReusable: true })
    const secondCode = await createLink(secondMerchant.cookie, { amountKobo: 500_000, isReusable: true })
    const firstReference = await initialize(firstCode, 500_000, 'racer-one@example.test')
    const secondReference = await initialize(secondCode, 500_000, 'racer-two@example.test')
    const key = idempotencyKey()

    const [first, second] = await Promise.all([verify(firstReference, key), verify(secondReference, key)])

    const statuses = [first.status, second.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 422])

    const success = first.status === 200 ? first : second
    const mismatch = first.status === 422 ? first : second
    const successBody = VerifyCheckoutResponseSchema.parse(success.body)
    expect(successBody.payment.status).toBe('success')
    expect(successBody.payment.moneyMoved).toBe(true)
    expect(ApiErrorSchema.parse(mismatch.body).code).toBe('idempotency_mismatch')

    const db = pool()
    try {
      const postings = await db.query<{ count: number }>(`select count(*)::int as count from postings where idempotency_key = $1`, [
        key,
      ])
      expect(postings.rows[0]?.count).toBe(1)
      const idempotencyRows = await db.query<{ count: number }>(`select count(*)::int as count from idempotency_keys where key = $1`, [
        key,
      ])
      expect(idempotencyRows.rows[0]?.count).toBe(1)

      // The winner's own posting/entries still balance to zero regardless
      // of which of the two references it turned out to be.
      const winningReference = successBody.payment.reference
      const entries = await db.query<{ amount_kobo: string }>(
        `select e.amount_kobo from ledger_entries e join postings p on p.id = e.posting_id where p.reference = $1`,
        [winningReference],
      )
      expect(entries.rows).toHaveLength(2)
      expect(entries.rows.reduce((total, row) => total + Number(row.amount_kobo), 0)).toBe(0)
    } finally {
      await db.end()
    }
  })

  function getCtx(): ApiTestContext {
    if (ctx === undefined) throw new Error('beforeAll did not produce a context — see its own failure above')
    return ctx
  }
})
