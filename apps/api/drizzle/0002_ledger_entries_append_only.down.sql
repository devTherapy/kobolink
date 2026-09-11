DROP TRIGGER IF EXISTS postings_reject_truncate ON postings;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_entries_reject_truncate ON ledger_entries;
--> statement-breakpoint
DROP TRIGGER IF EXISTS postings_append_only ON postings;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_ledger_mutation();
