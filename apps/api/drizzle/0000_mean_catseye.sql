CREATE TYPE "public"."ledger_account_kind" AS ENUM('wallet', 'merchant_receivable', 'external_funding');--> statement-breakpoint
CREATE TYPE "public"."link_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."posting_kind" AS ENUM('link_payment', 'transfer', 'topup');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('merchant', 'customer');--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" varchar(128) NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"owner_user_id" varchar(64),
	"kind" "ledger_account_kind" NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_external_funding_ownerless" CHECK (("ledger_accounts"."kind" = 'external_funding') = ("ledger_accounts"."owner_user_id" is null)),
	CONSTRAINT "ledger_accounts_currency_ngn" CHECK ("ledger_accounts"."currency" = 'NGN')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"posting_id" varchar(64) NOT NULL,
	"account_id" varchar(64) NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_kobo_nonzero" CHECK ("ledger_entries"."amount_kobo" <> 0)
);
--> statement-breakpoint
CREATE TABLE "links" (
	"code" varchar(8) PRIMARY KEY NOT NULL,
	"merchant_user_id" varchar(64) NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" varchar(500),
	"amount_kobo" bigint,
	"status" "link_status" DEFAULT 'active' NOT NULL,
	"is_reusable" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "links_amount_kobo_positive" CHECK ("links"."amount_kobo" is null or "links"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" "posting_kind" NOT NULL,
	"reference" varchar(64) NOT NULL,
	"idempotency_scope" varchar(128),
	"idempotency_key" varchar(128),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"role" "user_role" NOT NULL,
	"email" varchar(254) NOT NULL,
	"phone" varchar(20),
	"password_hash" text NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_merchant_user_id_users_id_fk" FOREIGN KEY ("merchant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_accounts_owner_idx" ON "ledger_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_owner_kind_unique" ON "ledger_accounts" USING btree ("owner_user_id","kind") WHERE "ledger_accounts"."owner_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_external_funding_singleton" ON "ledger_accounts" USING btree ("kind") WHERE "ledger_accounts"."kind" = 'external_funding';--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_posting_idx" ON "ledger_entries" USING btree ("posting_id");--> statement-breakpoint
CREATE INDEX "links_merchant_created_idx" ON "links" USING btree ("merchant_user_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "postings_reference_unique" ON "postings" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "postings_idempotency_scope_key_unique" ON "postings" USING btree ("idempotency_scope","idempotency_key") WHERE "postings"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_unique" ON "users" USING btree ("phone") WHERE "users"."phone" is not null;