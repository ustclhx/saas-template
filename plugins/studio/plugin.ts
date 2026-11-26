import { definePlugin } from '@saas/config'
import { studioConfigSchema } from './src/config.ts'

export default definePlugin({
  id: 'studio',
  targets: ['cloudflare', 'node'],
  requires: { plugins: ['media'], features: ['billing', 'credits'] },
  entries: {
    web: 'src/web/web.ts',
    worker: 'src/worker/index.ts',
    webNode: 'src/node/web.ts',
  },
  messages: 'messages',
  config: studioConfigSchema,
})
