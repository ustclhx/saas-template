// 公开画廊、作品页与画廊站点地图的共享缓存规则（design 决策 6）。
// Cloudflare：Worker 前置处理（src/worker/page-cache.ts）先按「地址 + 站点 + 部署版本」查 Cache API，命中直接返回；
// 未命中时登记一次写入，由这里的文档处理在渲染完成后回填。Node 没有 Cache API，只输出相同的 Cache-Control，
// 交给 Caddy / CDN。有会话 Cookie 的请求（页头含用户菜单）与错误页一律不缓存。

import { transferResponseBodyOwnership } from '@tanstack/react-start/server'
import { securityNonce } from '@web/security-context.server.ts'
import { templateConfig } from '@web/server/template-config.ts'

export type StudioPublicRoute = 'gallery' | 'work' | 'sitemap'

/** 画廊与作品页的共享缓存时长（秒）：作品状态变化后其他机房最多 5 分钟后更新 */
export const PUBLIC_PAGE_MAX_AGE = 300
/** 画廊站点地图的共享缓存时长（秒） */
export const SITEMAP_MAX_AGE = 3600
/** 缓存副本记录渲染时的 CSP nonce，命中时换成本次请求的 nonce */
export const CACHED_NONCE_HEADER = 'x-studio-cached-nonce'

declare const __APP_VERSION__: string | undefined
/** 部署版本（构建时注入的提交号）：新部署的静态资源哈希不同，旧 HTML 不能跨版本复用 */
export const DEPLOY_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

const localePrefixes = new Set(
  (templateConfig.i18n.enabled ? templateConfig.i18n.locales : []).map((locale) =>
    locale.toLowerCase(),
  ),
)

/** 公开页地址分类；语言前缀（`/zh/gallery`）同样识别。做同款等其他画廊子路径不缓存。 */
export function studioPublicRoute(
  pathname: string,
  locales: ReadonlySet<string> = localePrefixes,
): StudioPublicRoute | undefined {
  if (/^\/sitemap-gallery(?:-\d+)?\.xml$/.test(pathname)) return 'sitemap'
  const segments = pathname.split('/')
  const first = segments[1]
  const rest =
    first !== undefined && locales.has(first) ? `/${segments.slice(2).join('/')}` : pathname
  if (/^\/gallery\/?$/.test(rest)) return 'gallery'
  if (/^\/gallery\/[^/]+$/.test(rest) && rest !== '/gallery/remix') return 'work'
  return undefined
}

/** Better Auth 的会话 Cookie（含 `__Secure-` 前缀与会话缓存 Cookie） */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false
  return cookieHeader.split(';').some((part) => {
    const name = part.slice(0, part.indexOf('=')).trim()
    return /(?:^|[._-])session_(?:token|data)$/.test(name)
  })
}

/** 只缓存匿名的 GET 请求 */
export function isCacheableRequest(request: Request): boolean {
  return request.method === 'GET' && !hasSessionCookie(request.headers.get('cookie'))
}

/**
 * 缓存键：站点公开地址下保留路径中的「部署版本 + 原路径 + 查询」。站点由地址的 origin 区分，
 * 同一部署内同一站点的同一地址共用一份；作品状态变化时可按作品地址直接算出键。
 */
export function pageCacheKey(url: URL, siteOrigin: string, version = DEPLOY_VERSION): string {
  return `${siteOrigin}/__studio-cache/${encodeURIComponent(version)}${url.pathname}${url.search}`
}

/** 作品页在各语言前缀下的缓存键（状态变化时逐个删除本机房副本） */
export function workPageCacheKeys(siteOrigin: string, slug: string, version = DEPLOY_VERSION) {
  const path = `/gallery/${encodeURIComponent(slug)}`
  return ['', ...Array.from(localePrefixes, (prefix) => `/${prefix}`)].map((prefix) =>
    pageCacheKey(new URL(`${prefix}${path}`, siteOrigin), siteOrigin, version),
  )
}

export function cacheControl(
  route: StudioPublicRoute,
  { anonymous, failed }: { anonymous: boolean; failed: boolean },
): string {
  if (failed) return 'no-store'
  if (!anonymous) return 'private, no-store'
  const age = route === 'sitemap' ? SITEMAP_MAX_AGE : PUBLIC_PAGE_MAX_AGE
  return `public, max-age=0, s-maxage=${age}`
}

type PageCachePut = (response: Response) => void

// 前置处理与路由处理在同一请求的运行时对象内传递写入函数。放在 globalThis 上，Worker 入口与路由分属不同
// 打包块时仍是同一份登记表。
const REGISTRY_KEY = Symbol.for('saas.studio.pageCachePuts')
function registry(): WeakMap<object, PageCachePut> {
  const holder = globalThis as unknown as Record<symbol, WeakMap<object, PageCachePut> | undefined>
  holder[REGISTRY_KEY] ??= new WeakMap()
  return holder[REGISTRY_KEY]
}

/** Worker 前置处理在缓存未命中时登记回填函数 */
export function registerPageCachePut(runtime: object, put: PageCachePut) {
  registry().set(runtime, put)
}

function takePageCachePut(runtime: object): PageCachePut | undefined {
  const put = registry().get(runtime)
  registry().delete(runtime)
  return put
}

/**
 * 渲染完成后统一处理响应头：错误页 503 且不缓存；匿名的 200 / 404 设共享缓存时长，并在登记了回填时
 * 分出一份写入边缘缓存（`tee`，不缓冲整页）。带 Set-Cookie 的响应不进入共享缓存。
 */
export function finishPublicResponse(input: {
  request: Request
  response: Response
  route: StudioPublicRoute
  failed: boolean
  /** 本次请求的运行时对象（前置处理以它为键登记回填） */
  runtime: object | undefined
}): Response {
  const { request, response, route, failed } = input
  const anonymous = isCacheableRequest(request)
  const status = failed ? 503 : response.status
  const headers = new Headers(response.headers)
  headers.set('cache-control', cacheControl(route, { anonymous, failed }))
  if (failed) headers.set('retry-after', '30')
  const put = input.runtime ? takePageCachePut(input.runtime) : undefined
  const cacheable =
    anonymous &&
    !failed &&
    (status === 200 || status === 404) &&
    response.body !== null &&
    !headers.has('set-cookie')
  if (!put || !cacheable || !response.body) {
    return new Response(response.body, { status, statusText: response.statusText, headers })
  }
  const [client, cached] = response.body.tee()
  const cachedHeaders = new Headers(headers)
  const nonce = securityNonce()
  if (nonce) cachedHeaders.set(CACHED_NONCE_HEADER, nonce)
  put(new Response(cached, { status, headers: cachedHeaders }))
  // 新响应的正文直接来自原响应（tee 的一支），声明归属以便框架在中止时一并清理。
  return transferResponseBodyOwnership(
    response,
    new Response(client, { status, statusText: response.statusText, headers }),
  )
}

/** 命中的缓存副本：把渲染时的 nonce 换成本次请求的 nonce，去掉内部头 */
export async function restoreCachedPage(cached: Response, nonce: string | undefined) {
  const headers = new Headers(cached.headers)
  const previous = headers.get(CACHED_NONCE_HEADER)
  headers.delete(CACHED_NONCE_HEADER)
  headers.set('x-studio-cache', 'hit')
  const type = headers.get('content-type') ?? ''
  if (!previous || !nonce || !type.includes('text/html')) {
    return new Response(cached.body, { status: cached.status, headers })
  }
  const html = (await cached.text()).replaceAll(previous, nonce)
  headers.delete('content-length')
  return new Response(html, { status: cached.status, headers })
}
