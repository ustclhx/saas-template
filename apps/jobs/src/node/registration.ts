import type { TemplateConfig } from '@saas/config'
import type { Scheduler } from '@saas/platform'
import { createNodeCronHeartbeat } from '@saas/platform/node'
import templateConfig from '../../../../template.config.ts'
import { registerAiHoldSweepers } from '../ai.ts'
import { runDeletionCleanup } from '../cron/deletion-cleanup.ts'
import { type JobsContext, registerJobsSchedules } from '../handlers.ts'
import { registerPluginHoldSweepers } from '../plugins/register.ts'

/** 任务注册使用明确功能开关，关闭功能不依赖 provider 或赠送数值。 */
export function getNodeJobFeatures(config: TemplateConfig = templateConfig) {
  const billing = config.billing.enabled
  const text = config.ai.text.enabled
  return {
    billing,
    credits: config.credits.enabled,
    text,
  }
}

/** 在 engine.register 内调用；这里只注册 hold 和 Cron，不装配媒体 Workflow。 */
export function registerNodeJobsSchedules(
  scheduler: Scheduler,
  context: JobsContext,
  config: TemplateConfig = templateConfig,
) {
  const features = getNodeJobFeatures(config)
  const disposeAi = registerAiHoldSweepers(features)
  const disposePlugins = registerPluginHoldSweepers(context.plugins ?? [], config)
  const dispose = () => {
    disposeAi()
    disposePlugins()
  }
  registerJobsSchedules(scheduler, context, {
    features,
    skipUnavailableFiles: true,
    heartbeat: createNodeCronHeartbeat(context.db.business(), async () => {
      await runDeletionCleanup(context)
    }),
  })
  return dispose
}
