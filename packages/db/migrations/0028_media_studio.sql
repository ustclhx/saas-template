-- rollback-safe: 只新增 Studio 表、索引、外键和可空模型显示名，旧版本仍可读写原有表
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "studio_report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"work_id" uuid NOT NULL,
	"reporter_key" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_report_work_reporter_unique" UNIQUE("work_id","reporter_key"),
	CONSTRAINT "studio_report_reason_valid" CHECK ("studio_report"."reason" in ('sexual', 'violence', 'hate', 'copyright', 'spam', 'other')),
	CONSTRAINT "studio_report_note_length" CHECK (char_length("studio_report"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "studio_work" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"site" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"prompt" text,
	"show_prompt" boolean DEFAULT false NOT NULL,
	"model_key" text NOT NULL,
	-- squawk-ignore prefer-bigint-over-int -- reason: 图片与视频宽度使用像素，与 file 表一致
	"width" integer,
	-- squawk-ignore prefer-bigint-over-int -- reason: 图片与视频高度使用像素，与 file 表一致
	"height" integer,
	-- squawk-ignore prefer-bigint-over-int -- reason: 生成视频时长以毫秒存储，integer 可容纳约 24 天
	"duration_ms" integer,
	"visibility" text DEFAULT 'public' NOT NULL,
	"moderation" text DEFAULT 'pending' NOT NULL,
	"moderation_before_hide" text,
	"removal_reason" text,
	"featured_at" timestamp with time zone,
	-- squawk-ignore prefer-bigint-over-int -- reason: 单个作品的公开状态变更次数远低于 integer 上限
	"version" integer DEFAULT 1 NOT NULL,
	-- squawk-ignore prefer-bigint-over-int -- reason: 计数按单个作品且按举报人去重，远低于 integer 上限
	"report_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_work_file_id_unique" UNIQUE("file_id"),
	CONSTRAINT "studio_work_slug_unique" UNIQUE("slug"),
	CONSTRAINT "studio_work_kind_valid" CHECK ("studio_work"."kind" in ('image', 'video')),
	CONSTRAINT "studio_work_visibility_valid" CHECK ("studio_work"."visibility" in ('public', 'private')),
	CONSTRAINT "studio_work_moderation_valid" CHECK ("studio_work"."moderation" in ('pending', 'approved', 'hidden', 'removed')),
	CONSTRAINT "studio_work_moderation_before_hide_valid" CHECK ("studio_work"."moderation_before_hide" in ('pending', 'approved')),
	CONSTRAINT "studio_work_media_dimensions_valid" CHECK ("studio_work"."width" > 0 and "studio_work"."height" > 0 and "studio_work"."duration_ms" >= 0),
	CONSTRAINT "studio_work_version_positive" CHECK ("studio_work"."version" > 0),
	CONSTRAINT "studio_work_report_count_nonnegative" CHECK ("studio_work"."report_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_model" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "studio_report" ADD CONSTRAINT "studio_report_work_id_studio_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."studio_work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_work" ADD CONSTRAINT "studio_work_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_work" ADD CONSTRAINT "studio_work_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_work" ADD CONSTRAINT "studio_work_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_work" ADD CONSTRAINT "studio_work_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_work" ADD CONSTRAINT "studio_work_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_work_site_visibility_moderation_published_idx" ON "studio_work" USING btree ("site","visibility","moderation","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "studio_work_site_featured_idx" ON "studio_work" USING btree ("site","featured_at" DESC NULLS LAST) WHERE "studio_work"."featured_at" is not null;--> statement-breakpoint
CREATE INDEX "studio_work_workspace_id_id_idx" ON "studio_work" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "studio_work_moderation_published_idx" ON "studio_work" USING btree ("moderation","published_at");
