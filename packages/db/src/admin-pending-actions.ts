import {
  bulkJobOutcome,
  bulkJobSkipped,
  checkBulkJobTime,
  cutoffBefore,
} from '@saas/shared/bulk-job'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { bulkJobFloorSql, probeBulkJob } from './bulk-job.ts'
import type { Database } from './client.ts'
import { adminPendingAction } from './schema/platform.ts'

/**
 * 待确认记录（add-admin-step-up 决策 7）的每日清理，挂在现有 03:00 UTC 触发器上，不新增定时任务。
 * 平时由读取、列表与确认惰性置为过期；这里只兜底残留行并删除 30 天前的终态记录。
 */

export const ADMIN_PENDING_ACTION_CLEANUP_CAP = 500
export const ADMIN_PENDING_ACTION_RETENTION_DAYS = 30
const MIN_RETENTION_MS = 86_400_000

const TERMINAL = ['done', 'failed', 'rejected', 'expired'] as const

/** 终态记录的结束时间：决定时间，过期记录没有决定时间时取到期时间 */
const endedAt = sql`coalesce(${adminPendingAction.decidedAt}, ${adminPendingAction.expiresAt})`

/**
 * 过期的 pending 置为 expired 并清空密文（数据密钥在缓存中已随 TTL 失效，这里只清库内密文）；
 * 再删除结束时间早于「数据库时钟 − 30 天」的终态记录。两步合计每轮最多 500 行，均按时间升序；
 * 时间早于下限的终态记录不删除并告警。
 */
export async function cleanupAdminPendingActions(
  db: Database,
  now = new Date(),
  {
    cap = ADMIN_PENDING_ACTION_CLEANUP_CAP,
    retentionDays = ADMIN_PENDING_ACTION_RETENTION_DAYS,
  }: { cap?: number; retentionDays?: number } = {},
) {
  const terminal = inArray(adminPendingAction.status, [...TERMINAL])
  const { dbNow, outOfRange } = await probeBulkJob(
    db,
    sql`select count(*) from ${adminPendingAction} where ${terminal} and ${endedAt} < ${bulkJobFloorSql}`,
  )
  const cutoff = cutoffBefore(dbNow, retentionDays * 86_400_000)
  const verdict = checkBulkJobTime({
    appNow: now,
    dbNow,
    cutoffs: [{ at: cutoff, minRetentionMs: MIN_RETENTION_MS }],
  })
  if (!verdict.ok) return { expired: 0, deleted: 0, guard: bulkJobSkipped(verdict.reason) }

  const overdue = db
    .select({ id: adminPendingAction.id })
    .from(adminPendingAction)
    .where(
      and(
        eq(adminPendingAction.status, 'pending'),
        lte(adminPendingAction.expiresAt, sql`${dbNow.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(asc(adminPendingAction.expiresAt), asc(adminPendingAction.id))
    .limit(cap)
  const expired = await db
    .update(adminPendingAction)
    .set({ status: 'expired', secretCiphertext: null })
    .where(and(inArray(adminPendingAction.id, overdue), eq(adminPendingAction.status, 'pending')))
    .returning({ id: adminPendingAction.id })

  const remaining = cap - expired.length
  const deleted =
    remaining > 0
      ? await db
          .delete(adminPendingAction)
          .where(
            and(
              inArray(
                adminPendingAction.id,
                db
                  .select({ id: adminPendingAction.id })
                  .from(adminPendingAction)
                  .where(
                    and(
                      terminal,
                      sql`${endedAt} >= ${bulkJobFloorSql}`,
                      sql`${endedAt} < ${cutoff.toISOString()}::timestamptz`,
                    ),
                  )
                  .orderBy(asc(endedAt), asc(adminPendingAction.id))
                  .limit(remaining),
              ),
              terminal,
            ),
          )
          .returning({ id: adminPendingAction.id })
      : []
  const processed = expired.length + deleted.length
  return {
    expired: expired.length,
    deleted: deleted.length,
    guard: bulkJobOutcome({ processed, cap, outOfRange }),
  }
}
