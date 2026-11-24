-- rollback-safe: 只新增表、可空列、带常量默认值的列及约束，旧代码写入仍符合新约束
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "ai_agent_turn" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"model_key" text NOT NULL,
	"pricing" jsonb NOT NULL,
	"hold_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"usage_checkpoint" jsonb,
	"usage" jsonb,
	-- squawk-ignore prefer-bigint-over-int -- reason: 每轮扣费与积分账本同用 integer
	"credits_charged" integer DEFAULT 0 NOT NULL,
	-- squawk-ignore prefer-bigint-over-int -- reason: 步数受单轮上限约束
	"steps" integer DEFAULT 0 NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_agent_turn_conversation_request_unique" UNIQUE("conversation_id","request_id"),
	CONSTRAINT "ai_agent_turn_status_valid" CHECK ("ai_agent_turn"."status" in ('running', 'completed', 'stopped', 'failed', 'expired')),
	CONSTRAINT "ai_agent_turn_usage_nonnegative" CHECK ("ai_agent_turn"."credits_charged" >= 0 and "ai_agent_turn"."steps" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "ai_model" ADD COLUMN "supports_tools" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_agent_turn" ADD CONSTRAINT "ai_agent_turn_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_turn" ADD CONSTRAINT "ai_agent_turn_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_turn" ADD CONSTRAINT "ai_agent_turn_conversation_id_ai_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_turn" ADD CONSTRAINT "ai_agent_turn_hold_id_credit_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."credit_hold"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_agent_turn_workspace_user_id_idx" ON "ai_agent_turn" USING btree ("workspace_id","user_id","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "ai_conversation"
	-- squawk-ignore constraint-missing-not-valid -- reason: 旧行恒为 chat，两个约束在同一条 ALTER TABLE 中只需扫描一次
	ADD CONSTRAINT "ai_conversation_kind_valid" CHECK ("ai_conversation"."kind" in ('chat', 'agent')),
	-- squawk-ignore constraint-missing-not-valid -- reason: 旧行的 kind 和 agent_id 恒为 chat 和 NULL
	ADD CONSTRAINT "ai_conversation_agent_pair" CHECK (("ai_conversation"."kind" = 'chat') = ("ai_conversation"."agent_id" is null));
