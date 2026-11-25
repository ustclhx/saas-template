import { retryDeletionCleanup } from '@saas/auth'
import type { DatabaseAccess, KeyValueStore, QueueProducer } from '@saas/platform'
import { log } from '@saas/shared/log'
import { reportBulkJob } from '../bulk-jobs.ts'

/** 跟随心跳重试已提交的凭据失效；staging reduced profile 的周期为半小时。 */
export async function runDeletionCleanup(context: {
  db: DatabaseAccess
  cache: KeyValueStore
  eventsQueue?: QueueProducer<unknown>
}) {
  const { guard, ...result } = await retryDeletionCleanup(context.db.business(), context.cache)
  log.info('cron.deletion-cleanup', result)
  await reportBulkJob('deletion-cleanup', guard, context.eventsQueue)
  if (result.failed > 0) throw new Error('Credential cache cleanup failed; retry next heartbeat')
}
