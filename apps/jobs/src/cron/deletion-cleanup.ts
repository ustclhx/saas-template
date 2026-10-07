import { type KvStore, retryDeletionCleanup } from '@saas/auth'
import type { Env } from '@saas/config'
import { createDb } from '@saas/db'
import { log } from '@saas/shared/log'

/** Retry committed credential invalidations on the existing five-minute heartbeat. */
export async function runDeletionCleanup(env: Env & { readonly CACHE: KvStore }) {
  const result = await retryDeletionCleanup(createDb(env.HYPERDRIVE), env.CACHE)
  log.info('cron.deletion-cleanup', result)
  if (result.failed > 0) throw new Error('Credential cache cleanup failed; retry next heartbeat')
}
