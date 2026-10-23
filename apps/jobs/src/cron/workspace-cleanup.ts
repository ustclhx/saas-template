import { cleanupExpiredWorkspaces, purgeDeletedUserAiContent } from '@saas/auth'
import type { DatabaseAccess } from '@saas/platform'
import { log } from '@saas/shared/log'

/** Daily at 03:00 UTC; independent of the health heartbeat. */
export const WORKSPACE_CLEANUP_CRON = '0 3 * * *'
export async function runWorkspaceCleanup(context: { db: DatabaseAccess }): Promise<void> {
  const db = context.db.business()
  const result = await cleanupExpiredWorkspaces(db)
  log.info('cron.workspace-cleanup', result)
  // 删号后团队空间中的 AI 内容不放进删号事务，由这里分批删除，避免长事务持锁。
  const deletedUsers = await purgeDeletedUserAiContent(db)
  log.info('cron.deleted-user-ai-cleanup', deletedUsers)
}
