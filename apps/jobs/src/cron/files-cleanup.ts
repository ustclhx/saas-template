import { type Capability, type DatabaseAccess, requireCapability } from '@saas/platform'
import { log } from '@saas/shared/log'
import { cleanupFiles } from '@saas/storage'

/** 与现有十分钟 Cron 共用触发器，文件清理不依赖计费任务的执行结果。 */
export async function runFilesCleanup(context: {
  db: DatabaseAccess
  files: Capability<{ delete(key: string | string[]): Promise<void> }>
}) {
  const files = requireCapability(context.files, 'files')
  const result = await cleanupFiles(context.db.business(), files)
  log.info('cron.files-cleanup', result)
  if (result.failed > 0) throw new Error('File object cleanup failed; retry next cron')
}
