CREATE TABLE "financial_insight_runs" (
	"owner_id" text NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"insight_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "financial_insight_runs_owner_id_mode_pk" PRIMARY KEY("owner_id","mode")
);
--> statement-breakpoint
CREATE TABLE "financial_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"insight_type" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"recommended_action" text DEFAULT '' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"insight_key" text NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "financial_insights_owner_mode_key_active_unique" ON "financial_insights" USING btree ("owner_id","mode","insight_key") WHERE "status" = 'active';