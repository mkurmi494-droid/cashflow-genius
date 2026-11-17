ALTER TABLE "user_workspace_state" ADD COLUMN "ai_provider" text DEFAULT 'gemini' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_workspace_state" ADD COLUMN "openrouter_api_key" text;--> statement-breakpoint
ALTER TABLE "user_workspace_state" ADD COLUMN "openrouter_model" text DEFAULT 'google/gemma-4-31b-it:free' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_workspace_state" ADD COLUMN "ai_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_workspace_state" ADD COLUMN "ai_verified_provider" text;