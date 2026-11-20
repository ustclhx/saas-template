import { type Locale, locales, localizeHref } from '../../paraglide/runtime.js'

/**
 * 本页的语言版本（openspec multilingual-seo 3.2、4.2、4.3）：以本页 `<head>` 中的 hreflang 为准。
 * hreflang 由服务端按页面清单输出（未翻译页不列出，声明了 `SeoPage.alternates` 的本地化 slug 用声明的地址），
 * 语言切换器与语言提示条都只指向这里列出的版本，客户端不需要额外数据。
 */

/** 语言 → pathname，不含 x-default；页面没有 hreflang（应用区、登录页、404 等）时为 null */
export type PageAlternates = ReadonlyMap<string, string> | null

interface LinkLike {
  rel?: unknown
  hrefLang?: unknown
  href?: unknown
}

/**
 * 从路由 head 的 links（各匹配路由 `head().links` 合并后的数组，与 `<HeadContent>` 输出的同一份数据）中
 * 取 hreflang。只取 pathname：hreflang 是 APP_URL 下的绝对地址，切换时在当前 origin 上导航，与本地和预览环境一致。
 * 读路由状态而不是 DOM：服务端渲染与客户端导航后都能立即拿到，不必等 `<head>` 更新。
 */
export function alternatesFromLinks(links: readonly unknown[]): PageAlternates {
  const alternates = new Map<string, string>()
  let found = false
  for (const raw of links) {
    if (!raw || typeof raw !== 'object') continue
    const link = raw as LinkLike
    if (link.rel !== 'alternate' || typeof link.hrefLang !== 'string') continue
    found = true
    if (link.hrefLang === 'x-default' || typeof link.href !== 'string') continue
    try {
      alternates.set(link.hrefLang, new URL(link.href, 'http://localhost').pathname)
    } catch {
      // 非法地址不是模板输出的 hreflang，忽略
    }
  }
  return found ? alternates : null
}

/** 路由匹配列表上的 head links（router-core 中 `links` 的类型为 unknown） */
export function routeLinks(matches: readonly { links?: unknown }[]): unknown[] {
  return matches.flatMap((match) => (Array.isArray(match.links) ? match.links : []))
}

/**
 * 序列化为稳定字符串，供 `useRouterState({ select })` 比较：只有语言版本变化时才重新渲染。
 * 反序列化见 `parseAlternatesKey`。
 */
export function alternatesKey(alternates: PageAlternates): string {
  return alternates ? JSON.stringify([...alternates]) : ''
}

export function parseAlternatesKey(key: string): PageAlternates {
  return key ? new Map(JSON.parse(key) as [string, string][]) : null
}

export interface LanguageOption {
  locale: Locale
  href: string
  current: boolean
}

/**
 * 语言切换器的选项（设计稿方案 A：只列本页真实存在的版本）：
 * - 本页有 hreflang：按配置顺序只列出 hreflang 中的语言，地址取声明的地址；当前语言总在其中；
 * - 应用区（语言来自账号与 Cookie，地址不带语言前缀）：列出全部语言，地址为当前地址，选择后由调用方写 Cookie 再刷新；
 * - 其他没有 hreflang 的页面（登录、404 等）：列出全部语言，同路径加前缀。
 */
export function languageOptions({
  locale,
  pathname,
  alternates,
  appArea,
}: {
  locale: Locale
  pathname: string
  alternates: PageAlternates
  appArea: boolean
}): LanguageOption[] {
  if (appArea)
    return locales.map((value) => ({ locale: value, href: pathname, current: value === locale }))
  if (alternates === null)
    return locales.map((value) => ({
      locale: value,
      href: localizeHref(pathname, { locale: value }),
      current: value === locale,
    }))
  return locales.flatMap((value) => {
    const href = value === locale ? (alternates.get(value) ?? pathname) : alternates.get(value)
    return href === undefined ? [] : [{ locale: value, href, current: value === locale }]
  })
}
