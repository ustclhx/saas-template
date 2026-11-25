import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { baseLocale, cookieName, isLocale, type Locale } from '../../paraglide/runtime.js'
import { paraglideMiddleware } from '../../paraglide/server.js'
import type { WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { localeRedirect, requestLocaleRouting } from './locale-url.ts'
import { languageUrl, localeCookie, readCookie, usesAccountLocale } from './preference.ts'
import { readRequestSession, withSessionCache } from './session.server.ts'

/**
 * 中间件内用修改后的 Cookie 决定语言，交给路由器的仍是原地址与原请求头。
 * 进入 Paraglide 前先做地址规范化（locale-url.ts）：默认语言前缀与大小写不同的前缀 301，只看路径。
 * 公开页的语言只由 URL 决定，不读 Accept-Language、IP、UA 或 Cookie，也不写 Cookie。
 */
export function localizeRequest(
  request: Request,
  runtime: Pick<WebRuntime, 'db' | 'auth'>,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  // 单语言构建只使用 baseLocale，不读取账号或 Cookie，也不按 URL 自动跳转。
  if (!templateConfig.i18n.enabled) return paraglideMiddleware(request, next)
  // 多站点按 Host 选出站点（seo.linking.sites[].hosts／previewHost），按站点默认语言规范化；未匹配时按全局 i18n
  const redirect = localeRedirect(
    request,
    requestLocaleRouting(
      new URL(request.url),
      templateConfig.i18n,
      templateConfig.seo.linking.sites,
    ),
  )
  if (redirect) return Promise.resolve(redirect)
  const url = new URL(request.url)
  // 认证端点可能修改会话；不读取、不缓存会话，也不改 Cookie。
  if (url.pathname.startsWith('/api/')) return paraglideMiddleware(request, next)
  const run = request.method === 'GET' ? withSessionCache : <T>(handle: () => T) => handle()
  return run(async () => {
    const source = languageUrl(request)
    let locale: Locale | undefined
    if (usesAccountLocale(source)) {
      try {
        const fresh = await readRequestSession({
          auth: runtime.auth,
          db: runtime.db,
          headers: request.headers,
        })
        locale = isLocale(fresh.user.locale) ? fresh.user.locale : baseLocale
      } catch (error) {
        // 未登录（401/403）按 URL / Cookie 规则；其余错误（数据库不可达等）同样降级为无账号语言，
        // 不能让已登录访客在公开页之间导航时的 server function 失败（public-site-availability）。
        if (!(error instanceof AppError && [401, 403].includes(error.status)))
          log.warn('i18n.account_locale_read_failed', {
            code: error instanceof AppError ? error.code : undefined,
          })
      }
    }
    const headers = new Headers(request.headers)
    if (locale) {
      const cookies = (headers.get('cookie') ?? '')
        .split(';')
        .filter((part) => !part.trim().startsWith(`${cookieName}=`))
      headers.set('cookie', [...cookies, `${cookieName}=${locale}`].join('; '))
    }
    // 此 Request 仅供语言识别；请求体只交给 next 内的原始请求消费。
    const localized = new Request(request.url, { headers, method: request.method })
    const response = await paraglideMiddleware(localized, next, { effectiveRequestUrl: source })
    if (locale) {
      // 账号语言同步给客户端水合；应用区响应不可被共享缓存。
      const result = new Response(response.body, response)
      result.headers.set('cache-control', 'private, no-store')
      if (readCookie(request.headers.get('cookie') ?? '', cookieName) !== locale)
        result.headers.append('set-cookie', localeCookie(locale, url.protocol === 'https:'))
      return result
    }
    return response
  })
}
