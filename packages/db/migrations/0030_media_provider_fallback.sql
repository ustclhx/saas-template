-- rollback-safe: 只新增带默认值的 jsonb 列，旧版本仍可读写 ai_model 与 ai_task
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "ai_model" ADD COLUMN "fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_task" ADD COLUMN "provider_attempts" jsonb DEFAULT '[]'::jsonb NOT NULL;
