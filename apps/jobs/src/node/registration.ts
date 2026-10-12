import type { TemplateConfig } from '@saas/config'
import type { Scheduler } from '@saas/platform'
import { createNodeCronHeartbeat } from '@saas/platform/node'
import templateConfig from '../../../../template.config.ts'
import { registerAiHoldSweepers } from '../ai.ts'
import { runDeletionCleanup } from '../cron/deletion-cleanup.ts'
import { type JobsContext, registerJobsSchedules } from '../handlers.ts'

/** 沿用模板已有开关；免费赠送或 AI 仍需积分维护，不新增配置层。 */
export function getNodeJobFeatures(config: TemplateConfig = templateConfig) {
  const billing = config.billing.providers.length > 0
  const text = config.ai.text
  const media = config.ai.image || config.ai.video
  return {
    billing,
    credits: billing || config.billing.signupBonusCredits > 0 || text || media,
    text,
    media,
  }
}

/** 在 engine.register 内调用；这里只注册 hold 和 Cron，不装配媒体 Workflow。 */
export function registerNodeJobsSchedules(
  scheduler: Scheduler,
  context: JobsContext,
  config: TemplateConfig = templateConfig,
) {
  const features = getNodeJobFeatures(config)
  const dispose = registerAiHoldSweepers(features)
  registerJobsSchedules(scheduler, context, {
    features,
    skipUnavailableFiles: true,
    heartbeat: createNodeCronHeartbeat(context.db.business(), async () => {
      await runDeletionCleanup(context)
    }),
  })
  return dispose
}
