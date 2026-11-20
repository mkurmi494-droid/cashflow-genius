CREATE TABLE "lend_borrow" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"direction" text NOT NULL,
	"person" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" text NOT NULL,
	"due_date" text,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"settled_date" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lend_borrow_owner_mode_status_due_idx" ON "lend_borrow" USING btree ("owner_id","mode","status","due_date");
