import { restoreWorkspace } from '@saas/auth'
import { getAuth } from '../../server/auth.ts'
import type { WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { withDelegatedAdminAction } from './action.server.ts'
import type { AdminActionContext } from './action.ts'

/** 恢复 API 自管事务：锁定真实管理员 / 会话、owner 与空间，并同时写恢复审计。 */
export function executeAdminWorkspaceRestore(
  context: AdminActionContext,
  options: { headers: Headers; workspaceId: string } & (
    | { runtime: WebRuntime; env?: never }
    | { env: Cloudflare.Env; runtime?: never }
  ),
) {
  return withDelegatedAdminAction(context, (db) =>
    restoreWorkspace({
      db,
      auth: options.runtime ? options.runtime.createAuth(db) : getAuth(options.env, db),
      clientIp: options.runtime ? options.runtime.requestMeta.clientIp : (context.ip ?? null),
      headers: options.headers,
      workspaceId: options.workspaceId,
      maxWorkspacesPerUser: templateConfig.tenancy.maxWorkspacesPerUser,
    }),
  )
}
