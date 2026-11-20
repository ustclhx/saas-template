/**
 * 语言前缀与地址规范化（openspec multilingual-seo design.md 决策 2，ML-01/ML-02）。
 *
 * - 前缀一律为语言 id 的小写形式（`zh-Hant` → `/zh-hant`）；Paraglide 的 urlPatterns 由这里生成。
 * - 大小写不同的前缀与默认语言前缀在进入 Paraglide 前 301 到唯一地址；只看路径，不看任何请求头。
 *
 * vite 配置（scripts/i18n-project.ts、prerender.ts）也引用这里，因此不引用任何运行时模块。
 */

export interface LocaleRouting {
  readonly locales: readonly string[]
  readonly defaultLocale: string
}

/** 语言在 URL 中的前缀段（不含斜杠） */
export function localePrefix(locale: string): string {
  return locale.toLowerCase()
}

/** 路径首段对应的已配置语言（忽略大小写）；不是语言前缀时返回 undefined */
export function prefixLocale(segment: string, locales: readonly string[]): string | undefined {
  const lower = segment.toLowerCase()
  return lower ? locales.find((locale) => localePrefix(locale) === lower) : undefined
}

const ORIGIN = ':protocol://:domain(.*)::port?'

/**
 * Paraglide 的 urlPatterns：非默认语言 `/<小写 id>/...`，默认语言无前缀。
 * 默认语言的通配规则必须放在最后：Paraglide 按顺序匹配，先匹配到的语言生效。
 * 规则带上 origin 部分（Paraglide 文档的写法）：纯路径规则会走 Paraglide 的快速路径，
 * 该路径不做末尾斜杠规范化，`/` 会被本地化为 `/zh/` 而不是 `/zh`。
 */
export function localeUrlPatterns({ locales, defaultLocale }: LocaleRouting) {
  const seen = new Set<string>()
  for (const locale of locales) {
    if (seen.has(localePrefix(locale)))
      throw new Error(`[i18n] 语言 id 只差大小写，URL 前缀冲突：${locale}`)
    seen.add(localePrefix(locale))
  }
  const prefixed = locales
    .filter((locale) => locale !== defaultLocale)
    .map((locale): [string, string] => [locale, `${ORIGIN}/${localePrefix(locale)}/:path(.*)?`])
  return [
    {
      pattern: `${ORIGIN}/:path(.*)?`,
      localized: [...prefixed, [defaultLocale, `${ORIGIN}/:path(.*)?`] as [string, string]],
    },
  ]
}

/**
 * 地址规范化：返回 301 的目标（路径 + 查询串），已是唯一地址时返回 null。
 * - `/<默认语言>`、`/<默认语言>/...`（任意大小写）→ 无前缀地址；
 * - 其他语言大小写不同的前缀 → 小写前缀。
 */
export function canonicalLocalePath(url: URL, routing: LocaleRouting): string | null {
  const [, first = '', ...rest] = url.pathname.split('/')
  const locale = prefixLocale(first, routing.locales)
  if (!locale) return null
  const tail = rest.join('/')
  let pathname: string
  if (locale === routing.defaultLocale) pathname = `/${tail}`
  else if (first !== localePrefix(locale))
    pathname = `/${localePrefix(locale)}${rest.length ? `/${tail}` : ''}`
  else return null
  return `${pathname}${url.search}`
}

/** 路径规范化的 301 响应；只处理 GET / HEAD，其他方法改为 GET 会丢失请求体 */
export function localeRedirect(request: Request, routing: LocaleRouting): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const location = canonicalLocalePath(new URL(request.url), routing)
  return location === null ? null : new Response(null, { status: 301, headers: { location } })
}
