import {
  cleanupExpiredWorkspaces,
  purgeDeletedPersonalWorkspaceShareCards,
  purgeDeletedUserAiContent,
} from '@saas/auth'
import type { DatabaseAccess, KeyValueStore, QueueProducer } from '@saas/platform'
import { log } from '@saas/shared/log'
import { createShareCardInvalidator, type ShareCardObjects } from '@saas/storage'
import { reportBulkJob } from '../bulk-jobs.ts'

/** Daily at 03:00 UTC; independent of the health heartbeat. */
export const WORKSPACE_CLEANUP_CRON = '0 3 * * *'
export async function runWorkspaceCleanup(context: {
  db: DatabaseAccess
  cache: KeyValueStore
  shareCardCache?: KeyValueStore
  shareCards?: ShareCardObjects
  eventsQueue?: QueueProducer<unknown>
}): Promise<void> {
  const db = context.db.business()
  const invalidator = context.shareCards
    ? createShareCardInvalidator(context.shareCards, context.shareCardCache ?? context.cache)
    : undefined
  try {
    if (invalidator) {
      const { guard } = await purgeDeletedPersonalWorkspaceShareCards(
        db,
        invalidator.cleanupWorkspaceShareCards,
      )
      await reportBulkJob('personal-share-cards-cleanup', guard, context.eventsQueue)
    }
  } catch {
    log.error('cron.personal-share-cards-cleanup.failed')
  }
  try {
    const { guard, ...result } = await cleanupExpiredWorkspaces(db, {
      ...(invalidator && { cleanupShareCards: invalidator.cleanupWorkspaceShareCards }),
    })
    log.info('cron.workspace-cleanup', result)
    await reportBulkJob('workspace-cleanup', guard, context.eventsQueue)
  } catch {
    log.error('cron.workspace-cleanup.failed')
  }
  // 删号后团队空间中的 AI 内容不放进删号事务，由这里分批删除，避免长事务持锁。
  try {
    const { guard, ...deletedUsers } = await purgeDeletedUserAiContent(db)
    log.info('cron.deleted-user-ai-cleanup', deletedUsers)
    await reportBulkJob('deleted-user-ai-cleanup', guard, context.eventsQueue)
  } catch {
    log.error('cron.deleted-user-ai-cleanup.failed')
  }
}
