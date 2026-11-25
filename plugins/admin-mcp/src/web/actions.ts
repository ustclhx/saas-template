import { defineAdminActions } from '@web/features/admin/actions.registry.ts'

/**
 * admin-mcp 插件登记的后台动作（openspec add-admin-step-up design.md 决策 1 与入口清单）。
 * MCP 写工具复用后台同名动作（如 settings.set → setting.update），见各工具的 `adminAction`。
 */
export const adminMcpActions = defineAdminActions('admin-mcp', {
  'admin.api_token.create': { stepUp: 'always', reason: '产生长期管理员凭据' },
  'admin.api_token.revoke': { stepUp: 'never', reason: '降权动作，泄露时越快吊销越好（D3）' },
  'admin.mcp.call': { stepUp: 'never', reason: '只写调用审计，不改业务数据' },
  'admin.mcp.dry_run': { stepUp: 'never', reason: '写工具的预览，只校验不保存' },
})
