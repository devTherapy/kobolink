import { bigint, index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { links } from './links.js'
import { postings } from './postings.js'

/**
 * B5's bridge between `checkout.initialize` and `checkout.verify`.
 *
 * The pair is deliberately two HTTP calls (`packages/contracts/README.md`:
 * "Re-resolves the link **inside the posting transaction**" — the
 * re-resolution, the simulated gateway decline check, and the resulting
 * posting all happen at *verify* time, never at initialize time). That
 * means something has to durably remember, between the two calls, what
 * `initialize` was asked to pay for — `VerifyCheckoutRequestSchema` is just
 * `{ reference }`, so the server, not the client, must be able to recover
 * `code`/`amountKobo`/`payerName`/`payerEmail` from the reference alone.
 *
 * This is *not* the "payment row with a status column" the non-negotiables
 * forbid: it carries no `status`. "Decided" is `postingId is not null`,
 * nothing else — and the outcome itself (success vs. failure, the failure
 * reason) is never read from this table, only from the `postings` row that
 * decision produced (that row's own `metadata`, written once, atomically,
 * alongside its `ledger_entries` — see `payments.service.ts`). This table
 * only answers "what was asked for" and "has it been decided yet"; the
 * ledger remains the only authority on what actually happened.
 *
 * Why not just make `postings` carry the pending state instead of a new
 * table? Because a posting's `ledger_entries` must be inserted in the *same*
 * transaction that created the posting (`ledger_entries_posting_same_
 * transaction`, `drizzle/0003...sql`) — a posting opened at `initialize`
 * time could never legally receive `verify`-time entries. So the posting
 * (and, for a success, its entries) can only be born at `verify`, in one
 * transaction, once the outcome is known; this table is what lets `verify`
 * find its way back to that outcome, and — via `postingId`, claimed with a
 * `SELECT ... FOR UPDATE` — what makes deciding a `reference` exactly once
 * safe under concurrent replays.
 *
 * Ordinary table: no append-only trigger. Unlike `postings`/`ledger_entries`,
 * this row legitimately changes once, from "not yet decided" to "decided",
 * as a normal `UPDATE` — it never itself represents a balance or a money
 * movement, so the append-only invariant that protects the ledger has
 * nothing to protect here.
 */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    reference: varchar('reference', { length: 32 }).primaryKey(),
    linkCode: varchar('link_code', { length: 8 })
      .notNull()
      .references(() => links.code),
    // bigint/mode:number — same bound reasoning as ledger_entries.amount_kobo:
    // AmountKoboSchema caps this far inside Number.MAX_SAFE_INTEGER.
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    payerName: varchar('payer_name', { length: 80 }).notNull(),
    payerEmail: varchar('payer_email', { length: 254 }).notNull(),
    /** Set exactly once, the moment `verify` decides this reference's outcome. */
    postingId: varchar('posting_id', { length: 64 }).references(() => postings.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('checkout_sessions_link_code_idx').on(table.linkCode)],
)
