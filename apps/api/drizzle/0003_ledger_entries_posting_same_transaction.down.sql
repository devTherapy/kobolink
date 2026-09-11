DROP TRIGGER IF EXISTS ledger_entries_posting_same_transaction ON ledger_entries;
--> statement-breakpoint
DROP FUNCTION IF EXISTS check_posting_is_current_transaction();
