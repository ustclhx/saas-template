// 画廊、作品页与画廊站点地图的服务端文档处理：渲染后统一设置缓存头与状态（page-cache.ts）。
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { studioRequestFailed } from './gallery.server.ts'
import { finishPublicResponse, type StudioPublicRoute } from './page-cache.ts'

export function studioUnavailable(): Response {
  return new Response('Service unavailable', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 页面路由的 GET 处理：插件不可用时 503；渲染完成后读取失败的请求改为 503 且不缓存 */
export async function handleStudioDocument<N>({
  request,
  next,
  route,
}: {
  request: Request
  next: () => N | Promise<N>
  route: StudioPublicRoute
}): Promise<Awaited<N> | Response> {
  const runtime = getWebRuntime()
  if (pluginUnavailable(runtime, 'studio')) return studioUnavailable()
  const ctx = await next()
  const response = (ctx as { response?: Response } | undefined)?.response
  if (!response) return ctx
  return finishPublicResponse({
    request,
    response,
    route,
    failed: studioRequestFailed(request),
    runtime,
  })
}
