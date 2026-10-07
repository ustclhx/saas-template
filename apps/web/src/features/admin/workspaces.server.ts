import { restoreWorkspace } from '@saas/auth'
import { getAuth } from '../../server/auth.ts'
import { templateConfig } from '../../server/template-config.ts'
import { withDelegatedAdminAction } from './action.server.ts'
import type { AdminActionContext } from './action.ts'

/** 恢复 API 自管事务：锁定真实管理员 / 会话、owner 与空间，并同时写恢复审计。 */
export function executeAdminWorkspaceRestore(
  context: AdminActionContext,
  options: { env: Cloudflare.Env; headers: Headers; workspaceId: string },
) {
  return withDelegatedAdminAction(context, (db) =>
    restoreWorkspace({
      db,
      auth: getAuth(options.env, db),
      headers: options.headers,
      workspaceId: options.workspaceId,
      maxWorkspacesPerUser: templateConfig.tenancy.maxWorkspacesPerUser,
    }),
  )
}
