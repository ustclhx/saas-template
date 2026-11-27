import type { TemplateConfig } from '@saas/config'
import type { NodeEnv, NodeStorageConfig } from '@saas/config/node'
import { createNodeWorkflow } from '@saas/platform/node'
import type { JobObserver } from '@saas/shared/log'
import { holdSweepers } from '../jobs/hold-sweep.ts'
import { createNodeMediaHandler } from './media.ts'
import { createNodeMediaWorkflowHttpHandler } from './media-http.ts'

function registerWorkflows({
  engine,
  config,
  template,
  observer,
  storage,
}: {
  readonly engine: Parameters<typeof createNodeWorkflow>[0]['engine']
  readonly config: Pick<
    NodeEnv,
    | 'APP_URL'
    | 'FAL_KEY'
    | 'MEDIA_WEBHOOK_SECRET'
    | 'KIE_API_KEY'
    | 'KIE_WEBHOOK_SECRET'
    | 'REPLICATE_API_TOKEN'
    | 'REPLICATE_WEBHOOK_SECRET'
  >
  readonly template: TemplateConfig
  readonly observer: JobObserver
  readonly storage: NodeStorageConfig | undefined
}) {
  const secret = config.MEDIA_WEBHOOK_SECRET
  const workflow =
    template.plugins.media && (template.ai.image || template.ai.video) && storage && secret
      ? createNodeWorkflow({
          engine,
          name: 'ai-media-v1',
          handler: createNodeMediaHandler(engine.database, {
            storage,
            providerEnv: {
              ...(config.FAL_KEY === undefined ? {} : { FAL_KEY: config.FAL_KEY }),
              ...(config.KIE_API_KEY === undefined ? {} : { KIE_API_KEY: config.KIE_API_KEY }),
              ...(config.KIE_WEBHOOK_SECRET === undefined
                ? {}
                : { KIE_WEBHOOK_SECRET: config.KIE_WEBHOOK_SECRET }),
              ...(config.REPLICATE_API_TOKEN === undefined
                ? {}
                : { REPLICATE_API_TOKEN: config.REPLICATE_API_TOKEN }),
              ...(config.REPLICATE_WEBHOOK_SECRET === undefined
                ? {}
                : { REPLICATE_WEBHOOK_SECRET: config.REPLICATE_WEBHOOK_SECRET }),
            },
            callbackOrigin: config.APP_URL,
            callbackSecret: secret,
            template,
            observer,
          }),
        })
      : undefined
  return {
    http: {
      '/internal/workflows/ai-media': createNodeMediaWorkflowHttpHandler({
        workflow: workflow ? { available: true, value: workflow } : { available: false },
        secret: secret ?? '',
      }),
    },
    stopReceiving() {
      workflow?.stopReceiving()
    },
  }
}

export default { holdSweepers, registerWorkflows }
