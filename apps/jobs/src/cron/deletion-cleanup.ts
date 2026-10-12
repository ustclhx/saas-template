import { retryDeletionCleanup } from '@saas/auth'
import type { DatabaseAccess, KeyValueStore } from '@saas/platform'
import { log } from '@saas/shared/log'

/** Retry committed credential invalidations on the existing five-minute heartbeat. */
export async function runDeletionCleanup(context: { db: DatabaseAccess; cache: KeyValueStore }) {
  const result = await retryDeletionCleanup(context.db.business(), context.cache)
  log.info('cron.deletion-cleanup', result)
  if (result.failed > 0) throw new Error('Credential cache cleanup failed; retry next heartbeat')
}
