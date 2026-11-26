import {
  type Database,
  file,
  notFound,
  organization,
  studioReport,
  studioWork,
  user,
} from '@saas/db'
import type { Storage } from '@saas/storage'
import { ADMIN_PAGE_SIZE } from '@web/features/admin/list.ts'
import { and, asc, count, desc, eq, exists, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { type studioReviewCursor, studioReviewQueueSchema } from './moderation-input.ts'

const pendingReview = and(eq(studioWork.moderation, 'pending'), eq(studioWork.visibility, 'public'))
const hiddenReview = eq(studioWork.moderation, 'hidden')

export async function listStudioReviewQueue(
  db: Database,
  input: z.input<typeof studioReviewQueueSchema>,
  pagination?: { cursor: z.output<typeof studioReviewCursor> | undefined },
) {
  const { queue, offset, site } = studioReviewQueueSchema.parse(input)
  const predicates = {
    pending: pendingReview,
    reported: and(
      gt(studioWork.reportCount, 0),
      exists(
        db
          .select({ id: studioReport.id })
          .from(studioReport)
          .where(and(eq(studioReport.workId, studioWork.id), isNull(studioReport.resolvedAt))),
      ),
    ),
    hidden: hiddenReview,
    removed: eq(studioWork.moderation, 'removed'),
  }
  const order = queue === 'pending' ? asc : desc
  const position = sql`(${studioWork.publishedAt}, ${studioWork.id})`
  const cursor = pagination?.cursor
  const after = cursor && sql`(${cursor[1]}::timestamptz, ${cursor[2]}::uuid)`

  const page = await db
    .select({
      id: studioWork.id,
      site: studioWork.site,
      slug: studioWork.slug,
      title: studioWork.title,
      prompt: studioWork.prompt,
      kind: studioWork.kind,
      modelKey: studioWork.modelKey,
      authorId: user.id,
      authorName: user.name,
      workspaceId: organization.id,
      workspaceName: organization.name,
      visibility: studioWork.visibility,
      moderation: studioWork.moderation,
      removalReason: studioWork.removalReason,
      featuredAt: studioWork.featuredAt,
      reportCount: studioWork.reportCount,
      publishedAt: studioWork.publishedAt,
      reviewedAt: studioWork.reviewedAt,
      // 数据库时间戳含微秒，用完整精度保证相邻作品可以连续翻页。
      cursorAt: sql<string>`to_char(${studioWork.publishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    // biome-ignore lint/plugin: 平台管理员的审核队列可跨空间读取作品。
    .from(studioWork)
    .innerJoin(user, eq(user.id, studioWork.userId))
    .innerJoin(organization, eq(organization.id, studioWork.workspaceId))
    .where(
      and(
        predicates[queue],
        site === undefined ? undefined : eq(studioWork.site, site),
        after && (queue === 'pending' ? sql`${position} > ${after}` : sql`${position} < ${after}`),
      ),
    )
    .orderBy(order(studioWork.publishedAt), order(studioWork.id))
    .offset(offset)
    .limit(ADMIN_PAGE_SIZE + 1)

  const rows = page.slice(0, ADMIN_PAGE_SIZE)
  const summary = rows.length
    ? await db
        .select({
          workId: studioReport.workId,
          reason: studioReport.reason,
          total: count(),
          unresolved: count(sql`case when ${studioReport.resolvedAt} is null then 1 end`),
        })
        .from(studioReport)
        .where(
          inArray(
            studioReport.workId,
            rows.map(({ id }) => id),
          ),
        )
        .groupBy(studioReport.workId, studioReport.reason)
        .orderBy(studioReport.reason)
    : []
  const reasonsByWork = new Map<string, Omit<(typeof summary)[number], 'workId'>[]>()
  for (const { workId, ...reason } of summary) {
    const reasons = reasonsByWork.get(workId) ?? []
    reasons.push(reason)
    reasonsByWork.set(workId, reasons)
  }

  const hasMore = page.length > ADMIN_PAGE_SIZE
  const last = hasMore ? rows.at(-1) : undefined
  return {
    rows: rows.map(({ cursorAt: _, ...row }) => ({
      ...row,
      reportReasons: reasonsByWork.get(row.id) ?? [],
    })),
    hasMore,
    ...(pagination && { nextCursor: last ? `${queue}~${last.cursorAt}~${last.id}` : null }),
  }
}

export async function countStudioReviewQueue(db: Database) {
  const [row] = await db
    .select({ total: count() })
    // biome-ignore lint/plugin: 平台管理员导航汇总待审核与已隐藏作品。
    .from(studioWork)
    .where(or(pendingReview, hiddenReview))
  return row?.total ?? 0
}

export async function getStudioReviewMedia(
  db: Database,
  storage: Pick<Storage, 'presignDownload'>,
  workId: string,
) {
  const [media] = await db
    .select({ key: file.r2Key, mime: file.mime })
    // biome-ignore lint/plugin: 平台管理员可预览任意空间的待审核、隐藏或下架作品。
    .from(studioWork)
    .innerJoin(
      file,
      and(
        eq(file.id, studioWork.fileId),
        eq(file.workspaceId, studioWork.workspaceId),
        eq(file.sourceTaskId, studioWork.taskId),
      ),
    )
    .where(
      and(
        eq(studioWork.id, workId),
        eq(file.purpose, 'ai_output'),
        eq(file.status, 'ready'),
        isNull(file.deletedAt),
      ),
    )
  if (!media) throw notFound()
  return { url: await storage.presignDownload(media.key), mime: media.mime }
}
