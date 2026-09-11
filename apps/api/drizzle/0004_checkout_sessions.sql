CREATE TABLE "checkout_sessions" (
	"reference" varchar(32) PRIMARY KEY NOT NULL,
	"link_code" varchar(8) NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"payer_name" varchar(80) NOT NULL,
	"payer_email" varchar(254) NOT NULL,
	"posting_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_link_code_links_code_fk" FOREIGN KEY ("link_code") REFERENCES "public"."links"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_sessions_link_code_idx" ON "checkout_sessions" USING btree ("link_code");