-- Hand-written custom migration (drizzle-kit --custom): declarative
-- pgTable() has no way to express a trigger, so this invariant cannot come
-- from `drizzle-kit generate` diffing schema/index.ts. It is still a real
-- migration — tracked in the journal, applied by the same migrator, and
-- reversible by its .down.sql sibling — the *content* is just hand-written
-- SQL instead of an auto-generated diff.
--
-- Enforces DESIGN-SPEC.md §3's core invariant in the database itself, not
-- only in application code: the `ledger_entries` rows that share one
-- `posting_id` must sum to zero. `DEFERRABLE INITIALLY DEFERRED` means the
-- check runs once at COMMIT, after every entry a transaction is going to
-- write for that posting is in place — an ordinary multi-row INSERT inside
-- one transaction (which is how B5 will always write a posting) never sees
-- a false failure on entry 1 of 2 because entry 2 hasn't landed yet.
--
-- This check alone is not the whole guarantee: re-summing only the
-- posting(s) touched by the statement that fired it is exactly right for
-- INSERT but wrong for UPDATE/DELETE (moving a row to a different posting,
-- or deleting it, would leave the posting it left unchecked — see
-- 0002_ledger_entries_append_only.sql's header for the concrete
-- reproduction). That migration closes the gap by rejecting UPDATE/DELETE
-- on this table outright, which is also why this trigger fires
-- `AFTER INSERT` only, not `INSERT OR UPDATE OR DELETE`: once mutation is
-- impossible, a trigger still watching for it is dead code that only
-- invites the two invariants to quietly drift out of sync with each
-- other. It is also not the whole guarantee against a *new*, later
-- transaction reopening an old posting with a fresh balanced pair —
-- 0003_ledger_entries_posting_same_transaction.sql closes that separately.

CREATE OR REPLACE FUNCTION check_posting_balance() RETURNS trigger AS $$
DECLARE
  balance bigint;
BEGIN
  SELECT coalesce(sum(amount_kobo), 0) INTO balance
  FROM ledger_entries
  WHERE posting_id = NEW.posting_id;

  IF balance <> 0 THEN
    RAISE EXCEPTION 'ledger_entries for posting % do not balance to zero (sum = %)', NEW.posting_id, balance
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balance_check
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_posting_balance();
