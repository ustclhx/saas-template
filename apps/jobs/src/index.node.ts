import { EnvValidationError, loadEnv } from '@saas/config'
import { loadNodeEnv } from '@saas/config/node'
import { log } from '@saas/shared/log'
import { z } from 'zod'
import templateConfig from '../../../template.config.ts'
import { startNodeJobs } from './node/runtime.ts'

try {
  // 配置错误在创建资源/listen 前失败；不输出原始环境或驱动异常。
  const config = loadNodeEnv({ templateConfig })
  const listener = loadEnv(
    { PORT: process.env.PORT, HOST: process.env.HOST },
    z.object({
      PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      HOST: z.string().min(1).default('0.0.0.0'),
    }),
  )
  const runtime = await startNodeJobs(config, { port: listener.PORT, host: listener.HOST })
  log.info('jobs.node.started', { queue: 'unavailable', scheduler: 'unavailable' })
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
