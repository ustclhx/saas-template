import { aiMessageFeedback, type Database } from '@saas/db'
import { AppError } from '@saas/shared'
import { and, count, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AdminActionScope } from './action.ts'
import { ADMIN_PAGE_SIZE } from './list.ts'

/**
 * 后台 AI 回复反馈（add-subject-chat tasks.md 4.1，specs/admin-console「AI 回复反馈列表」「满意率统计」）。
 * 只读评分与反馈文字，不联查对话正文或对象上下文；删除经 adminAction 写审计（不含反馈文字）。
 */

const date = z.iso.date()

export const feedbackSearchSchema = z
  .object({
    offset: z.number().int().min(0).max(100_000),
    // 地址栏中的非法评分值按未筛选处理
    rating: z
      .string()
      .max(16)
      .optional()
      .transform((value) => (value === 'up' || value === 'down' ? value : undefined)),
    model: z.string().max(200).optional(),
    subjectType: z.string().max(64).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Start date must precede end date',
  })
export type FeedbackSearch = z.infer<typeof feedbackSearchSchema>

/** 未选日期时统计最近 30 天（含今天，UTC） */
const STATS_DAYS = 30
const DAY_MS = 86_400_000

function range(input: { from?: string | undefined; to?: string | undefined }, now: Date) {
  const to = input.to ?? now.toISOString().slice(0, 10)
  const from =
    input.from ??
    new Date(Date.parse(`${to}T00:00:00Z`) - (STATS_DAYS - 1) * DAY_MS).toISOString().slice(0, 10)
  return {
    from,
    to,
    where: and(
      gte(aiMessageFeedback.createdAt, new Date(`${from}T00:00:00Z`)),
      lt(aiMessageFeedback.createdAt, new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS)),
    ) as SQL,
  }
}

/** 「无对象」在筛选中用 `-` 表示，统计中归为一组 */
export const NO_SUBJECT = '-'

export async function listFeedback(db: Database, input: FeedbackSearch) {
  const data = feedbackSearchSchema.parse(input)
  const where = and(
    data.rating ? eq(aiMessageFeedback.rating, data.rating) : undefined,
    data.model ? eq(aiMessageFeedback.modelKey, data.model) : undefined,
    data.subjectType
      ? data.subjectType === NO_SUBJECT
        ? sql`${aiMessageFeedback.subjectType} is null`
        : eq(aiMessageFeedback.subjectType, data.subjectType)
      : undefined,
    data.from ? gte(aiMessageFeedback.createdAt, new Date(`${data.from}T00:00:00Z`)) : undefined,
    data.to
      ? lt(aiMessageFeedback.createdAt, new Date(Date.parse(`${data.to}T00:00:00Z`) + DAY_MS))
      : undefined,
  )
  const rows = await db
    .select({
      id: aiMessageFeedback.id,
      createdAt: aiMessageFeedback.createdAt,
      workspaceId: aiMessageFeedback.workspaceId,
      messageId: aiMessageFeedback.messageId,
      rating: aiMessageFeedback.rating,
      comment: aiMessageFeedback.comment,
      modelKey: aiMessageFeedback.modelKey,
      subjectType: aiMessageFeedback.subjectType,
    })
    // biome-ignore lint/plugin: 已通过实时管理员守卫，后台反馈列表允许跨空间查询。
    .from(aiMessageFeedback)
    .where(where)
    .orderBy(desc(aiMessageFeedback.id))
    .offset(data.offset)
    .limit(ADMIN_PAGE_SIZE + 1)
  return { rows: rows.slice(0, ADMIN_PAGE_SIZE), hasMore: rows.length > ADMIN_PAGE_SIZE }
}

export interface SatisfactionRow {
  readonly key: string
  readonly up: number
  readonly down: number
  /** up / (up + down) */
  readonly rate: number
}

/** 按模型与对象类型分组的满意率；没有评分的分组不出现 */
export async function feedbackStats(
  db: Database,
  input: { from?: string | undefined; to?: string | undefined },
  now = new Date(),
) {
  const { from, to, where } = range(input, now)
  const group = async (column: SQL) => {
    const rows = await db
      .select({
        key: sql<string>`coalesce(${column}, ${NO_SUBJECT})`,
        up: count(sql`case when ${aiMessageFeedback.rating} = 'up' then 1 end`),
        down: count(sql`case when ${aiMessageFeedback.rating} = 'down' then 1 end`),
      })
      // biome-ignore lint/plugin: 已通过实时管理员守卫，满意率统计按全平台汇总。
      .from(aiMessageFeedback)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`)
    return rows.map(
      (row): SatisfactionRow => ({ ...row, rate: row.up / Math.max(1, row.up + row.down) }),
    )
  }
  const [byModel, bySubject] = await Promise.all([
    group(sql`${aiMessageFeedback.modelKey}`),
    group(sql`${aiMessageFeedback.subjectType}`),
  ])
  return { from, to, byModel, bySubject }
}

/** 删除单条反馈；审计只记 ID、空间、模型、对象类型与评分，不记反馈文字 */
export async function deleteFeedback(scope: AdminActionScope, id: string) {
  const [row] = await scope.tx
    // biome-ignore lint/plugin: 平台管理员按反馈 ID 删除，空间来自被删行并写入审计。
    .delete(aiMessageFeedback)
    .where(eq(aiMessageFeedback.id, id))
    .returning({
      workspaceId: aiMessageFeedback.workspaceId,
      modelKey: aiMessageFeedback.modelKey,
      subjectType: aiMessageFeedback.subjectType,
      rating: aiMessageFeedback.rating,
    })
  if (!row) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  await scope.audit({
    action: 'ai.feedback.delete',
    targetType: 'ai_message_feedback',
    targetId: id,
    workspaceId: row.workspaceId,
    meta: { modelKey: row.modelKey, subjectType: row.subjectType, rating: row.rating },
  })
  return { deleted: true }
}
