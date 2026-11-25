import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { m } from '@web/paraglide/messages.js'
import { countAdminConfirmations } from './confirmations.functions.ts'

// admin-mcp 的 web 入口：后台「运营」分组加入待确认列表（带数量，add-admin-step-up 任务 4.3）
// 与 API 令牌页（openspec add-admin-mcp 任务 5.2）
export default {
  adminNav: [
    {
      group: 'operations',
      to: '/admin/confirmations',
      search: { offset: 0 },
      label: m.admin_confirm_nav,
      order: 90,
      count: () => countAdminConfirmations(),
    },
    { group: 'operations', to: '/admin/api-tokens', label: m.admin_mcp_title },
  ],
} satisfies WebPluginModule
