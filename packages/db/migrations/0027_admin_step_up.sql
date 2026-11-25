-- rollback-safe: 只新增后台重新验证与待确认操作两张表及其索引和外键，旧版本不访问它们
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "admin_pending_action" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"action" text NOT NULL,
	"token_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"display" jsonb NOT NULL,
	"secret_ciphertext" "bytea",
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_step_up" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_totp_step" bigint
);
--> statement-breakpoint
ALTER TABLE "admin_pending_action" ADD CONSTRAINT "admin_pending_action_token_id_admin_api_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."admin_api_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_pending_action" ADD CONSTRAINT "admin_pending_action_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_pending_action" ADD CONSTRAINT "admin_pending_action_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_step_up" ADD CONSTRAINT "admin_step_up_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_step_up" ADD CONSTRAINT "admin_step_up_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_pending_action_requested_by_status_idx" ON "admin_pending_action" USING btree ("requested_by","status");--> statement-breakpoint
CREATE INDEX "admin_pending_action_token_id_status_idx" ON "admin_pending_action" USING btree ("token_id","status");--> statement-breakpoint
CREATE INDEX "admin_step_up_user_id_idx" ON "admin_step_up" USING btree ("user_id");