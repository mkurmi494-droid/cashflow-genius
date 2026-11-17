ALTER TABLE "user_workspace_state" ADD COLUMN "openai_api_key" text;--> statement-breakpoint
ALTER TABLE "user_workspace_state" ADD COLUMN "openai_model" text DEFAULT 'gpt-4o-mini' NOT NULL;