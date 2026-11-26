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
import { studioReviewQueueSchema } from './moderation-input.ts'

const pendingReview = and(eq(studioWork.moderation, 'pending'), eq(studioWork.visibility, 'public'))
const hiddenReview = eq(studioWork.moderation, 'hidden')

function queuePredicates(db: Database) {
  return {
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
}

export async function listStudioReviewQueue(
  db: Database,
  input: z.input<typeof studioReviewQueueSchema>,
) {
  const { queue, offset, site } = studioReviewQueueSchema.parse(input)
  const predicates = queuePredicates(db)

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
      version: studioWork.version,
      reportCount: studioWork.reportCount,
      publishedAt: studioWork.publishedAt,
      reviewedAt: studioWork.reviewedAt,
    })
    // biome-ignore lint/plugin: 平台管理员的审核队列可跨空间读取作品。
    .from(studioWork)
    .innerJoin(user, eq(user.id, studioWork.userId))
    .innerJoin(organization, eq(organization.id, studioWork.workspaceId))
    .where(and(predicates[queue], site === undefined ? undefined : eq(studioWork.site, site)))
    .orderBy(
      ...(queue === 'pending'
        ? [asc(studioWork.publishedAt), asc(studioWork.id)]
        : [desc(studioWork.publishedAt), desc(studioWork.id)]),
    )
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

  return {
    rows: rows.map((row) => ({
      ...row,
      reportReasons: reasonsByWork.get(row.id) ?? [],
    })),
    hasMore: page.length > ADMIN_PAGE_SIZE,
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

/** 审核页分栏上的数量：待审核、被举报与已隐藏（已下架不显示数量，与设计稿一致） */
export async function countStudioReviewTabs(db: Database) {
  const predicates = queuePredicates(db)
  const [row] = await db
    .select({
      pending: count(sql`case when ${predicates.pending} then 1 end`),
      reported: count(sql`case when ${predicates.reported} then 1 end`),
      hidden: count(sql`case when ${predicates.hidden} then 1 end`),
    })
    // biome-ignore lint/plugin: 平台管理员的审核分栏汇总跨空间作品。
    .from(studioWork)
    .where(or(predicates.pending, predicates.reported, predicates.hidden))
  return { pending: row?.pending ?? 0, reported: row?.reported ?? 0, hidden: row?.hidden ?? 0 }
}
