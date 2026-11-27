ALTER TABLE "ai_model" ADD COLUMN "fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_task" ADD COLUMN "provider_attempts" jsonb DEFAULT '[]'::jsonb NOT NULL;