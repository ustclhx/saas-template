// Worker 入口（wrangler.jsonc 的 main）。
// 在交给 TanStack Start 处理之前校验环境变量与绑定，缺失或非法时任何请求都返回 500。
// /admin/** 的请求先经角色守卫，非 admin 与不存在的页面得到相同的 404（features/admin/gate.ts）。
import handler from '@tanstack/react-start/server-entry'
import { gateAdminRequest } from './features/admin/gate.ts'
import { checkEnv } from './server/env.ts'

export default {
  async fetch(request, env) {
    return checkEnv(env) ?? (await handler.fetch(await gateAdminRequest(request, env)))
  },
} satisfies ExportedHandler<Cloudflare.Env>
