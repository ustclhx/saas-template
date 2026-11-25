import { definePlugin } from '@saas/config'
import { adminMcpConfigSchema } from './src/config.ts'

export default definePlugin({
  id: 'admin-mcp',
  targets: ['cloudflare', 'node'],
  routes: { dir: 'routes', mount: '' },
  entries: { web: 'src/web/web.ts' },
  bindings: { web: [{ name: 'RL_ADMIN_MCP', kind: 'rate_limit' }] },
  messages: 'messages',
  config: adminMcpConfigSchema,
})
