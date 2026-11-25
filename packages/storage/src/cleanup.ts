import { WORKSPACE_RETENTION_DAYS } from '@saas/auth'
import { bulkJobFloorSql, type Database, file, organization, probeBulkJob, scoped } from '@saas/db'
import {
  BULK_JOB_TIME_FLOOR,
  type BulkJobOutcome,
  bulkJobOutcome,
  bulkJobSkipped,
  checkBulkJobTime,
  cutoffBefore,
} from '@saas/shared/bulk-job'
import { log } from '@saas/shared/log'
import { and, asc, eq, gte, isNotNull, lt, lte, type SQL, sql } from 'drizzle-orm'
import type { Storage } from './storage.ts'

const PENDING_RETENTION_MS = 60 * 60 * 1000
/** 最小保留期：保留期常量被误改时整轮不执行（add-ops-safeguards D3） */
const PENDING_MIN_RETENTION_MS = 10 * 60 * 1000
const WORKSPACE_MIN_RETENTION_MS = 86_400_000
/** 每轮上限（add-ops-safeguards D2）：空间数与对象删除数，先到为准；剩余留到下一轮 */
export const FILES_CLEANUP_WORKSPACE_CAP = 20
export const FILES_CLEANUP_OBJECT_CAP = 500

export interface FilesCleanupOptions {
  /** 应用时钟，只与数据库时钟对照；截止时间以数据库时钟计算 */
  readonly now?: Date
  /** 以下仅供测试替换常量，验证误配时整轮不执行 */
  readonly pendingRetentionMs?: number
  readonly workspaceRetentionDays?: number
  readonly workspaceCap?: number
  readonly objectCap?: number
}

/**
 * 清理未确认上传、超过空间保留期的文件与废弃的 AI 产出；对象删除失败时保留记录供 Cron 重试。
 * 每轮最多 20 个空间、500 个对象，空间按最早到期的文件排序；只处理时间在下限与数据库当前时间之间的行。
 */
export async function cleanupFiles(
  db: Database,
  bucket: Pick<Storage, 'delete'>,
  options: FilesCleanupOptions = {},
): Promise<{ deleted: number; failed: number; guard: BulkJobOutcome }> {
  const workspaceCap = options.workspaceCap ?? FILES_CLEANUP_WORKSPACE_CAP
  const objectCap = options.objectCap ?? FILES_CLEANUP_OBJECT_CAP
  const pendingRetentionMs = options.pendingRetentionMs ?? PENDING_RETENTION_MS
  const workspaceRetentionMs =
    (options.workspaceRetentionDays ?? WORKSPACE_RETENTION_DAYS) * 86_400_000
  // 区间外的候选：时间早于下限，或废弃产出的删除时间在未来；只计数告警，不删除
  const { dbNow, outOfRange } = await probeBulkJob(
    db,
    sql`select count(*) from file f join organization o on o.id=f.workspace_id
      where (f.status='pending' and f.created_at<${bulkJobFloorSql})
        or o.deleted_at<${bulkJobFloorSql}
        or (f.purpose='ai_output' and f.status='ready' and f.deleted_at is not null
          and (f.deleted_at<${bulkJobFloorSql} or f.deleted_at>now()))`,
  )
  const pendingBefore = cutoffBefore(dbNow, pendingRetentionMs)
  const workspaceBefore = cutoffBefore(dbNow, workspaceRetentionMs)
  const verdict = checkBulkJobTime({
    appNow: options.now ?? new Date(),
    dbNow,
    cutoffs: [
      { at: pendingBefore, minRetentionMs: PENDING_MIN_RETENTION_MS },
      { at: workspaceBefore, minRetentionMs: WORKSPACE_MIN_RETENTION_MS },
    ],
  })
  if (!verdict.ok) return { deleted: 0, failed: 0, guard: bulkJobSkipped(verdict.reason) }
  const floor = BULK_JOB_TIME_FLOOR.toISOString()
  const pending = pendingBefore.toISOString()
  const retained = workspaceBefore.toISOString()
  const now = dbNow.toISOString()
  // 系统任务只跨空间发现候选；文件读取与删除在下方通过 scoped 执行。
  // 到期时刻：未确认上传 = 创建 + 1 小时；过期空间 = 删除 + 保留期；废弃产出 = 标记删除时。
  const workspaces = await db.$client<{ workspace_id: string }[]>`
    select f.workspace_id from file f join organization o on o.id=f.workspace_id
    where (f.status='pending' and f.created_at>=${floor} and f.created_at<${pending})
      or (o.deleted_at>=${floor} and o.deleted_at<=${retained})
      or (f.purpose='ai_output' and f.status='ready' and f.deleted_at>=${floor} and f.deleted_at<=${now})
    group by f.workspace_id
    order by min(case
      when o.deleted_at>=${floor} and o.deleted_at<=${retained} then o.deleted_at+${workspaceRetentionMs}*interval '1 millisecond'
      when f.status='pending' then f.created_at+${pendingRetentionMs}*interval '1 millisecond'
      else f.deleted_at end), f.workspace_id
    limit ${workspaceCap}`
  let deleted = 0
  let failed = 0
  let attempted = 0
  const remaining = () => objectCap - attempted
  for (const { workspace_id: workspaceId } of workspaces) {
    if (remaining() <= 0) break
    const tenant = scoped(db, workspaceId)
    // 失败/取消的 ready 产出不会再复活；先删对象再删墓碑，中断后可安全重试。
    const abandoned = await tenant
      .select(file, {
        where: and(
          eq(file.purpose, 'ai_output'),
          eq(file.status, 'ready'),
          gte(file.deletedAt, BULK_JOB_TIME_FLOOR),
          lte(file.deletedAt, dbNow),
        ) as SQL,
      })
      .orderBy(asc(file.deletedAt), asc(file.id))
      .limit(remaining())
    for (const candidate of abandoned) {
      attempted++
      try {
        await bucket.delete(candidate.r2Key)
        const removed = await tenant
          .delete(file, and(eq(file.id, candidate.id), isNotNull(file.deletedAt)))
          .returning({ id: file.id })
        deleted += removed.length
      } catch {
        failed++
        log.warn('storage.cleanup.object_failed', { workspaceId, fileId: candidate.id })
      }
    }
    if (remaining() <= 0) break
    const limit = remaining()
    const result = await db.transaction(async (tx) => {
      // 与上传确认及 restoreWorkspace 共用锁，避免候选读取后文件被确认或空间被恢复。
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`},0))`,
      )
      const [workspace] = await tx
        .select({ deletedAt: organization.deletedAt })
        .from(organization)
        .where(eq(organization.id, workspaceId))
        .for('update')
      if (!workspace) return { deleted: 0, failed: 0, attempted: 0 }
      // 删除时间早于下限的空间视为数据被写坏，不按过期空间清理（已计入区间外告警）
      const expired =
        workspace.deletedAt !== null &&
        workspace.deletedAt.getTime() >= BULK_JOB_TIME_FLOOR.getTime() &&
        workspace.deletedAt.getTime() <= workspaceBefore.getTime()
      const tenant = scoped(tx, workspaceId)
      const files = await tenant
        .select(file, {
          fields: { id: file.id, r2Key: file.r2Key },
          ...(expired
            ? {}
            : {
                where: and(
                  eq(file.status, 'pending'),
                  gte(file.createdAt, BULK_JOB_TIME_FLOOR),
                  lt(file.createdAt, pendingBefore),
                ) as SQL,
              }),
        })
        .orderBy(asc(file.createdAt), asc(file.id))
        .limit(limit)
        .for('update')
      let deleted = 0
      let failed = 0
      for (const candidate of files) {
        try {
          await bucket.delete(candidate.r2Key)
        } catch {
          failed++
          log.warn('storage.cleanup.object_failed', { workspaceId, fileId: candidate.id })
          continue
        }
        // R2 删除幂等；数据库提交失败时仍保留记录，下次可以安全重试。
        await tenant.delete(file, eq(file.id, candidate.id))
        deleted++
      }
      return { deleted, failed, attempted: files.length }
    })
    deleted += result.deleted
    failed += result.failed
    attempted += result.attempted
  }
  return {
    deleted,
    failed,
    guard: bulkJobOutcome({
      processed: attempted,
      cap: objectCap,
      capReached: attempted >= objectCap || workspaces.length >= workspaceCap,
      outOfRange,
    }),
  }
}
