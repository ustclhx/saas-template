import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getAuth } from '../../server/auth.ts'
import { fileWorkspaceInput, requireFileWorkspace } from './access.ts'

// 以 workspaceId 定位文件空间；普通页面的 withWorkspace 使用 slug，且未登录会跳转。
// 中间件声明供 RPC 客户端使用；权限与环境读取留在 .server 回调，由 Start 从浏览器产物剥离。
export const withFileWorkspace = createMiddleware({ type: 'function' })
  .validator(fileWorkspaceInput.loose())
  .server(async ({ data, next }) => {
    const db = createDb(env.HYPERDRIVE)
    const resolved = await requireFileWorkspace({
      db,
      auth: getAuth(env, db),
      headers: getRequest().headers,
      workspaceId: data.workspaceId,
    })
    return next({ context: { db, ...resolved } })
  })
