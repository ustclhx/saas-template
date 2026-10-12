import { cleanupExpiredWorkspaces } from '@saas/auth'
import type { DatabaseAccess } from '@saas/platform'
import { log } from '@saas/shared/log'

/** Daily at 03:00 UTC; independent of the health heartbeat. */
export const WORKSPACE_CLEANUP_CRON = '0 3 * * *'
export async function runWorkspaceCleanup(context: { db: DatabaseAccess }): Promise<void> {
  const result = await cleanupExpiredWorkspaces(context.db.business())
  log.info('cron.workspace-cleanup', result)
}
