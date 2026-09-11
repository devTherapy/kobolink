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

CREATE OR REPLACE FUNCTION check_posting_balance() RETURNS trigger AS $$
DECLARE
  affected_posting_id varchar(64);
  balance bigint;
BEGIN
  affected_posting_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.posting_id ELSE NEW.posting_id END;

  SELECT coalesce(sum(amount_kobo), 0) INTO balance
  FROM ledger_entries
  WHERE posting_id = affected_posting_id;

  IF balance <> 0 THEN
    RAISE EXCEPTION 'ledger_entries for posting % do not balance to zero (sum = %)', affected_posting_id, balance
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_posting_balance();
