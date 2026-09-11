-- Hand-written reverse of 0000_legal_mantis.sql.
--
-- drizzle-kit has no native "down" migration, so this file — and its
-- sibling for every future migration — is the documented mechanism: one
-- `<tag>.down.sql` next to each `<tag>.sql`, applied by
-- `src/db/migrate-down.ts` in exactly reverse order, most recent first.
-- Indexes and CHECK constraints are dropped for free with their table; only
-- tables and the enum types they reference need an explicit statement here.
-- Order matters — drop the tables that hold a foreign key before the
-- tables they reference.

DROP TABLE IF EXISTS "ledger_entries";
--> statement-breakpoint
DROP TABLE IF EXISTS "links";
--> statement-breakpoint
DROP TABLE IF EXISTS "sessions";
--> statement-breakpoint
DROP TABLE IF EXISTS "ledger_accounts";
--> statement-breakpoint
DROP TABLE IF EXISTS "postings";
--> statement-breakpoint
DROP TABLE IF EXISTS "users";
--> statement-breakpoint
DROP TABLE IF EXISTS "idempotency_keys";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."ledger_account_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."link_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."posting_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."user_role";
