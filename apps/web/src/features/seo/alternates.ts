import type { UntranslatedMode } from '@saas/config'
import { type Locale, localizeHref, localizeUrl } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'

/**
 * 语言切换的目标地址（openspec multilingual-seo 3.2）：以本页 `<head>` 中的 hreflang 为准，
 * 这样声明了 `SeoPage.alternates` 的本地化 slug 页面与只有部分译文的页面都跳到真实存在的版本。
 * hreflang 由服务端按页面清单输出，客户端不需要额外数据。
 */

/**
 * 本页 hreflang 声明的各语言地址（语言 → pathname，不含 x-default）；页面没有 hreflang（应用区、404 等）时返回 null。
 * 只取 pathname：hreflang 是 APP_URL 下的绝对地址，切换时在当前 origin 上导航，与本地和预览环境一致。
 */
export function documentAlternates(
  root: Pick<ParentNode, 'querySelectorAll'> = document,
): Map<string, string> | null {
  const links = root.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]')
  const alternates = new Map<string, string>()
  for (const link of links) {
    const language = link.getAttribute('hreflang')
    const href = link.getAttribute('href')
    if (!language || !href || language === 'x-default') continue
    try {
      alternates.set(language, new URL(href).pathname)
    } catch {
      // 相对或非法地址不是模板输出的 hreflang，忽略
    }
  }
  return links.length === 0 ? null : alternates
}

/**
 * 切换到 `locale` 的目标地址：
 * - 本页 hreflang 列出了该语言：跳到声明的地址（保留查询参数与锚点）；
 * - 本页有 hreflang 但不含该语言（没有该语言版本）：`'hide'` 下跳到该语言首页（同路径加前缀会是 404），
 *   `'fallback'` 下沿用同路径加前缀，打开回退页；
 * - 本页没有 hreflang：同路径加前缀。
 */
export function localeSwitchHref(
  currentHref: string,
  locale: Locale,
  alternates: ReadonlyMap<string, string> | null,
  untranslated: UntranslatedMode = templateConfig.i18n.untranslated,
): string {
  const current = new URL(currentHref)
  const declared = alternates?.get(locale)
  if (declared !== undefined) {
    const target = new URL(declared, current)
    target.search = current.search
    target.hash = current.hash
    return target.href
  }
  if (alternates !== null && untranslated === 'hide')
    return new URL(localizeHref('/', { locale }), current).href
  return localizeUrl(current, { locale }).href
}
