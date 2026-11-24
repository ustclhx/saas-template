import type { WebNodePluginModule } from '@web/features/plugins/contract.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { createNodeMediaWorkflowClient } from './web-workflow.ts'

export default {
  createAiWorkflow({ env, jobsUrl, storage }) {
    return storage &&
      (templateConfig.ai.image || templateConfig.ai.video) &&
      env.MEDIA_WEBHOOK_SECRET
      ? {
          available: true,
          value: createNodeMediaWorkflowClient({ jobsUrl, secret: env.MEDIA_WEBHOOK_SECRET }),
        }
      : { available: false }
  },
} satisfies WebNodePluginModule
