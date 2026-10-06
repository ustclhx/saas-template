// Worker 入口（wrangler.jsonc 的 main）。
// 在交给 TanStack Start 处理之前校验环境变量与绑定，缺失或非法时任何请求都返回 500。
// /admin/** 的请求先经角色守卫，非 admin 与不存在的页面得到相同的 404（features/admin/gate.ts）。
// 之后由 Paraglide 按 URL 前缀 / Cookie 确定本次请求的语言（features/i18n/routing.ts）。
import handler from '@tanstack/react-start/server-entry'
import { gateAdminRequest } from './features/admin/gate.ts'
import { gateLocaleRequest } from './features/i18n/gate.ts'
import { paraglideMiddleware } from './paraglide/server.js'
import { checkEnv } from './server/env.ts'

export default {
  async fetch(request, env) {
    return (
      checkEnv(env) ?? (await localized(gateLocaleRequest(await gateAdminRequest(request, env))))
    )
  },
} satisfies ExportedHandler<Cloudflare.Env>

// 交给 TanStack Start 的仍是原始地址，语言前缀由路由器的 rewrite 去掉（与 SSR 后的客户端一致）
function localized(request: Request): Promise<Response> {
  return paraglideMiddleware(request, () => handler.fetch(request))
}
