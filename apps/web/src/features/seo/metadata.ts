import type { AnyRouteMatch } from '@tanstack/react-router'
import { templateConfig } from '../../server/template-config.ts'
import { isAppAreaPath } from '../i18n/app-area.ts'
import { homePageCopy } from './home-copy.ts'

/**
 * 公开页面清单的一项（openspec seo-internal-linking design 决策 1）。地址类字段（`path`、`parent`、
 * `group`、`related`）都是不带语言前缀的 path，按本页的 `locale` 解析。
 */
export interface SeoPage {
  path: string
  title: string
  description: string
  locale: string
  cover?: string | undefined
  date?: string | undefined
  /** 上级页面；除首页外每个可索引页面都必须声明，且指向存在的可索引页面 */
  parent?: string | undefined
  /** 主词：模板内链区块与面包屑的锚文本；内容集合默认取 title */
  titleMain?: string | undefined
  /** 锚文本的短变体（只允许一个） */
  anchorShort?: string | undefined
  /** 同级分组的地址（该分组的列表页），同组页面互为同级 */
  group?: string | undefined
  /** 相关页地址 */
  related?: readonly string[] | undefined
  /** 默认 true；false 时输出 noindex、不进站点地图，也不能作为 parent／group／related 的目标 */
  indexable?: boolean | undefined
  /** `'money'` 表示钱页，链接图检查统计其站内入链 */
  priority?: 'money' | undefined
  /** 内容的真实语言；与 `locale` 不同表示缺少译文、以该语言内容回退显示的页面 */
  sourceLocale?: string | undefined
  /**
   * 各语言版本的地址（语言 → 不带语言前缀的 path），用于各语言路径不同的页面（本地化 slug，
   * openspec multilingual-seo 决策 4）。声明后 hreflang 与语言切换器只用这些地址（自身总在其中）；
   * 每个语言版本都要出现在清单中并声明同一组地址，构建期校验（linking.ts）。未声明时按同路径加前缀关联。
   */
  alternates?: Readonly<Record<string, string>> | undefined
}

/** 页面声明的完整语言版本组（含自身）；未声明 `alternates` 时返回 undefined */
export function pageAlternates(
  page: Pick<SeoPage, 'path' | 'locale' | 'alternates'>,
): Record<string, string> | undefined {
  return page.alternates ? { ...page.alternates, [page.locale]: page.path } : undefined
}

/**
 * 两种语言是否由同一站点（同一 origin）服务：按 `seo.linking.sites` 分组，未列入任何分组的语言同属一个隐含站点；
 * 未配置分组（模板默认）时全部语言同站。
 */
export function sameSiteLocales(
  a: string,
  b: string,
  sites: readonly { readonly locales: readonly string[] }[] = templateConfig.seo.linking.sites,
): boolean {
  const site = (locale: string) => sites.findIndex((entry) => entry.locales.includes(locale))
  return site(a) === site(b)
}

/**
 * 回退页的原语言：内容语言与页面语言不同、且原语言由同一站点服务时返回原语言。原语言在另一站点时返回
 * undefined——按普通页面处理（自指 canonical、进站点地图），不输出跨站 canonical。
 */
export function fallbackSourceLocale(
  page: Pick<SeoPage, 'locale' | 'sourceLocale'>,
  sites?: readonly { readonly locales: readonly string[] }[],
): string | undefined {
  const { locale, sourceLocale } = page
  return sourceLocale !== undefined &&
    sourceLocale !== locale &&
    sameSiteLocales(locale, sourceLocale, sites)
    ? sourceLocale
    : undefined
}

/** 缺少译文、以同站点其他语言内容回退显示的页面：canonical 指向原语言，不进站点地图 */
export function isFallbackPage(page: Pick<SeoPage, 'locale' | 'sourceLocale'>): boolean {
  return fallbackSourceLocale(page) !== undefined
}

/** 进入站点地图的页面：可索引且不是回退页 */
export function indexedPages<T extends SeoPage>(pages: readonly T[]): T[] {
  return pages.filter((page) => page.indexable !== false && !isFallbackPage(page))
}

const { defaultLocale, enabled } = templateConfig.i18n
const locales = enabled ? templateConfig.i18n.locales : [defaultLocale]
export function localizedPath(path: string, locale: string): string {
  const clean = path.replace(/\/+$/, '') || '/'
  return !enabled || locale === defaultLocale ? clean : `/${locale}${clean === '/' ? '' : clean}`
}

export function absoluteUrl(appUrl: string, path: string): string {
  return new URL(path, appUrl).href
}

/**
 * hreflang 关联：`languages` 为该页真实存在译文的语言（回退页不算），各语言按同路径加前缀。
 * 传入 `alternates`（`pageAlternates()` 的结果）时改用声明的各语言地址，`languages` 不再参与。
 * x-default 指向默认语言版本，默认语言没有该页时指向按配置顺序存在的第一种语言。
 */
export function alternateLinks(
  appUrl: string,
  path: string,
  languages: readonly string[] = locales,
  alternates?: Readonly<Record<string, string>>,
) {
  const real = alternates
    ? locales.filter((locale) => alternates[locale] !== undefined)
    : locales.filter((locale) => languages.includes(locale))
  const fallback = real.includes(defaultLocale) ? defaultLocale : (real[0] ?? defaultLocale)
  const href = (locale: string) =>
    absoluteUrl(appUrl, localizedPath(alternates?.[locale] ?? path, locale))
  return [...real, 'x-default'].map((language) => ({
    rel: 'alternate',
    hrefLang: language,
    href: href(language === 'x-default' ? fallback : language),
  }))
}

export function staticPage(path: string, locale: string): SeoPage {
  const zh = locale === 'zh'
  const copy: Record<string, [string, string]> = {
    '/': homePageCopy(locale),
    '/pricing': zh
      ? ['定价与套餐', '比较订阅套餐与积分包，选择适合你的 AI 工作空间。']
      : ['Pricing and plans', 'Compare subscriptions and credit packs for your AI workspace.'],
    '/blog': zh
      ? ['博客', '阅读产品更新、实践指南与创作技巧。']
      : ['Blog', 'Product updates, practical guides and creation tips.'],
    '/guides': zh
      ? ['指南', '常见问题的简明答案。']
      : ['Guides', 'Short answers to common questions.'],
    '/docs': zh
      ? ['文档', '查阅工作空间的入门、配置和内容指南。']
      : ['Documentation', 'Getting started, configuration and content guides for your workspace.'],
    '/newsletter': zh
      ? ['订阅通讯', '订阅邮件通讯，获取最新产品消息。']
      : ['Newsletter', 'Subscribe to receive the latest product news.'],
    '/waitlist': zh
      ? ['加入候补名单', '登记候补名单，第一时间收到产品开放通知。']
      : ['Join the waitlist', 'Join the waitlist to hear when the product is ready.'],
  }
  const [title, description] = copy[path] ?? [path, path]
  // 层级与主词：主词是面包屑和内链区块的锚文本，取频道名而不是 SEO 标题
  const main: Record<string, [string, string]> = {
    '/': [templateConfig.app.name, zh ? '首页' : 'Home'],
    '/pricing': [zh ? '定价' : 'Pricing', zh ? '定价' : 'Pricing'],
    '/blog': [zh ? '博客' : 'Blog', zh ? '博客' : 'Blog'],
    '/guides': [zh ? '指南' : 'Guides', zh ? '指南' : 'Guides'],
    '/docs': [zh ? '文档' : 'Documentation', zh ? '文档' : 'Docs'],
    '/newsletter': [zh ? '订阅通讯' : 'Newsletter', zh ? '通讯' : 'Newsletter'],
    '/waitlist': [zh ? '候补名单' : 'Waitlist', zh ? '候补' : 'Waitlist'],
  }
  const [titleMain, anchorShort] = main[path] ?? [title, undefined]
  return {
    path,
    title,
    description,
    locale,
    titleMain,
    ...(anchorShort !== undefined && anchorShort !== titleMain && { anchorShort }),
    ...(path !== '/' && { parent: '/' }),
  }
}

export function privateMeta(path: string) {
  return isAppAreaPath(path) ? [{ name: 'robots', content: 'noindex, nofollow' }] : []
}

/** URL 由根 loader 读取运行时 APP_URL，下发客户端后也用于路由切换。 */
export function originFromMatches(
  matches: readonly Pick<AnyRouteMatch, 'loaderData' | 'routeId'>[],
): string {
  const root = matches.find((match) => match.routeId === '__root__')
  if (!root) throw new Error('Root SEO origin is unavailable')
  return (root.loaderData as { appUrl: string }).appUrl
}

export function ogImagePath(page: Pick<SeoPage, 'path' | 'locale'>): string {
  return `/og/${page.locale}${page.path === '/' ? '/index' : page.path}.png`
}

/**
 * `languages`：该页真实存在译文的语言，省略时为全部启用语言（模板静态页各语言都有译文）；
 * 页面声明了 `alternates` 时 hreflang 改用声明的地址。
 * canonical 一律指向自身，只有 `'fallback'` 模式下的回退页（`sourceLocale` 与 `locale` 不同且同站点）
 * 的 canonical 与 og:url 指向原语言地址（`'hide'` 模式下回退页不发布，构建期校验拒绝）。
 */
export function pageHead(
  page: SeoPage,
  appUrl: string,
  structuredData: readonly unknown[] = [],
  languages: readonly string[] = locales,
) {
  const url = absoluteUrl(
    appUrl,
    localizedPath(page.path, fallbackSourceLocale(page) ?? page.locale),
  )
  const title = `${page.title} | ${templateConfig.app.name}`
  const image = page.cover
    ? absoluteUrl(appUrl, page.cover)
    : absoluteUrl(appUrl, ogImagePath(page))
  return {
    meta: [
      { title },
      { name: 'description', content: page.description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: page.description },
      { property: 'og:url', content: url },
      { property: 'og:site_name', content: templateConfig.app.name },
      { property: 'og:type', content: page.date ? 'article' : 'website' },
      { property: 'og:locale', content: page.locale },
      { property: 'og:image', content: image },
      { property: 'og:image:alt', content: title },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: page.description },
      { name: 'twitter:image', content: image },
      { name: 'twitter:image:alt', content: title },
    ],
    links: [
      { rel: 'canonical', href: url },
      ...alternateLinks(appUrl, page.path, languages, pageAlternates(page)),
    ],
    scripts: structuredData.map((data) => ({
      type: 'application/ld+json',
      children: JSON.stringify(data).replace(/</g, '\\u003c'),
    })),
  }
}
