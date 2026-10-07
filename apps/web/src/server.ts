// Worker 入口（wrangler.jsonc 的 main）。
// 在交给 TanStack Start 处理之前校验环境变量与绑定，缺失或非法时任何请求都返回 500。
// /admin/** 的请求先经角色守卫，非 admin 与不存在的页面得到相同的 404（features/admin/gate.ts）。
// 之后由 Paraglide 按 URL 前缀 / Cookie 确定本次请求的语言（features/i18n/routing.ts）。
// 每个请求先建立日志上下文（新生成的 UUIDv7 请求 ID，附 Cloudflare 的 cf-ray 便于对照平台日志），
// 结束时输出一行 `http.request`（@saas/shared/log）。
import { log, newRequestId, withLogContext } from '@saas/shared/log'
import handler from '@tanstack/react-start/server-entry'
import { gateAdminRequest } from './features/admin/gate.ts'
import { gateLocaleRequest } from './features/i18n/gate.ts'
import { localizeRequest } from './features/i18n/request.server.ts'
import { checkEnv } from './server/env.ts'

export default {
  fetch(request, env) {
    // 不信任入站的 x-request-id：可被客户端伪造，且会混入他人的检索结果
    const context = { requestId: newRequestId(), cfRay: request.headers.get('cf-ray') ?? undefined }
    return withLogContext(context, () =>
      logged(
        request,
        async () =>
          checkEnv(env) ??
          (await localized(gateLocaleRequest(await gateAdminRequest(request, env)), env)),
      ),
    )
  },
} satisfies ExportedHandler<Cloudflare.Env>

// 只记录方法与路径：查询串可能带令牌（魔法链接、重置密码等）
async function logged(request: Request, handle: () => Promise<Response>): Promise<Response> {
  const started = Date.now()
  const { method } = request
  const path = new URL(request.url).pathname
  try {
    const response = await handle()
    log.info('http.request', {
      method,
      path,
      status: response.status,
      durationMs: Date.now() - started,
    })
    return response
  } catch (error) {
    log.error('http.request', {
      method,
      path,
      status: 500,
      durationMs: Date.now() - started,
      error,
    })
    throw error
  }
}

// 交给 TanStack Start 的仍是原始地址，语言前缀由路由器的 rewrite 去掉（与 SSR 后的客户端一致）
function localized(request: Request, env: Cloudflare.Env): Promise<Response> {
  return localizeRequest(request, env, () => handler.fetch(request))
}
