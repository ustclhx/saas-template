import {
  type Database,
  notFound,
  type StudioReport,
  scoped,
  studioReport,
  studioWork,
} from '@saas/db'
import { AppError } from '@saas/shared'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { StudioKind } from '../kinds.ts'
import { getPublicWorkForReport } from './public-works.ts'
import { type InvalidateStudioWork, invalidateStudioWork } from './work-invalidation.ts'

export const STUDIO_ANONYMOUS_REPORT_LIMIT = 10

export interface StudioReportInput {
  site: string
  kinds: readonly StudioKind[]
  workId: string
  reporterKey: `u:${string}` | `ip:${string}`
  reason: StudioReport['reason']
  note?: string | undefined
}

export async function submitStudioReport(
  db: Database,
  input: StudioReportInput,
  options: { hideThreshold: number; invalidate?: InvalidateStudioWork | undefined },
) {
  const { workId, reporterKey, reason, note, site, kinds } = input
  if (!z.uuid().safeParse(workId).success) throw notFound()
  const hidden = await db.transaction(async (tx) => {
    const work = await getPublicWorkForReport(tx, input)
    if (!work) {
      // 触发隐藏的举报可能因响应丢失而重试。只向原举报人确认已收件。
      const [existing] = await tx
        .select({ id: studioReport.id })
        .from(studioReport)
        .innerJoin(studioWork, eq(studioWork.id, studioReport.workId))
        .where(
          and(
            eq(studioReport.workId, workId),
            eq(studioReport.reporterKey, reporterKey),
            eq(studioWork.site, site),
            inArray(studioWork.kind, kinds),
            eq(studioWork.visibility, 'public'),
            eq(studioWork.moderation, 'hidden'),
          ),
        )
        .limit(1)
      if (existing) return
      throw notFound()
    }

    // 拿到作品行锁后才开始计时，等待锁的时间不占用本次举报的窗口。
    const [inserted] = await tx
      .insert(studioReport)
      .values({ workId, reporterKey, reason, note, createdAt: sql`clock_timestamp()` })
      .onConflictDoNothing({ target: [studioReport.workId, studioReport.reporterKey] })
      .returning({ createdAt: sql<string>`${studioReport.createdAt}::text` })
    if (!inserted) return

    const anonymous = reporterKey.startsWith('ip:')
    const [counts] = await tx
      .select({
        active: sql<number>`count(*) filter (where ${studioReport.resolvedAt} is null)`.mapWith(
          Number,
        ),
        anonymous: anonymous
          ? sql<number>`count(*) filter (where ${like(studioReport.reporterKey, 'ip:%')} and ${studioReport.createdAt} > ${inserted.createdAt}::timestamptz - interval '1 hour')`.mapWith(
              Number,
            )
          : sql<number>`0`,
      })
      .from(studioReport)
      .where(eq(studioReport.workId, workId))

    // 返回错误会回滚插入，同一作品并发永远无法越过上限。
    if ((counts?.anonymous ?? 0) > STUDIO_ANONYMOUS_REPORT_LIMIT)
      throw new AppError('STUDIO_REPORT_LIMIT', 'Too many reports for this work', { status: 429 })

    // 累计值保留历史。恢复后的自动隐藏只看未处理的举报。
    const hide = (counts?.active ?? 0) >= options.hideThreshold
    await scoped(tx, work.workspaceId).updateById(studioWork, workId, {
      reportCount: work.reportCount + 1,
      ...(hide && {
        moderation: 'hidden',
        moderationBeforeHide: sql`${studioWork.moderation}`,
        version: work.version + 1,
      }),
    })
    if (hide) return { id: work.id, slug: work.slug, version: work.version, site }
  })

  if (hidden) await invalidateStudioWork(hidden, options.invalidate)
}
