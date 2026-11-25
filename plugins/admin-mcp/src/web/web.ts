import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { m } from '@web/paraglide/messages.js'

// admin-mcp 的 web 入口：后台「运营」分组加入 API 令牌页（openspec add-admin-mcp 任务 5.2）
export default {
  adminNav: [{ group: 'operations', to: '/admin/api-tokens', label: m.admin_mcp_title }],
} satisfies WebPluginModule
