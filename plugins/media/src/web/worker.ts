import { createCloudflareWorkflow } from '@saas/platform/cloudflare'
import type { WorkerPluginModule } from '@web/server/cloudflare/plugins.ts'

export default {
  createAiWorkflow(env: Cloudflare.Env & { AI_MEDIA_WORKFLOW?: Workflow<{ taskId: string }> }) {
    const binding = env.AI_MEDIA_WORKFLOW
    return binding
      ? { available: true, value: createCloudflareWorkflow(binding) }
      : { available: false }
  },
} satisfies WorkerPluginModule
