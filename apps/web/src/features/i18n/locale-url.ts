/**
 * 语言前缀与地址规范化（openspec multilingual-seo design.md 决策 2，ML-01/ML-02）。
 *
 * - 前缀一律为语言 id 的小写形式（`zh-Hant` → `/zh-hant`）；Paraglide 的 urlPatterns 由这里生成。
 * - 大小写不同的前缀与默认语言前缀在进入 Paraglide 前 301 到唯一地址；只看路径，不看任何请求头。
 *
 * vite 配置（scripts/i18n-project.ts、prerender.ts）也引用这里，因此不引用任何运行时模块。
 */

/**
 * 一组语言的地址规则：`defaultLocale` 以无前缀地址服务，其余 `/<小写 id>/…`。
 * 单站点即 `i18n` 本身；多站点项目按站点取 `siteRouting()`，`defaultLocale` 为 null 表示该站点所有语言都带前缀。
 */
export interface LocaleRouting {
  readonly locales: readonly string[]
  readonly defaultLocale: string | null
}

/** `seo.linking.sites[]` 中与地址相关的字段（结构与 @saas/config 的 SeoLinkingSite 一致，这里不引用该包） */
export interface LocaleSite {
  readonly locales: readonly string[]
  readonly hosts?: readonly string[] | undefined
  readonly previewHost?: string | undefined
  readonly defaultLocale?: string | null | undefined
  readonly xDefaultLocales?: readonly string[] | undefined
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
export function localeUrlPatterns({
  locales,
  defaultLocale,
}: {
  readonly locales: readonly string[]
  readonly defaultLocale: string
}) {
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
 * 只处理 `routing.locales` 中的语言：多站点按站点传入时，其他站点语言的前缀原样放行。
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

/** 语言 `locale` 的页面地址：站点默认语言无前缀，其余加小写前缀；`path` 为不带语言前缀的 path */
export function localePath(path: string, locale: string, defaultLocale: string | null): string {
  const clean = path.replace(/\/+$/, '') || '/'
  return locale === defaultLocale ? clean : `/${localePrefix(locale)}${clean === '/' ? '' : clean}`
}

/** 服务 `locale` 的站点；未列入任何分组（含未配置分组）时返回 undefined，即隐含站点 */
export function siteOfLocale<S extends LocaleSite>(
  locale: string,
  sites: readonly S[],
): S | undefined {
  return sites.find((site) => site.locales.includes(locale))
}

/**
 * 站点的地址规则（多站点，openspec multilingual-seo 0.8.1 补充）。`site` 为 undefined 表示未列入分组的语言组成的
 * 隐含站点（未配置分组时即全部语言）。站点默认语言：声明了 `defaultLocale`（含 null）时取声明值，否则站点包含全局
 * 默认语言时为它，否则为 null（所有语言带前缀）。
 */
export function siteRouting(
  site: LocaleSite | undefined,
  i18n: { readonly locales: readonly string[]; readonly defaultLocale: string },
  sites: readonly LocaleSite[] = site ? [site] : [],
): LocaleRouting {
  const locales = site
    ? site.locales.filter((locale) => i18n.locales.includes(locale))
    : i18n.locales.filter((locale) => !siteOfLocale(locale, sites))
  if (site?.defaultLocale !== undefined) return { locales, defaultLocale: site.defaultLocale }
  return {
    locales,
    defaultLocale: locales.includes(i18n.defaultLocale) ? i18n.defaultLocale : null,
  }
}

/**
 * 按请求 Host 选出站点：Host 去掉端口、转小写后与站点的 `hosts` 或 `previewHost` 比较；没有匹配时返回 undefined。
 */
export function siteOfHost<S extends LocaleSite>(host: string, sites: readonly S[]): S | undefined {
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (!name) return undefined
  return sites.find((site) => site.previewHost === name || site.hosts?.includes(name))
}

/**
 * 请求所在站点的地址规则（request.server.ts 在进入 Paraglide 前用它做 301）：Host 匹配到站点时为该站点的规则
 * （siteRouting），未配置分组或没有匹配（staging、未登记的域名）时为全局 `i18n`，与单站点行为相同。
 */
export function requestLocaleRouting(
  url: URL,
  i18n: { readonly locales: readonly string[]; readonly defaultLocale: string },
  sites: readonly LocaleSite[],
): LocaleRouting {
  const site = siteOfHost(url.host, sites)
  return site ? siteRouting(site, i18n, sites) : i18n
}

/**
 * x-default 指向的语言（openspec multilingual-seo 0.8.1 补充）：按 `preference`、站点默认语言、`locales`
 * 的顺序取第一个在 `available`（本页存在的语言版本）中的语言，比较不区分大小写；都不在时取 `available[0]`。
 * 返回 `available` 中的原写法；`available` 为空时返回 undefined。
 */
export function xDefaultLocale(
  available: readonly string[],
  {
    preference = [],
    defaultLocale,
    locales = [],
  }: {
    readonly preference?: readonly string[] | undefined
    readonly defaultLocale?: string | null | undefined
    readonly locales?: readonly string[] | undefined
  },
): string | undefined {
  const order = [...preference, ...(defaultLocale ? [defaultLocale] : []), ...locales]
  for (const wanted of order) {
    const found = available.find((locale) => locale.toLowerCase() === wanted.toLowerCase())
    if (found !== undefined) return found
  }
  return available[0]
}

/**
 * 一页的 x-default 语言：`locale` 为本页语言，用于选出所在站点——站点声明的 `xDefaultLocales` 优先于全局列表，
 * 默认规则先取站点默认语言（siteRouting），再取全局默认语言与 `i18n.locales` 顺序。模板的 hreflang 输出
 * （seo/metadata.ts）与链接图检查（scripts/check-links-graph.mjs）共用这一实现。
 */
export function pageXDefaultLocale(
  available: readonly string[],
  locale: string | undefined,
  i18n: { readonly locales: readonly string[]; readonly defaultLocale: string },
  linking: { readonly sites: readonly LocaleSite[]; readonly xDefaultLocales: readonly string[] },
): string | undefined {
  const site = locale === undefined ? undefined : siteOfLocale(locale, linking.sites)
  const siteDefault =
    locale === undefined ? null : siteRouting(site, i18n, linking.sites).defaultLocale
  return xDefaultLocale(available, {
    preference: site?.xDefaultLocales ?? linking.xDefaultLocales,
    defaultLocale: siteDefault,
    locales: [i18n.defaultLocale, ...i18n.locales],
  })
}
