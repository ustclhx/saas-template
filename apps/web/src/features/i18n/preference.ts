import { cookieName, type Locale } from '../../paraglide/runtime.js'
import { isAppAreaPath } from './app-area.ts'

/** 语言 Cookie 的有效期（秒） */
export const LOCALE_COOKIE_MAX_AGE = 365 * 86400

export function readCookie(cookie: string, name: string): string | undefined {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export function localeCookie(locale: Locale, secure = false, name = cookieName): string {
  return `${name}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
}

/**
 * 手动选择语言时在浏览器端写 Paraglide Cookie，供应用区（按 Cookie 选语言）使用；
 * 公开页只按 URL 显示语言，不读这个 Cookie，服务端也不在公开页 Set-Cookie。
 */
export function rememberLocale(locale: Locale): void {
  const secure = window.location.protocol === 'https:'
  // biome-ignore lint/suspicious/noDocumentCookie: 同步记住选择后立即导航，与 Paraglide 使用同一 Cookie。
  document.cookie = localeCookie(locale, secure)
}

/** Server Functions 复用同源来源页的语言；不接受跨站来源影响本次语言。 */
export function languageUrl(request: Request): URL {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/_serverFn/')) return url
  const referer = request.headers.get('referer')
  if (referer) {
    try {
      const source = new URL(referer)
      if (source.origin === url.origin) return source
    } catch {
      /* 非法外部头忽略，按 Cookie / 默认语言处理 */
    }
  }
  return url
}

export function usesAccountLocale(url: URL): boolean {
  return isAppAreaPath(url.pathname) || url.pathname.startsWith('/_serverFn/')
}
