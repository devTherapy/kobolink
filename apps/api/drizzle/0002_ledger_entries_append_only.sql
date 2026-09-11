-- Hand-written custom migration (drizzle-kit --custom), same reasoning as
-- 0001: no declarative pgTable() equivalent for a trigger.
--
-- Review finding (B1 round 1): the balance trigger alone (0001) only
-- re-sums the posting(s) touched by the statement that fired it. Reviewers
-- reproduced it concretely: posting pA has +500/-500 (balanced), posting
-- pB has +700/-700 (balanced); `UPDATE ledger_entries SET posting_id =
-- 'pB', amount_kobo = 0 WHERE id = 'e1'` (e1 was one of pA's two rows)
-- commits cleanly under 0001 alone, and pA now sums to -500 forever.
--
-- The ledger is append-only by design (DESIGN-SPEC.md §3: "every money
-- movement is a ledger posting," never a row a later write edits or
-- retracts) — a correction is a new, reversing posting, not a mutation of
-- an old one. So instead of trying to make the balance trigger re-check
-- every posting a statement could possibly have affected, this migration
-- makes the premise of that bug impossible: `ledger_entries` and
-- `postings` both reject UPDATE and DELETE outright, unconditionally, for
-- every row, every column. A row that was ever balanced when inserted
-- stays balanced forever, because it stays exactly as inserted forever.
--
-- Review finding (round 2): row-level triggers (`FOR EACH ROW`, as above)
-- do not fire at all for `TRUNCATE` — Postgres only fires `TRUNCATE`
-- triggers declared `FOR EACH STATEMENT`. Without a second pair of
-- triggers below, `TRUNCATE ledger_entries` (or `postings`) would silently
-- bypass every invariant in this file.

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  -- TRUNCATE fires a statement-level trigger: there is no OLD/NEW row to
  -- report, and referencing OLD below would itself error in that context.
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'append-only: TRUNCATE on %.% is not permitted', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RAISE EXCEPTION 'append-only: % on %.% is not permitted (id %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_reject_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER postings_reject_truncate
  BEFORE TRUNCATE ON postings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
