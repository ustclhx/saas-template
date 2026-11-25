import { createServerFn } from '@tanstack/react-start'
import { adminMiddleware } from '@web/features/admin/admin.functions.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { adminMcpConfigSchema } from '../config.ts'
import { tokenTerms } from './api-tokens.ts'
import { listAdminApiTokens } from './tokens.ts'

// 后台 API 令牌页的列表读取。路由 loader 不参与默认代码分割，只导入本文件，
// 避免把创建 / 吊销函数及其输入 schema 带进每个页面的客户端入口包。

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
