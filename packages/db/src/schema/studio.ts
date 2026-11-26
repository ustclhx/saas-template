import { newId } from '@saas/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { aiTask } from './ai.ts'
import { user } from './auth.ts'
import { file } from './files.ts'
import { organization } from './tenancy.ts'

/** 作品首次发布时才建行，取消发布后保留原 slug 和审核状态。 */
export const studioWork = pgTable(
  'studio_work',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => file.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => aiTask.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    site: text('site').notNull(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    prompt: text('prompt'),
    showPrompt: boolean('show_prompt').notNull().default(false),
    modelKey: text('model_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    visibility: text('visibility', { enum: ['public', 'private'] })
      .notNull()
      .default('public'),
    moderation: text('moderation', { enum: ['pending', 'approved', 'hidden', 'removed'] })
      .notNull()
      .default('pending'),
    moderationBeforeHide: text('moderation_before_hide', { enum: ['pending', 'approved'] }),
    removalReason: text('removal_reason'),
    featuredAt: timestamp('featured_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    reportCount: integer('report_count').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('studio_work_site_visibility_moderation_published_idx').on(
      t.site,
      t.visibility,
      t.moderation,
      t.publishedAt.desc(),
    ),
    index('studio_work_site_featured_idx')
      .on(t.site, t.featuredAt.desc())
      .where(sql`${t.featuredAt} is not null`),
    index('studio_work_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('studio_work_moderation_published_idx').on(t.moderation, t.publishedAt),
    check('studio_work_kind_valid', sql`${t.kind} in ('image', 'video')`),
    check('studio_work_visibility_valid', sql`${t.visibility} in ('public', 'private')`),
    check(
      'studio_work_moderation_valid',
      sql`${t.moderation} in ('pending', 'approved', 'hidden', 'removed')`,
    ),
    check(
      'studio_work_moderation_before_hide_valid',
      sql`${t.moderationBeforeHide} in ('pending', 'approved')`,
    ),
    check(
      'studio_work_media_dimensions_valid',
      sql`${t.width} > 0 and ${t.height} > 0 and ${t.durationMs} >= 0`,
    ),
    check('studio_work_version_positive', sql`${t.version} > 0`),
    check('studio_work_report_count_nonnegative', sql`${t.reportCount} >= 0`),
  ],
)

/** 用户当天的发布次数。作品删除后仍保留该次额度，下一次发布时清除过期记录。 */
export const studioPublication = pgTable(
  'studio_publication',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('studio_publication_user_published_idx').on(t.userId, t.publishedAt)],
)

export const STUDIO_REPORT_REASONS = [
  'sexual',
  'violence',
  'hate',
  'copyright',
  'spam',
  'other',
] as const

/** 举报键按作品去重，匿名举报只保存不可逆的网络标识。 */
export const studioReport = pgTable(
  'studio_report',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workId: uuid('work_id')
      .notNull()
      .references(() => studioWork.id, { onDelete: 'cascade' }),
    reporterKey: text('reporter_key').notNull(),
    reason: text('reason', { enum: STUDIO_REPORT_REASONS }).notNull(),
    note: text('note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('studio_report_work_reporter_unique').on(t.workId, t.reporterKey),
    check(
      'studio_report_reason_valid',
      sql`${t.reason} in ('sexual', 'violence', 'hate', 'copyright', 'spam', 'other')`,
    ),
    check('studio_report_note_length', sql`char_length(${t.note}) <= 500`),
  ],
)

export type StudioWork = typeof studioWork.$inferSelect
export type NewStudioWork = typeof studioWork.$inferInsert
export type StudioReport = typeof studioReport.$inferSelect
export type NewStudioReport = typeof studioReport.$inferInsert
