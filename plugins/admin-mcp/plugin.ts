import { definePlugin } from '@saas/config'
import { adminMcpConfigSchema } from './src/config.ts'

export default definePlugin({
  id: 'admin-mcp',
  targets: ['cloudflare', 'node'],
  routes: { dir: 'routes', mount: '' },
  bindings: { web: [{ name: 'RL_ADMIN_MCP', kind: 'rate_limit' }] },
  config: adminMcpConfigSchema,
})
