import { definePlugin, MEDIA_PROVIDER_IDS } from '@saas/config'
import { z } from 'zod'

const workflow = {
  name: 'AI_MEDIA_WORKFLOW',
  kind: 'workflow',
  className: 'AiMediaWorkflow',
} as const
const workersAi = { name: 'AI', kind: 'ai', optional: true } as const

export default definePlugin({
  id: 'media',
  targets: ['cloudflare', 'node'],
  requires: { features: ['billing', 'credits'] },
  routes: { dir: 'routes', mount: '' },
  entries: {
    web: 'src/web/web.ts',
    worker: 'src/web/worker.ts',
    jobs: 'src/jobs/jobs.ts',
    webNode: 'src/node/web.ts',
    jobsNode: 'src/node/jobs.ts',
  },
  bindings: { web: [workflow, workersAi], jobs: [workflow, workersAi] },
  secrets: ['FAL_KEY', 'MEDIA_WEBHOOK_SECRET', 'REPLICATE_API_TOKEN', 'REPLICATE_WEBHOOK_SECRET'],
  messages: 'messages',
  config: z.strictObject({ providers: z.array(z.enum(MEDIA_PROVIDER_IDS)).optional() }),
})
