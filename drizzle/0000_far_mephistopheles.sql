CREATE TABLE "activity_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"title" text DEFAULT 'Conversation' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text DEFAULT 'verify' NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"verified" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_users_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"category" text NOT NULL,
	"monthly_limit_cents" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"industry" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'India' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"opening_balance_cents" bigint DEFAULT 0 NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"owner_name" text DEFAULT '' NOT NULL,
	"owner_email" text DEFAULT '' NOT NULL,
	"owner_phone" text DEFAULT '' NOT NULL,
	"gst_rate_bp" integer DEFAULT 1800 NOT NULL,
	"gst_inclusive" integer DEFAULT 1 NOT NULL,
	"eligible_expense_pct" integer DEFAULT 60 NOT NULL,
	"onboarded" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'expense' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emi_instalments" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"seq" integer NOT NULL,
	"due_date" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_date" text,
	"transaction_id" text,
	CONSTRAINT "emi_instalments_transaction_id_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
CREATE TABLE "emi_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_contact" text DEFAULT '' NOT NULL,
	"product" text DEFAULT '' NOT NULL,
	"total_cents" bigint NOT NULL,
	"down_payment_cents" bigint DEFAULT 0 NOT NULL,
	"instalment_count" integer NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"first_due_date" text NOT NULL,
	"demo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"txn_ids_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"qty_milli" integer DEFAULT 1000 NOT NULL,
	"unit_price_cents" bigint DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"number" text NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_email" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issue_date" text NOT NULL,
	"due_date" text NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"tax_bp" integer DEFAULT 1800 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"demo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"title" text DEFAULT 'Untitled note' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"tags" text DEFAULT '' NOT NULL,
	"pinned" integer DEFAULT 0 NOT NULL,
	"source_module" text DEFAULT '' NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"demo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_cashflows" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"type" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"next_date" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"demo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"target_cents" bigint NOT NULL,
	"target_date" text NOT NULL,
	"demo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"direction" text DEFAULT 'deposit' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scam_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"verdict" text NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"reasons_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"name" text NOT NULL,
	"params" text DEFAULT '{}' NOT NULL,
	"demo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text DEFAULT 'legacy' NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"counterparty" text DEFAULT '' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" text NOT NULL,
	"payment_method" text DEFAULT '' NOT NULL,
	"invoice_id" text,
	"emi_instalment_id" text,
	"demo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_invoice_id_unique" UNIQUE("invoice_id"),
	CONSTRAINT "transactions_emi_instalment_id_unique" UNIQUE("emi_instalment_id")
);
--> statement-breakpoint
CREATE TABLE "trash_items" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"mode" text DEFAULT 'business' NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_workspace_state" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"active_mode" text DEFAULT 'business' NOT NULL,
	"cursor_style" text DEFAULT 'blue' NOT NULL,
	"tour_dismissed" integer DEFAULT 0 NOT NULL,
	"gemini_api_key" text
);
