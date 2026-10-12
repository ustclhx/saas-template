import { EnvValidationError, loadEnv } from '@saas/config'
import { loadNodeEnv } from '@saas/config/node'
import { log } from '@saas/shared/log'
import { z } from 'zod'
import templateConfig from '../../../template.config.ts'
import { startNodeJobs } from './node/runtime.ts'

declare const __APP_VERSION__: string

try {
  // 配置错误在创建资源/listen 前失败；不输出原始环境或驱动异常。
  const config = loadNodeEnv({ templateConfig })
  const listener = loadEnv(
    { ...process.env },
    z.object({
      PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      HOST: z.string().min(1).default('0.0.0.0'),
      JOB_EXECUTOR_ID: z.string().min(1).default('jobs-1'),
      JOB_OWNERSHIP_DIRECTORY: z.string().min(1).default('.data/job-owners'),
      JOB_NATIVE_POOL_MAX: z.coerce.number().int().min(3).max(100).default(4),
    }),
  )
  const runtime = await startNodeJobs(config, {
    port: listener.PORT,
    host: listener.HOST,
    executorId: listener.JOB_EXECUTOR_ID,
    ownershipDirectory: listener.JOB_OWNERSHIP_DIRECTORY,
    nativePoolMax: listener.JOB_NATIVE_POOL_MAX,
    applicationVersion: __APP_VERSION__,
  })
  log.info('jobs.node.started', { version: __APP_VERSION__ })
  const stop = () => {
    void runtime.shutdown().then(
      (result) => process.exit(result.completed && result.resourcesClosed ? 0 : 1),
      () => {
        log.error('jobs.node.shutdown_failed')
        process.exit(1)
      },
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
} catch (error) {
  log.error(
    'jobs.node.start_failed',
    error instanceof EnvValidationError ? { missing: error.missing, invalid: error.invalid } : {},
  )
  process.exit(1)
}
