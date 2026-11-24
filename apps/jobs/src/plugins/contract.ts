import type { PluginBinding } from '@saas/config'
import type { requireEnv } from '../env.ts'
import type {
  createWorkflowSentry,
  sentryEnabled,
  sentryOptions,
  tagJobContext,
} from '../sentry.ts'
import type { JobsPluginModule } from './module.ts'

interface JobsWorkerPluginModule extends JobsPluginModule {
  /** 注入 Worker 启动校验与 Workflow 观测能力，插件不依赖 jobs 应用。 */
  configureWorker?(runtime: {
    requireEnv: typeof requireEnv
    createWorkflowSentry: typeof createWorkflowSentry
    sentryEnabled: typeof sentryEnabled
    sentryOptions: typeof sentryOptions
    tagJobContext: typeof tagJobContext
  }): void
}

export interface JobsPluginRegistration {
  readonly id: string
  readonly entry?: JobsWorkerPluginModule
  readonly bindings: readonly Pick<PluginBinding, 'name' | 'kind' | 'optional'>[]
}
