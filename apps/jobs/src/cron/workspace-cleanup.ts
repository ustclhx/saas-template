import { cleanupExpiredWorkspaces } from '@saas/auth'
import type { Env } from '@saas/config'
import { createDb } from '@saas/db'

/** Daily at 03:00 UTC; independent of the health heartbeat. */
export const WORKSPACE_CLEANUP_CRON = '0 3 * * *'
export async function runWorkspaceCleanup(env: Env): Promise<void> {
  const result = await cleanupExpiredWorkspaces(createDb(env.HYPERDRIVE))
  console.log(JSON.stringify({ event: 'cron.workspace-cleanup', ...result }))
}
