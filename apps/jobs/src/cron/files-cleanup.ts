import type { Env } from '@saas/config'
import { createDb } from '@saas/db'
import { log } from '@saas/shared/log'
import { cleanupFiles } from '@saas/storage'

/** 与现有十分钟 Cron 共用触发器，文件清理不依赖计费任务的执行结果。 */
export async function runFilesCleanup(env: Env & { readonly FILES: Pick<R2Bucket, 'delete'> }) {
  const result = await cleanupFiles(createDb(env.HYPERDRIVE), env.FILES)
  log.info('cron.files-cleanup', result)
  if (result.failed > 0) throw new Error('File object cleanup failed; retry next cron')
}
