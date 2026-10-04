import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { notFound, redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { getAuth } from './auth.ts'
import { templateConfig } from './template-config.ts'
import { resolveDefaultWorkspace, resolveWorkspaceBySlug } from './workspace-context.ts'

/**
 * 服务端入口的中间件链（design.md 决策 6）：`withSession → withWorkspace → withEntitlement → handler`。
 * 本文件实现前两个；`withEntitlement` 由计费 change 提供。
 *
 * 用法：在 server function 上 `.middleware([withWorkspace])`，handler 的 `context` 中即有
 * `{ db, user, session, workspace, member }`；`withWorkspace` 已包含 `withSession`。
 */

/** 未登录时跳转的页面（`/login` 由认证页面提供） */
export const LOGIN_PATH = '/login'

/**
 * 读取会话并注入 `{ db, user, session }`；未登录重定向到 `/login`。
 * 会话按三层读取（Cookie 缓存 → KV → 数据库），吊销有「缓存时长 + KV 传播」的延迟，
 * 空间访问权另由 `withWorkspace` 实时查库校验；敏感操作仍须调用 `requireFreshSession`。
 */
export const withSession = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const db = createDb(env.HYPERDRIVE)
  const result = await getAuth(env, db).api.getSession({ headers: getRequest().headers })
  if (!result) throw redirect({ href: LOGIN_PATH })
  return next({ context: { db, user: result.user, session: result.session } })
})

/** server function 的输入来自客户端，按形状校验；是否有权访问由下方查库判断 */
const workspaceInput = z.object({
  /** URL 中的 `$slug`；省略时解析 `/app` 的默认空间（活跃空间 → 个人空间） */
  slug: z.string().min(1).max(64).optional(),
})

/**
 * 解析当前空间并注入 `{ workspace, member }`（docs/04-auth-and-tenancy.md §3「当前空间的解析」）。
 * 成员身份每次请求查库，不使用会话缓存中的空间信息；空间不存在、已删除或不是成员一律 404，
 * 跨空间访问与访问不存在的空间不可区分。
 */
export const withWorkspace = createMiddleware({ type: 'function' })
  .middleware([withSession])
  .validator(workspaceInput)
  .server(async ({ next, data, context }) => {
    const { db, user, session } = context
    const resolved =
      data.slug === undefined
        ? await resolveDefaultWorkspace(db, user, session.activeOrganizationId)
        : await resolveWorkspaceBySlug(db, user.id, data.slug)
    if (!resolved) throw notFound()
    return next({
      context: {
        ...resolved,
        workspaceReadOnly: !templateConfig.tenancy.multiTenant && !resolved.workspace.isPersonal,
      },
    })
  })
