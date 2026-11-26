import { definePlugin } from '@saas/config'
import { studioConfigSchema } from './src/config.ts'

export default definePlugin({
  id: 'studio',
  targets: ['cloudflare', 'node'],
  requires: { plugins: ['media'], features: ['billing', 'credits'] },
  routes: { dir: 'routes', mount: '' },
  entries: {
    web: 'src/web/web.ts',
    worker: 'src/worker/index.ts',
    webNode: 'src/node/web.ts',
  },
  // 仅在启用跨机房清除时配置，缺失不影响插件可用性。
  secrets: ['CF_PURGE_TOKEN', 'CF_ZONE_ID'],
  messages: 'messages',
  config: studioConfigSchema,
})
