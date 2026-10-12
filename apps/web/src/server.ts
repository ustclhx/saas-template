// Worker 入口（wrangler.jsonc 的 main）。
// 在交给 TanStack Start 处理之前校验环境变量与绑定，缺失或非法时任何请求都返回 500。
// /admin/** 的请求先经角色守卫，非 admin 与不存在的页面得到相同的 404（features/admin/gate.ts）。
// 之后由 Paraglide 按 URL 前缀 / Cookie 确定本次请求的语言（features/i18n/routing.ts）。
// 每个请求先建立日志上下文（新生成的 UUIDv7 请求 ID，附 Cloudflare 的 cf-ray 便于对照平台日志），
// 结束时输出一行 `http.request`（@saas/shared/log）。
import { AppError } from '@saas/shared'
import { log, newRequestId, withLogContext } from '@saas/shared/log'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { gateAdminRequest } from './features/admin/gate.ts'
import {
  gatePublicApiRequest,
  isPublicApiPath,
  normalizePublicApiNotFound,
} from './features/api-keys/gate.ts'
import { gateLocaleRequest } from './features/i18n/gate.ts'
import { localizeRequest } from './features/i18n/request.server.ts'
import { checkEnv } from './server/env.ts'
import { captureServerError, instrumentWeb } from './server/sentry.ts'
import { SENTRY_TEST_PATH, sentryTest } from './server/sentry-test.ts'
import { templateConfig } from './server/template-config.ts'

// Router 的 loader 错误已经转换为 SSR 匹配状态，不会再从 fetch 抛出。
const startHandler = createStartHandler((context) => {
  for (const match of context.router.stores.matches.get()) {
    if (match.status === 'error') captureServerError(match.error)
  }
  return defaultStreamHandler(context)
})

const worker = instrumentWeb({
  fetch(request, env) {
    const invalid = checkEnv(env)
    if (invalid) return Promise.resolve(invalid)
    if (new URL(request.url).pathname === SENTRY_TEST_PATH) return sentryTest(request, env)
    return logged(
      request,
      async () =>
        gatePublicApiRequest(request, templateConfig) ??
        (await localized(gateLocaleRequest(await gateAdminRequest(request, env)), env)),
    )
  },
} satisfies ExportedHandler<Cloudflare.Env>)

export default {
  fetch(request, env, ctx) {
    // 不信任入站的 x-request-id：可被客户端伪造，且会混入他人的检索结果
    const context = { requestId: newRequestId(), cfRay: request.headers.get('cf-ray') ?? undefined }
    return withLogContext(context, async () => {
      try {
        const response = await worker.fetch(request, env, ctx)
        // 重定向与静态响应的 headers 可能只读，复制后再附请求 ID。
        const headers = new Headers(response.headers)
        headers.set('x-request-id', context.requestId)
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      } catch (error) {
        // 包装器已经捕获异常；返回无敏感细节的响应与请求 ID，便于管理员验收定位。
        log.error('http.unhandled', { error })
        if (error instanceof AppError)
          return Response.json(error.toJSON(), {
            status: error.status,
            headers: { 'x-request-id': context.requestId },
          })
        return new Response('Internal Server Error', {
          status: 500,
          headers: { 'x-request-id': context.requestId },
        })
      }
    })
  },
} satisfies ExportedHandler<Cloudflare.Env>

// 只记录方法与路径：查询串可能带令牌（魔法链接、重置密码等）
async function logged(request: Request, handle: () => Promise<Response>): Promise<Response> {
  const started = Date.now()
  const { method } = request
  const path = new URL(request.url).pathname
  try {
    const handled = await handle()
    const response = isPublicApiPath(path) ? await normalizePublicApiNotFound(handled) : handled
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
      status: error instanceof AppError ? error.status : 500,
      durationMs: Date.now() - started,
      error,
    })
    throw error
  }
}

// 交给 TanStack Start 的仍是原始地址，语言前缀由路由器的 rewrite 去掉（与 SSR 后的客户端一致）
function localized(request: Request, env: Cloudflare.Env): Promise<Response> {
  return localizeRequest(request, env, () => startHandler(request))
}
