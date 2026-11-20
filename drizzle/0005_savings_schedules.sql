CREATE TABLE "savings_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"next_due_date" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "savings_schedules_owner_mode_due_idx" ON "savings_schedules" USING btree ("owner_id","mode","active","next_due_date");
