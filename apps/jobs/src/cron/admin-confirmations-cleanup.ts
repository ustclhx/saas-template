import { cleanupAdminPendingActions } from '@saas/db'
import type { DatabaseAccess, QueueProducer } from '@saas/platform'
import { log } from '@saas/shared/log'
import { reportBulkJob } from '../bulk-jobs.ts'

/**
 * 待确认记录（admin MCP 发起、等待管理员确认）的每日兜底清理，挂在 UTC 03:00 维护触发器上，
 * 不新增定时任务（openspec add-admin-step-up 任务 3.4、Neon 成本基线）。
 */
export async function runAdminConfirmationsCleanup(context: {
  db: DatabaseAccess
  eventsQueue?: QueueProducer<unknown>
}) {
  const { guard, ...result } = await cleanupAdminPendingActions(context.db.business())
  log.info('cron.admin-confirmations-cleanup', result)
  await reportBulkJob('admin-confirmations-cleanup', guard, context.eventsQueue)
}
