import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { createServerFn } from '@tanstack/react-start'
import { adminAction } from '@web/features/admin/action.server.ts'
import { adminMiddleware } from '@web/features/admin/admin.functions.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { z } from 'zod'
import { adminMcpConfigSchema } from '../config.ts'
import { adminMcpActions } from './actions.ts'
import { TOKEN_NAME_MAX, tokenTerms } from './api-tokens.ts'
import { createAdminApiToken, listAdminApiTokens, revokeAdminApiToken } from './tokens.ts'

// 后台 API 令牌页（openspec add-admin-mcp 任务 5.2）。只操作当前管理员自己的令牌；
// 创建与吊销经 adminAction 在同一事务写审计，meta 不含令牌值与哈希。完整令牌只出现在创建响应中。

const DAY_MS = 86_400_000

function maxTokenDays() {
  return adminMcpConfigSchema.parse(templateConfig.plugins['admin-mcp'] ?? {}).maxTokenDays
}

export const getAdminApiTokens = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    const tokens = await listAdminApiTokens(context.db, context.admin.id)
    return {
      tokens,
      endpoint: new URL('/api/admin/mcp', getWebRuntime().config.APP_URL).toString(),
      terms: tokenTerms(maxTokenDays()),
      // 相对时间以服务端时间为准，SSR 与水合输出一致
      now: new Date(),
    }
  })

const createInput = z.object({
  name: z.string().trim().min(1).max(TOKEN_NAME_MAX),
  write: z.boolean(),
  days: z.int().min(1).max(365),
})

export const createAdminApiTokenFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(createInput)
  .handler(
    adminAction(adminMcpActions['admin.api_token.create'], async ({ tx, admin, audit, data }) => {
      if (!tokenTerms(maxTokenDays()).includes(data.days))
        throw new AppError(
          'ADMIN_API_TOKEN_INVALID',
          'Token expiration is outside the allowed range',
        )
      const { token, metadata } = await createAdminApiToken(tx, admin.id, {
        name: data.name,
        scopes: data.write ? ['admin:read', 'admin:write'] : ['admin:read'],
        expiresAt: new Date(Date.now() + data.days * DAY_MS),
      })
      await audit({
        action: 'admin.api_token.create',
        targetType: 'admin_api_token',
        targetId: metadata.id,
        meta: {
          name: metadata.name,
          prefix: metadata.prefix,
          scopes: metadata.scopes,
          expiresAt: metadata.expiresAt.toISOString(),
        },
      })
      log.info('admin.api_token_created', { actorUserId: admin.id, tokenId: metadata.id })
      return { token, metadata }
    }),
  )

export const revokeAdminApiTokenFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.uuid() }))
  .handler(
    adminAction(adminMcpActions['admin.api_token.revoke'], async ({ tx, admin, audit, data }) => {
      // 不属于本人、不存在或已吊销都按未找到处理，不泄露他人令牌是否存在
      if (!(await revokeAdminApiToken(tx, admin.id, data.id)))
        throw new AppError('ADMIN_API_TOKEN_NOT_FOUND', 'Token not found', { status: 404 })
      await audit({
        action: 'admin.api_token.revoke',
        targetType: 'admin_api_token',
        targetId: data.id,
        meta: {},
      })
      log.info('admin.api_token_revoked', { actorUserId: admin.id, tokenId: data.id })
      return { ok: true as const }
    }),
  )
