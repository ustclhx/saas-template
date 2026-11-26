// 公开画廊页面的 Worker 前置处理（design 决策 6）：插件绑定缺失时这些地址返回 503；
// 匿名 GET 先查本机房 Cache API，命中直接返回（不进入 SSR、不查库），未命中时登记回填并交给后续处理。
import { securityNonce } from '@web/security-context.server.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import {
  isCacheableRequest,
  pageCacheKey,
  registerPageCachePut,
  restoreCachedPage,
  studioPublicRoute,
  workPageCacheKeys,
} from '../web/gallery/page-cache.ts'
import { studioPublicOrigin, studioPublicSite } from '../web/gallery/site.server.ts'
import type { StudioWorkAddress } from '../web/work-invalidation.ts'

export async function studioPublicPagesFetch(
  request: Request,
  cache: Cache,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | undefined> {
  const url = new URL(request.url)
  const route = studioPublicRoute(url.pathname)
  if (!route) return undefined
  const runtime = getWebRuntime()
  if (pluginUnavailable(runtime, 'studio'))
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  const site = studioPublicSite(url)
  if (!site || !isCacheableRequest(request)) return undefined
  const key = pageCacheKey(url, site.origin)
  const cached = await cache.match(key)
  if (cached) return restoreCachedPage(cached, securityNonce())
  registerPageCachePut(runtime, (response) => ctx.waitUntil(cache.put(key, response)))
  return undefined
}

/** 作品状态变化后删除本机房的作品页副本；其他机房按 s-maxage 最多 5 分钟后更新 */
export async function deleteStudioWorkPageCache(
  cache: Pick<Cache, 'delete'>,
  work: Pick<StudioWorkAddress, 'site' | 'slug'>,
): Promise<void> {
  const origin = studioPublicOrigin(work.site)
  if (!origin) return
  await Promise.all(workPageCacheKeys(origin, work.slug).map((key) => cache.delete(key)))
}
