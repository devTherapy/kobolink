-- Hand-written custom migration (drizzle-kit --custom), same reasoning as
-- 0001/0002: no declarative pgTable() equivalent for a trigger.
--
-- Review finding (round 2): 0001's balance trigger and 0002's append-only
-- triggers together stop a *posting's own* entries from ever being edited,
-- moved or deleted — but they do not stop a brand-new transaction from
-- INSERTing a brand-new, internally-balanced pair of entries against an
-- *old*, already-committed `posting_id`. That pair sums to zero on its
-- own, so 0001's check passes; nothing is UPDATEd or DELETEd, so 0002's
-- checks never fire. The posting's *meaning* still changes after the
-- fact — a `link_payment` posting that meant "₦5,000 paid, once" now also
-- carries a second, later, unrelated ₦5,000 movement nobody asked for.
--
-- The fix: a `ledger_entries` row may only be inserted against a posting
-- that was *itself* created in the same transaction as this insert.
-- `postings.created_at` is set by `defaultNow()`, which in Postgres
-- resolves to `transaction_timestamp()` — the current transaction's start
-- time, constant for that transaction's whole duration regardless of how
-- much wall-clock time elapses inside it. So a posting row created earlier
-- in *this* transaction has `created_at = transaction_timestamp()`
-- exactly; a posting from any other (necessarily already-committed —
-- postings are append-only, so nothing left it uncommitted and visible)
-- transaction has an earlier `created_at`, strictly less than this
-- transaction's `transaction_timestamp()`. B5's real write path — create
-- the posting, then insert its entries, all in one transaction — satisfies
-- this by construction; only a second transaction reopening an old
-- posting_id is rejected.

CREATE OR REPLACE FUNCTION check_posting_is_current_transaction() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM postings
    WHERE id = NEW.posting_id AND created_at = transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'ledger_entries.posting_id % does not reference a posting created in the current transaction — postings are immutable and cannot be reopened by a later transaction', NEW.posting_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_posting_same_transaction
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION check_posting_is_current_transaction();
